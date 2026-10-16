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
  probeUrl,
  type FetchLikeFn,
  type FetchClientDeps,
} from './fetch-client';
import { classify } from './classifier';
import { TaskScheduler, type SchedulerAttemptResult, type SchedulerInputItem } from './scheduler';
import { DEFAULT_HEALTH_CONFIG } from './types';

export interface HealthServiceDeps {
  /** All bookmarks to scan (we filter to those with URLs). */
  listBookmarks(): Promise<BookmarkRecord[]>;
  /** Latest link check per bookmarkId, for the UI to display. */
  latestChecks(): Promise<LinkCheckRecord[]>;
  /** Save a new link check row. */
  saveCheck(rec: LinkCheckRecord): Promise<void>;
  /** Optional DNS resolver. Standard WebExtensions do not expose one. */
  dns?: DnsResolver;
  /** Whether the extension currently has permission to contact this origin. */
  canFetch(url: string): Promise<boolean>;
  /** HTTP fetcher matching the FetchLikeFn contract. */
  fetch: FetchLikeFn;
  /** Config knobs. */
  config: { defaultTimeoutMs: number; defaultMaxRedirects: number; defaultMaxResponseBytes: number; defaultUserAgent: string; globalConcurrency: number; perHostConcurrency: number; maxRetries: number; allowPrivateHosts: boolean };
  /**
   * Live re-read of the `allowPrivateHosts` flag. Called by
   * `start()` so the next scan sees the user's latest setting
   * without a service-worker restart. Resolves to false when
   * storage is unavailable (tests, first launch).
   */
  readAllowPrivateHosts(): Promise<boolean>;
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
  cancelled: number;
  active: Array<{ bookmarkId: string; url: string }>;
  nextEligibleAt: number | null;
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
    const [rows, bookmarks] = await Promise.all([this.deps.latestChecks(), this.deps.listBookmarks()]);
    // Index by bookmarkId, keep latest by checkedAt.
    const byBookmark = new Map<string, LinkCheckRecord>();
    for (const r of rows) {
      const prev = byBookmark.get(r.bookmarkId);
      if (!prev || r.checkedAt > prev.checkedAt) byBookmark.set(r.bookmarkId, r);
    }
    const current = new Map(bookmarks.filter((b) => b.url).map((b) => [b.id, b]));
    const displayRows: LinkCheckRecord[] = [];
    for (const bookmark of current.values()) {
      const check = byBookmark.get(bookmark.id);
      if (!check) {
        displayRows.push({ id: `unchecked:${bookmark.id}`, bookmarkId: bookmark.id, url: bookmark.url, status: 'unchecked', checkedAt: 0, evidence: ['尚未检查'], syncGeneration: bookmark.syncGeneration });
        continue;
      }
      if (check.url !== bookmark.url || check.syncGeneration !== bookmark.syncGeneration) {
        displayRows.push({ ...check, url: bookmark.url, status: 'outdated', checkedAt: check.checkedAt, evidence: ['书签 URL 或同步版本已变化；请重新检查'], syncGeneration: bookmark.syncGeneration });
        continue;
      }
      displayRows.push(check);
    }
    this.latestCache = byBookmark;
    return {
      rows: displayRows,
      status: this.snapshotStatus(),
    };
  }

  /** Start a scan. If `bookmarkIds` is given, scan only those. */
  async start(bookmarkIds?: string[]): Promise<{ total: number; enqueued: number; skipped: number; status: HealthServiceStatus['status'] }> {
    if (this.scheduler && (this.status === 'running' || this.status === 'paused')) {
      return { total: this.total, enqueued: 0, skipped: 0, status: this.status };
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
    // Live re-read of the toggle. Reads chrome.storage on every
    // `start()` so a flag change takes effect on the very next
    // scan, even if the service worker has not been restarted.
    const allowPrivate = await this.deps.readAllowPrivateHosts();
    for (const b of filtered) {
      const url = b.url!;
      const guard = guardUrl(url, { allowPrivateHosts: allowPrivate });
      if (!guard.ok) {
        // Persist a single 'unsupported' record so the UI shows why.
        await this.deps.saveCheck({
          id: this.deps.newId(),
          bookmarkId: b.id,
          url,
          status: 'unsupported',
          checkedAt: this.deps.now(),
          evidence: [guard.reason, ...(allowPrivate ? [] : ['toggle on to scan private hosts'])],
          syncGeneration: (b as { syncGeneration?: number }).syncGeneration,
        });
        skipped += 1;
        this.processed += 1;
        continue;
      }
      if (!await this.deps.canFetch(url)) {
        await this.deps.saveCheck({
          id: this.deps.newId(),
          bookmarkId: b.id,
          url,
          status: 'permission_required',
          checkedAt: this.deps.now(),
          evidence: ['site permission is required before scanning'],
          syncGeneration: b.syncGeneration,
        });
        skipped += 1;
        this.processed += 1;
        continue;
      }
      // DNS guard before scheduling; if it fails we mark 'unsupported'.
      const dnsCheck = this.deps.dns
        ? await guardResolvedHost(new URL(url).hostname, this.deps.dns, { allowPrivateHosts: allowPrivate })
        : null;
      if (dnsCheck && !dnsCheck.ok) {
        await this.deps.saveCheck({
          id: this.deps.newId(),
          bookmarkId: b.id,
          url,
          status: 'unsupported',
          checkedAt: this.deps.now(),
          evidence: [dnsCheck.reason],
        });
        skipped += 1;
        this.processed += 1;
        continue;
      }
      items.push({ bookmarkId: b.id, url, syncGeneration: b.syncGeneration });
    }

    this.total = items.length + skipped;
    this.status = 'running';
    const scheduler = this.makeScheduler(allowPrivate);
    this.scheduler = scheduler;
    const added = scheduler.enqueue(items);
    void scheduler.drain().then(() => {
      if (this.scheduler === scheduler && this.status === 'running') {
        this.status = 'completed';
      }
    }).catch((error: unknown) => {
      if (this.scheduler === scheduler) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.status = 'failed';
      }
    });
    return { total: this.total, enqueued: added, skipped, status: this.status };
  }

  pause(): void { if (this.status === 'running') { this.scheduler?.pause(); this.status = 'paused'; } }
  resume(): void { if (this.status === 'paused') { this.scheduler?.resume(); this.status = 'running'; } }
  cancel(): void { this.scheduler?.cancelAll(); this.status = 'cancelled'; }

  snapshotStatus(): HealthServiceStatus {
    const schedulerStatus = this.scheduler?.status();
    const inflight = schedulerStatus?.inflight ?? 0;
    const queued = schedulerStatus?.queued ?? 0;
    return {
      status: this.status,
      total: this.total,
      processed: this.processed,
      inflight,
      queued,
      cancelled: schedulerStatus?.cancelled ?? 0,
      active: schedulerStatus?.active ?? [],
      nextEligibleAt: schedulerStatus?.nextEligibleAt ?? null,
      lastError: this.lastError,
    };
  }

  private makeScheduler(allowPrivateHosts: boolean): TaskScheduler {
    const deps = this.deps;
    const service = this;
    return new TaskScheduler({
      probe: async (bookmarkId, url, attempt, signal, priorDeadResponses): Promise<SchedulerAttemptResult> => {
        const clientDeps: FetchClientDeps = {
          fetch: deps.fetch,
          defaultMaxRedirects: deps.config.defaultMaxRedirects,
          defaultTimeoutMs: deps.config.defaultTimeoutMs,
          defaultMaxResponseBytes: deps.config.defaultMaxResponseBytes,
          defaultUserAgent: deps.config.defaultUserAgent,
        };
        // HEAD is an inexpensive positive check only. Any non-2xx or network
        // response is confirmed with a bounded GET before classification.
        const { outcome, method } = await probeUrl(url, clientDeps, {
          ...(deps.dns ? { dns: deps.dns } : {}), signal, allowPrivateHosts,
        });
        if (signal.aborted) {
          return { status: 'network_error', final: true, errorCode: 'abort', evidence: ['cancelled'] };
        }
        if (outcome.redirectBlocked) {
          return {
            status: 'redirect_pending',
            final: true,
            evidence: [`${method} detected a redirect`, '为避免扩展在未知目标发请求，未自动跟随；请在浏览器中打开后确认'],
          };
        }
        // Re-validate resolved host on the final URL (redirects may
        // have led us to a private address).
        if (outcome.finalUrl && deps.dns) {
          try {
            const h = new URL(outcome.finalUrl).hostname;
            const r2 = await guardResolvedHost(h, deps.dns, { allowPrivateHosts: await deps.readAllowPrivateHosts() });
            if (!r2.ok) {
              return {
                status: 'unsupported',
                final: true,
                evidence: [...(outcome.networkError ? ['network: ' + outcome.networkError] : []), 'redirect-to-private: ' + r2.reason],
              };
            }
          } catch { /* ignore parse failure */ }
        }

        const cls = classify({
          httpCode: outcome.httpCode,
          networkError: outcome.networkError,
          attempts: attempt,
          priorDeadResponses,
          retryAfterSec: outcome.retryAfterSec,
        });
        const evidence: string[] = [];
        evidence.push(`检查方式：${method}`);
        if (outcome.networkError) evidence.push(`浏览器网络错误：${outcome.networkError}`);
        if (outcome.rawError) evidence.push(`raw: ${outcome.rawError}`);
        if (outcome.httpCode > 0) evidence.push(`${outcome.httpCode}`);
        if (outcome.finalUrl && outcome.finalUrl !== url) evidence.push(`→ ${outcome.finalUrl}`);
        return {
          status: cls.status,
          final: cls.status !== 'network_error' && cls.status !== 'suspected_dead',
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
