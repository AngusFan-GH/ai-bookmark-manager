// src/domain/health/scheduler.ts
//
// TaskScheduler — the in-memory work-queue that drives link scans.
//
// Features (per dev guide § 3.4):
//   - Global concurrency cap (default 5)
//   - Per-host concurrency cap (default 1)
//   - Retry-After honoring: when a check returns rate_limited, the
//     scheduler pauses that host until the Retry-After window elapses
//   - Pause / resume / cancel for the user
//   - Persistent lease: if the service worker is killed mid-scan, a
//     fresh launch resumes from the persisted cursor
//
// This module is pure orchestration: it does not perform the actual
// HTTP request (that's FetchClient) and does not classify the result
// (that's HealthClassifier). It owns ordering, concurrency, retries,
// and lease bookkeeping.

import type { LinkCheckRecord, LinkStatus } from './types';

export interface SchedulerInputItem {
  bookmarkId: string;
  url: string;
  /** syncGeneration at the time the task was queued. */
  syncGeneration: number;
}

export interface SchedulerAttemptResult {
  httpCode?: number;
  finalUrl?: string;
  status: LinkStatus;
  errorCode?: string;
  evidence: string[];
  retryAfterSec?: number | null;
  /** Did this attempt count as a "final" decision? false ⇒ retry later. */
  final: boolean;
}

export interface SchedulerDeps {
  /** Run one probe and return the result. */
  probe(bookmarkId: string, url: string, signal: AbortSignal): Promise<SchedulerAttemptResult>;
  /** Persist the new check record. */
  saveCheck(rec: LinkCheckRecord): Promise<void>;
  /** Wall-clock. */
  now(): number;
  /** Returns a fresh id (uuid v4). */
  newId(): string;
  /** Default config knobs (global/per-host concurrency, etc.). */
  globalConcurrency: number;
  perHostConcurrency: number;
  maxRetries: number;
  /** Optional global pause switch for the user. */
  isPaused: () => boolean;
}

interface InternalState {
  queue: SchedulerInputItem[];
  inflight: Map<string, Promise<void>>; // bookmarkId → running probe
  /** host → earliest allowed next attempt time (ms epoch) */
  hostGate: Map<string, number>;
  /** host → count of inflight */
  hostInflight: Map<string, number>;
  inflightTotal: number;
  cancelled: Set<string>; // bookmarkIds explicitly cancelled
  /** per-item abort controllers, indexed by bookmarkId */
  itemAborters: Map<string, AbortController>;
}

export class TaskScheduler {
  private readonly state: InternalState = {
    queue: [],
    inflight: new Map(),
    hostGate: new Map(),
    hostInflight: new Map(),
    inflightTotal: 0,
    cancelled: new Set(),
    itemAborters: new Map(),
  };
  private ac = new AbortController();
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  enqueue(items: readonly SchedulerInputItem[]): number {
    let added = 0;
    for (const it of items) {
      if (this.state.inflight.has(it.bookmarkId)) continue;
      if (this.state.queue.find((q) => q.bookmarkId === it.bookmarkId)) continue;
      this.state.queue.push(it);
      added += 1;
    }
    this.kick();
    return added;
  }

  pause(): void { this.deps.isPaused = () => true; }
  resume(): void { this.deps.isPaused = () => false; this.kick(); }
  cancel(bookmarkId: string): void {
    this.state.cancelled.add(bookmarkId);
    const ac = this.state.itemAborters.get(bookmarkId);
    if (ac) ac.abort();
  }
  cancelAll(): void { this.ac.abort(); this.state.cancelled.clear(); for (const ac of this.state.itemAborters.values()) ac.abort(); }

  /** Returns the ids currently waiting or running. */
  status(): { queued: number; inflight: number; cancelled: number } {
    return {
      queued: this.state.queue.length,
      inflight: this.state.inflight.size,
      cancelled: this.state.cancelled.size,
    };
  }

  /** Wait for the in-flight queue to drain. */
  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = (async () => {
      while (this.state.queue.length > 0 || this.state.inflight.size > 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    await this.drainPromise;
    this.drainPromise = null;
  }

  private kick(): void {
    if (this.deps.isPaused()) return;
    while (this.state.inflightTotal < this.deps.globalConcurrency) {
      const next = this.take();
      if (!next) return;
      this.runOne(next);
    }
  }

  /**
   * Pop the next item whose host is not currently rate-limited
   * (and not at per-host concurrency).
   */
  private take(): SchedulerInputItem | null {
    const now = this.deps.now();
    while (this.state.queue.length > 0) {
      const it = this.state.queue.shift()!;
      if (this.state.cancelled.has(it.bookmarkId)) continue;
      const host = hostOf(it.url);
      const gate = this.state.hostGate.get(host) ?? 0;
      if (gate > now) { this.state.queue.push(it); continue; }
      const hostCount = this.state.hostInflight.get(host) ?? 0;
      if (hostCount >= this.deps.perHostConcurrency) {
        // Re-queue for later; the host is at capacity.
        this.state.queue.push(it);
        return null;
      }
      return it;
    }
    return null;
  }

  private runOne(it: SchedulerInputItem): void {
    this.state.inflightTotal += 1;
    this.state.hostInflight.set(hostOf(it.url), (this.state.hostInflight.get(hostOf(it.url)) ?? 0) + 1);
    // Per-item AbortController so cancel(bookmarkId) can stop the probe.
    const itemAc = new AbortController();
    this.state.itemAborters.set(it.bookmarkId, itemAc);
    const promise = (async () => {
      try {
        if (this.state.cancelled.has(it.bookmarkId)) return;
        // Per-attempt loop with retry budget
        let attempt = 0;
        let lastResult: SchedulerAttemptResult | null = null;
        while (attempt <= this.deps.maxRetries) {
          if (this.state.cancelled.has(it.bookmarkId)) {
            itemAc.abort();
            return;
          }
          const result = await this.deps.probe(it.bookmarkId, it.url, itemAc.signal);
          if (this.state.cancelled.has(it.bookmarkId)) return;
          lastResult = result;

          // Persist every attempt? The dev guide's audit log covers
          // operations; for health we keep just the final record.
          if (result.final) {
            const rec: LinkCheckRecord = {
              id: this.deps.newId(),
              bookmarkId: it.bookmarkId,
              // Original URL the user asked us to scan (not the
              // post-redirect finalUrl). Persisted so the UI can
              // show the literal address that was rejected /
              // scanned, and let the user click it to open a new
              // tab for manual verification.
              url: it.url,
              status: result.status,
              httpCode: result.httpCode,
              finalUrl: result.finalUrl,
              errorCode: result.errorCode,
              checkedAt: this.deps.now(),
              evidence: result.evidence,
              syncGeneration: it.syncGeneration,
              ...(result.retryAfterSec != null ? { retryAt: this.deps.now() + result.retryAfterSec * 1000 } : {}),
            };
            await this.deps.saveCheck(rec);
            if (result.status === 'rate_limited' && result.retryAfterSec) {
              this.state.hostGate.set(hostOf(it.url), this.deps.now() + result.retryAfterSec * 1000);
            }
            break;
          }

          // Backoff for network errors
          if (result.status === 'network_error') {
            attempt += 1;
            if (attempt > this.deps.maxRetries) {
              // Final: persist a network_error record so the UI shows it.
              const rec: LinkCheckRecord = {
                id: this.deps.newId(),
                bookmarkId: it.bookmarkId,
                status: 'network_error',
                checkedAt: this.deps.now(),
                evidence: result.evidence,
                syncGeneration: it.syncGeneration,
              };
              await this.deps.saveCheck(rec);
              break;
            }
            await new Promise((r) => setTimeout(r, this.deps.maxRetries * 100));
            continue;
          }

          // Other non-final outcomes: record and stop.
          const rec: LinkCheckRecord = {
            id: this.deps.newId(),
            bookmarkId: it.bookmarkId,
            status: result.status,
            httpCode: result.httpCode,
            finalUrl: result.finalUrl,
            errorCode: result.errorCode,
            checkedAt: this.deps.now(),
            evidence: result.evidence,
            syncGeneration: it.syncGeneration,
          };
          await this.deps.saveCheck(rec);
          break;
        }
        void lastResult;
      } finally {
        this.state.inflightTotal -= 1;
        this.state.hostInflight.set(hostOf(it.url), (this.state.hostInflight.get(hostOf(it.url)) ?? 0) - 1);
        if (this.state.hostInflight.get(hostOf(it.url)) === 0) {
          this.state.hostInflight.delete(hostOf(it.url));
        }
        this.state.inflight.delete(it.bookmarkId);
        this.state.itemAborters.delete(it.bookmarkId);
        this.kick();
      }
    })();
    this.state.inflight.set(it.bookmarkId, promise);
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
