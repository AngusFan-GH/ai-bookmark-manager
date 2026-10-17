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
//   - In-memory queue: a service-worker restart ends the current scan;
//     callers must report this limitation rather than claiming recovery.
//
// This module is pure orchestration: it does not perform the actual
// HTTP request (that's FetchClient) and does not classify the result
// (that's HealthClassifier). It owns ordering, concurrency, retries,
// and ephemeral task bookkeeping. It intentionally does not claim to survive
// an MV3 service-worker restart; a persisted job queue is future work.

import type { LinkCheckRecord, LinkStatus, HealthObservation } from './types';

export interface SchedulerInputItem {
  bookmarkId: string;
  url: string;
  /** syncGeneration at the time the task was queued. */
  syncGeneration: number;
}

export interface SchedulerAttemptResult {
  method?: 'HEAD' | 'GET';
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
  probe(bookmarkId: string, url: string, attempt: number, signal: AbortSignal, priorDeadResponses: number): Promise<SchedulerAttemptResult>;
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
  active: Map<string, string>; // bookmarkId → URL, for live UI progress
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
    active: new Map(),
  };
  private drainPromise: Promise<void> | null = null;
  private paused = false;
  private failure: unknown = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

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

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.kick(); }
  cancel(bookmarkId: string): void {
    this.state.cancelled.add(bookmarkId);
    const ac = this.state.itemAborters.get(bookmarkId);
    if (ac) ac.abort();
  }
  cancelAll(): void {
    // Cancel both running and not-yet-started probes. Previously only active
    // AbortControllers were stopped, so queued items resumed after a cancel.
    for (const item of this.state.queue) this.state.cancelled.add(item.bookmarkId);
    this.state.queue = [];
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    for (const [bookmarkId, ac] of this.state.itemAborters) {
      this.state.cancelled.add(bookmarkId);
      ac.abort();
    }
  }

  /** Returns the ids currently waiting or running. */
  status(): { queued: number; inflight: number; cancelled: number; active: Array<{ bookmarkId: string; url: string }>; nextEligibleAt: number | null } {
    return {
      queued: this.state.queue.length,
      inflight: this.state.inflight.size,
      cancelled: this.state.cancelled.size,
      active: Array.from(this.state.active, ([bookmarkId, url]) => ({ bookmarkId, url })),
      nextEligibleAt: this.nextEligibleAt(),
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
    if (this.failure) throw this.failure;
  }

  private kick(): void {
    if (this.paused || this.deps.isPaused()) return;
    while (this.state.inflightTotal < this.deps.globalConcurrency) {
      const next = this.take();
      if (!next) {
        this.scheduleWake();
        return;
      }
      this.runOne(next);
    }
  }

  /**
   * Pop the next item whose host is not currently rate-limited
   * (and not at per-host concurrency).
   */
  private take(): SchedulerInputItem | null {
    const now = this.deps.now();
    const candidates = this.state.queue.length;
    for (let checked = 0; checked < candidates; checked += 1) {
      const it = this.state.queue.shift()!;
      if (this.state.cancelled.has(it.bookmarkId)) continue;
      const host = hostOf(it.url);
      const gate = this.state.hostGate.get(host) ?? 0;
      if (gate > now) { this.state.queue.push(it); continue; }
      const hostCount = this.state.hostInflight.get(host) ?? 0;
      if (hostCount >= this.deps.perHostConcurrency) {
        // Re-queue for later; the host is at capacity.
        this.state.queue.push(it);
        continue;
      }
      return it;
    }
    return null;
  }

  private nextEligibleAt(): number | null {
    let earliest: number | null = null;
    for (const item of this.state.queue) {
      const gate = this.state.hostGate.get(hostOf(item.url)) ?? 0;
      if (gate > this.deps.now() && (earliest == null || gate < earliest)) earliest = gate;
    }
    return earliest;
  }

  /** Wake the queue after the earliest Retry-After gate. */
  private scheduleWake(): void {
    const at = this.nextEligibleAt();
    if (at == null || this.wakeTimer || this.paused || this.deps.isPaused()) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.kick();
    }, Math.min(2_147_483_647, Math.max(0, at - this.deps.now()) + 5));
  }

  private runOne(it: SchedulerInputItem): void {
    this.state.inflightTotal += 1;
    this.state.hostInflight.set(hostOf(it.url), (this.state.hostInflight.get(hostOf(it.url)) ?? 0) + 1);
    // Per-item AbortController so cancel(bookmarkId) can stop the probe.
    const itemAc = new AbortController();
    this.state.itemAborters.set(it.bookmarkId, itemAc);
    this.state.active.set(it.bookmarkId, it.url);
    const promise = (async () => {
      try {
        if (this.state.cancelled.has(it.bookmarkId)) return;
        // Per-attempt loop with retry budget
        let attempt = 0;
        let priorDeadResponses = 0;
        const observations: HealthObservation[] = [];
        let lastResult: SchedulerAttemptResult | null = null;
        while (attempt <= this.deps.maxRetries) {
          if (this.state.cancelled.has(it.bookmarkId)) {
            itemAc.abort();
            return;
          }
          const result = await this.deps.probe(it.bookmarkId, it.url, attempt, itemAc.signal, priorDeadResponses);
          if (this.state.cancelled.has(it.bookmarkId)) return;
          lastResult = result;
          const retryAfterSec = typeof result.retryAfterSec === 'number' && Number.isFinite(result.retryAfterSec) && result.retryAfterSec >= 0
            ? Math.min(result.retryAfterSec, 365 * 24 * 60 * 60) : undefined;
          observations.push({ checkedAt: this.deps.now(), method: result.method, httpCode: result.httpCode, status: result.status, evidence: result.evidence });
          if (result.method === 'GET' && (result.httpCode === 404 || result.httpCode === 410)) priorDeadResponses += 1;

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
              observations: [...observations],
              syncGeneration: it.syncGeneration,
              ...(retryAfterSec != null ? { retryAt: this.deps.now() + retryAfterSec * 1000 } : {}),
            };
            await this.deps.saveCheck(rec);
            if (result.status === 'rate_limited' && retryAfterSec) {
              this.state.hostGate.set(hostOf(it.url), this.deps.now() + retryAfterSec * 1000);
            }
            break;
          }

          // A transient network failure and a first 404/410 are both
          // rechecked. Even repeated responses only establish observed HTTP
          // behavior during this scan, never permanent death.
          if (result.status === 'network_error' || result.status === 'suspected_dead') {
            attempt += 1;
            if (attempt > this.deps.maxRetries) {
              // Final: preserve the most useful outcome instead of upgrading
              // a single 404/410 to repeated evidence without a recheck.
              const rec: LinkCheckRecord = {
                id: this.deps.newId(),
                bookmarkId: it.bookmarkId,
                url: it.url,
                status: result.status,
                httpCode: result.httpCode,
                finalUrl: result.finalUrl,
                errorCode: result.errorCode,
                checkedAt: this.deps.now(),
                evidence: result.evidence,
                observations: [...observations],
                syncGeneration: it.syncGeneration,
              };
              await this.deps.saveCheck(rec);
              break;
            }
            await new Promise<void>((resolve) => {
              const done = () => { clearTimeout(timer); itemAc.signal.removeEventListener('abort', done); resolve(); };
              const timer = setTimeout(done, Math.min(5_000, 1_000 * attempt));
              itemAc.signal.addEventListener('abort', done, { once: true });
              if (itemAc.signal.aborted) done();
            });
            continue;
          }

          // Other non-final outcomes: record and stop.
          const rec: LinkCheckRecord = {
            id: this.deps.newId(),
            bookmarkId: it.bookmarkId,
            url: it.url,
            status: result.status,
            httpCode: result.httpCode,
            finalUrl: result.finalUrl,
            errorCode: result.errorCode,
            checkedAt: this.deps.now(),
            evidence: result.evidence,
            observations: [...observations],
            syncGeneration: it.syncGeneration,
          };
          await this.deps.saveCheck(rec);
          break;
        }
        void lastResult;
      } catch (error) {
        this.failure = error;
        this.cancelAll();
      } finally {
        this.state.inflightTotal -= 1;
        this.state.hostInflight.set(hostOf(it.url), (this.state.hostInflight.get(hostOf(it.url)) ?? 0) - 1);
        if (this.state.hostInflight.get(hostOf(it.url)) === 0) {
          this.state.hostInflight.delete(hostOf(it.url));
        }
        this.state.inflight.delete(it.bookmarkId);
        this.state.itemAborters.delete(it.bookmarkId);
        this.state.active.delete(it.bookmarkId);
        this.kick();
      }
    })();
    this.state.inflight.set(it.bookmarkId, promise);
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
