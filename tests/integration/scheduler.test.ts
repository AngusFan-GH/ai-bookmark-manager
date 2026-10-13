// tests/integration/scheduler.test.ts
//
// TaskScheduler: concurrency, host gating, retry budget, cancel.

import { describe, expect, it, beforeEach } from 'vitest';
import { TaskScheduler, type SchedulerAttemptResult, type SchedulerDeps } from '../../src/domain/health/scheduler';
import type { LinkCheckRecord } from '../../src/domain/health/types';

let saved: LinkCheckRecord[] = [];
let paused = false;
let nextIdCounter = 0;
const newId = (): string => `c-${++nextIdCounter}`;

function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    probe: async (_bookmarkId, url) => {
      const host = new URL(url).hostname;
      return {
        status: 'healthy' as const,
        final: true,
        evidence: [`probe:${host}`],
        httpCode: 200,
        finalUrl: url,
        retryAfterSec: null,
        errorCode: undefined,
      } satisfies SchedulerAttemptResult;
    },
    saveCheck: async (rec) => { saved.push(rec); },
    now: () => Date.now(),
    newId,
    globalConcurrency: 2,
    perHostConcurrency: 1,
    maxRetries: 1,
    isPaused: () => paused,
    ...overrides,
  };
}

beforeEach(() => { saved = []; paused = false; nextIdCounter = 0; });

describe('TaskScheduler — basic enqueue + complete', () => {
  it('runs every item and records a check for each', async () => {
    const sched = new TaskScheduler(makeDeps());
    sched.enqueue([
      { bookmarkId: 'b1', url: 'https://a.test/x', syncGeneration: 1 },
      { bookmarkId: 'b2', url: 'https://a.test/y', syncGeneration: 1 },
      { bookmarkId: 'b3', url: 'https://b.test/z', syncGeneration: 1 },
    ]);
    await sched.drain();
    expect(saved).toHaveLength(3);
    expect(saved.map((s) => s.bookmarkId).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(saved.every((s) => s.status === 'healthy')).toBe(true);
  });

  it('exposes the URLs currently being checked for a live progress UI', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sched = new TaskScheduler(makeDeps({
      probe: async (_id, url) => {
        await gate;
        return { status: 'healthy', final: true, evidence: [], httpCode: 200, finalUrl: url };
      },
    }));
    sched.enqueue([{ bookmarkId: 'b1', url: 'https://a.test/active', syncGeneration: 1 }]);
    expect(sched.status().active).toEqual([{ bookmarkId: 'b1', url: 'https://a.test/active' }]);
    release();
    await sched.drain();
    expect(sched.status().active).toEqual([]);
  });
});

describe('TaskScheduler — per-host concurrency cap', () => {
  it('does not run two probes for the same host simultaneously', async () => {
    let inflight = 0;
    let peak = 0;
    const deps = makeDeps({
      probe: async (_id, url) => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight -= 1;
        return { status: 'healthy' as const, final: true, evidence: [], retryAfterSec: null, httpCode: 200, finalUrl: url };
      },
    });
    const sched = new TaskScheduler(deps);
    sched.enqueue([
      { bookmarkId: 'b1', url: 'https://a.test/1', syncGeneration: 1 },
      { bookmarkId: 'b2', url: 'https://a.test/2', syncGeneration: 1 },
      { bookmarkId: 'b3', url: 'https://a.test/3', syncGeneration: 1 },
    ]);
    await sched.drain();
    // The first ran, the second waited, the third waited — peak is 1
    // for the same host.
    expect(peak).toBe(1);
  });
});

describe('TaskScheduler — global concurrency cap', () => {
  it('never exceeds the global cap across different hosts', async () => {
    let inflight = 0;
    let peak = 0;
    const deps = makeDeps({
      globalConcurrency: 3,
      perHostConcurrency: 1,
      probe: async (_id, url) => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight -= 1;
        return { status: 'healthy' as const, final: true, evidence: [], retryAfterSec: null, httpCode: 200, finalUrl: url };
      },
    });
    const sched = new TaskScheduler(deps);
    const items = Array.from({ length: 6 }, (_, i) => ({
      bookmarkId: `b${i}`,
      url: `https://host${i}.test/`,
      syncGeneration: 1,
    }));
    sched.enqueue(items);
    await sched.drain();
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('TaskScheduler — retry budget', () => {
  it('retries on network_error up to maxRetries, then persists network_error', async () => {
    let calls = 0;
    const deps = makeDeps({
      probe: async (_id, url) => {
        calls += 1;
        return { status: 'network_error' as const, final: false, evidence: ['timeout'], retryAfterSec: null, finalUrl: url };
      },
    });
    const sched = new TaskScheduler(deps);
    sched.enqueue([{ bookmarkId: 'b1', url: 'https://a.test/x', syncGeneration: 1 }]);
    await sched.drain();
    expect(calls).toBe(2); // 1 initial + 1 retry (maxRetries=1)
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe('network_error');
  });

  it('does not retry on final=true outcomes', async () => {
    let calls = 0;
    const deps = makeDeps({
      probe: async (_id, url) => {
        calls += 1;
        return { status: 'healthy' as const, final: true, evidence: [], retryAfterSec: null, httpCode: 200, finalUrl: url };
      },
    });
    const sched = new TaskScheduler(deps);
    sched.enqueue([{ bookmarkId: 'b1', url: 'https://a.test/x', syncGeneration: 1 }]);
    await sched.drain();
    expect(calls).toBe(1);
  });
});

describe('TaskScheduler — pause / resume / cancel', () => {
  it('pause stops new work, resume continues', async () => {
    let calls = 0;
    const deps = makeDeps({
      probe: async (_id, url) => {
        calls += 1;
        return { status: 'healthy' as const, final: true, evidence: [], retryAfterSec: null, httpCode: 200, finalUrl: url };
      },
    });
    const sched = new TaskScheduler(deps);
    sched.pause();
    sched.enqueue([{ bookmarkId: 'b1', url: 'https://a.test/x', syncGeneration: 1 }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(0);
    sched.resume();
    await sched.drain();
    expect(calls).toBe(1);
  });

  it('cancel(bookmarkId) prevents persisting a result for that item', async () => {
    const deps = makeDeps({
      probe: async (_id, url) => ({
        status: 'healthy' as const, final: true, evidence: [], retryAfterSec: null, httpCode: 200, finalUrl: url,
      }),
    });
    const sched = new TaskScheduler(deps);
    sched.enqueue([{ bookmarkId: 'b1', url: 'https://a.test/x', syncGeneration: 1 }]);
    // Cancel before drain. The probe is async and may have started,
    // but the result must not be persisted and the retry loop must
    // exit.
    sched.cancel('b1');
    await sched.drain();
    // The probe may have been called (the start of the body runs
    // before the first await) but the result is discarded because
    // cancelled is checked AFTER each probe await. We assert on
    // the persisted record, not the call count.
    expect(saved).toHaveLength(0);
  });

  it('cancel(bookmarkId) before enqueue prevents any work', async () => {
    let calls = 0;
    const deps = makeDeps({
      probe: async (_id, url) => {
        calls += 1;
        return { status: 'healthy' as const, final: true, evidence: [], retryAfterSec: null, httpCode: 200, finalUrl: url };
      },
    });
    const sched = new TaskScheduler(deps);
    sched.cancel('b1');
    sched.enqueue([{ bookmarkId: 'b1', url: 'https://a.test/x', syncGeneration: 1 }]);
    await sched.drain();
    // The check at the top of runOne catches this case.
    expect(calls).toBe(0);
    expect(saved).toHaveLength(0);
  });
});
