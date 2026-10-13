// src/domain/health/service.ts
//
// HealthService — the application-layer façade for link health.
// Wires the adapter (BrowserBookmarksAdapter), the Dexie read of
// bookmark rows, the FetchClient, the Classifier, and the
// TaskScheduler into a single API that the background router can
// call. This mirrors the PlanService pattern from Phase 2.

import type { BookmarkRecord } from '../bookmarks/types';
import type {
  LinkCheckRecord,
} from './types';
import {
  guardUrl,
  guardResolvedHost,
  type DnsResolver,
} from './url-guard';
import {
  fetchOnce,
  type FetchLikeFn,
  type FetchClientDeps,
} from './fetch-client';
import { classify } from './classifier';
import { shouldRetryAsGet } from './fetch-client';
import { TaskScheduler, type SchedulerAttemptResult, type SchedulerInputItem } from './scheduler';
import { DEFAULT_HEALTH_CONFIG } from './types';

export interface HealthServiceDeps {
  /** All bookmarks to scan (we filter to those with URLs). */
  listBookmarks(): Promise<BookmarkRecord[]>;
  /** Latest link check per bookmarkId, for the UI to display. */
  latestChecks(): Promise<LinkCheckRecord[]>;
  /** Save a new link check row. */
  saveCheck(rec: LinkCheckRecord): Promise<void>;
  /** DNS resolver for the URL guard. */
  dns: DnsResolver;
  /** HTTP fetcher matching the FetchLikeFn contract. */
  fetch: FetchLikeFn;
  /** Config knobs. */
  config: { defaultTimeoutMs: number; defaultMaxRedirects: number; defaultMaxResponseBytes: number; defaultUserAgent: string; globalConcurrency: number; perHostConcurrency: number; maxRetries: number; allowPrivateHosts: boolean };
  /** Wall-clock. */
  now(): number;
  /** Fresh id (uuid v4). */
  newId(): string;
  /** Pause switch driven by the UI. */
  isPaused: () => boolean;
}

export interface HealthServiceStatus {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  inflight: number;
  queued: number;
  lastError: string | null;
}

export class HealthService {
  private scheduler: TaskScheduler | null = null;
  private total = 0;
  private processed = 0;
  private lastError: string | null = null;
  private status: HealthServiceStatus['status'] = 'idle';
  private latestCache: Map<string, LinkCheckRecord> = new Map();

  constructor(private readonly deps: HealthServiceDeps) {}

  /** Returns the most recent check per bookmarkId, sorted by status. */
  async snapshot(): Promise<{ rows: LinkCheckRecord[]; status: HealthServiceStatus }> {
    const rows = await this.deps.latestChecks();
    // Index by bookmarkId, keep latest by checkedAt.
    const byBookmark = new Map<string, LinkCheckRecord>();
    for (const r of rows) {
      const prev = byBookmark.get(r.bookmarkId);
      if (!prev || r.checkedAt > prev.checkedAt) byBookmark.set(r.bookmarkId, r);
    }
    this.latestCache = byBookmark;
    return {
      rows: Array.from(byBookmark.values()),
      status: this.snapshotStatus(),
    };
  }

  /** Start a scan. If `bookmarkIds` is given, scan only those. */
  async start(bookmarkIds?: string[]): Promise<{ total: number; enqueued: number; skipped: number }> {
    if (this.scheduler && this.status === 'running') {
      return { total: this.total, enqueued: 0, skipped: 0 };
    }
    this.lastError = null;
    this.processed = 0;
    this.total = 0;

    const all = await this.deps.listBookmarks();
    const filtered = bookmarkIds
      ? all.filter((b) => bookmarkIds.includes(b.id) && b.url)
      : all.filter((b) => b.url);
    const items: SchedulerInputItem[] = [];
    let skipped = 0;
    const allowPrivate = this.deps.config.allowPrivateHosts === true;
    for (const b of filtered) {
      const url = b.url!;
      const guard = guardUrl(url, { allowPrivateHosts: allowPrivate });
      if (!guard.ok) {
        // Persist a single 'unsupported' record so the UI shows why.
        await this.deps.saveCheck({
          id: this.deps.newId(),
          bookmarkId: b.id,
          status: 'unsupported',
          checkedAt: this.deps.now(),
          evidence: [guard.reason, ...(allowPrivate ? [] : ['toggle on to scan private hosts'])],
          syncGeneration: (b as { syncGeneration?: number }).syncGeneration,
        });
        skipped += 1;
        continue;
      }
      // DNS guard before scheduling; if it fails we mark 'unsupported'.
      const dnsCheck = await guardResolvedHost(new URL(url).hostname, this.deps.dns, { allowPrivateHosts: allowPrivate });
      if (!dnsCheck.ok) {
        await this.deps.saveCheck({
          id: this.deps.newId(),
          bookmarkId: b.id,
          status: 'unsupported',
          checkedAt: this.deps.now(),
          evidence: [dnsCheck.reason],
        });
        skipped += 1;
        continue;
      }
      items.push({ bookmarkId: b.id, url, syncGeneration: b.syncGeneration });
    }

    this.total = items.length + skipped;
    this.status = 'running';
    const scheduler = this.makeScheduler();
    this.scheduler = scheduler;
    const added = scheduler.enqueue(items);
    return { total: this.total, enqueued: added, skipped };
  }

  pause(): void { this.scheduler?.pause(); this.status = 'paused'; }
  resume(): void { this.scheduler?.resume(); this.status = 'running'; }
  cancel(): void { this.scheduler?.cancelAll(); this.status = 'cancelled'; }

  snapshotStatus(): HealthServiceStatus {
    const inflight = this.scheduler?.status().inflight ?? 0;
    const queued = this.scheduler?.status().queued ?? 0;
    return {
      status: this.status,
      total: this.total,
      processed: this.processed,
      inflight,
      queued,
      lastError: this.lastError,
    };
  }

  private makeScheduler(): TaskScheduler {
    const deps = this.deps;
    const service = this;
    return new TaskScheduler({
      probe: async (bookmarkId, url, signal): Promise<SchedulerAttemptResult> => {
        const clientDeps: FetchClientDeps = {
          fetch: deps.fetch,
          defaultMaxRedirects: deps.config.defaultMaxRedirects,
          defaultTimeoutMs: deps.config.defaultTimeoutMs,
          defaultMaxResponseBytes: deps.config.defaultMaxResponseBytes,
          defaultUserAgent: deps.config.defaultUserAgent,
        };
        // Try HEAD first, fall back to GET on 405/501.
        const head = await fetchOnce(url, 'HEAD', clientDeps, { dns: deps.dns, signal });
        let outcome = head;
        if (head.httpCode > 0 && !shouldRetryAsGet(head.httpCode)) {
          // HEAD result is fine.
        } else {
          const get = await fetchOnce(url, 'GET', clientDeps, { dns: deps.dns, signal });
          outcome = get;
        }
        // Re-validate resolved host on the final URL (redirects may
        // have led us to a private address).
        if (outcome.finalUrl) {
          try {
            const h = new URL(outcome.finalUrl).hostname;
            const r2 = await guardResolvedHost(h, deps.dns);
            if (!r2.ok) {
              return {
                status: 'unsupported',
                final: true,
                evidence: [...(head.networkError ? ['head: ' + head.networkError] : []), 'redirect-to-private: ' + r2.reason],
              };
            }
          } catch { /* ignore parse failure */ }
        }

        const cls = classify({
          httpCode: outcome.httpCode,
          networkError: outcome.networkError,
          attempts: 0,
          retryAfterSec: outcome.retryAfterSec,
        });
        const evidence: string[] = [];
        if (outcome.networkError) evidence.push(`network: ${outcome.networkError}`);
        if (outcome.rawError) evidence.push(`raw: ${outcome.rawError}`);
        if (outcome.httpCode > 0) evidence.push(`${outcome.httpCode}`);
        if (outcome.finalUrl && outcome.finalUrl !== url) evidence.push(`→ ${outcome.finalUrl}`);
        return {
          status: cls.status,
          final: true,
          evidence,
          httpCode: outcome.httpCode || undefined,
          finalUrl: outcome.finalUrl,
          retryAfterSec: outcome.retryAfterSec,
          errorCode: outcome.networkError ?? undefined,
        };
      },
      saveCheck: async (rec) => { await deps.saveCheck(rec); service.processed += 1; },
      now: () => deps.now(),
      newId: () => deps.newId(),
      globalConcurrency: deps.config.globalConcurrency,
      perHostConcurrency: deps.config.perHostConcurrency,
      maxRetries: deps.config.maxRetries,
      isPaused: () => deps.isPaused(),
    });
  }
}

export { DEFAULT_HEALTH_CONFIG };
