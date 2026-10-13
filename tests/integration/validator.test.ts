// tests/integration/validator.test.ts
//
// PlanValidator: structural checks. Per dev guide § 3.7.

import { describe, expect, it } from 'vitest';
import { validatePlan } from '../../src/domain/operations/validator';
import { AppErrorImpl } from '../../src/shared/errors';
import type { OperationPlan, OperationStep } from '../../src/domain/operations/types';

function makeStep(overrides: Partial<OperationStep> = {}): OperationStep {
  return {
    id: 's1',
    planId: 'p1',
    order: 0,
    action: 'rename',
    targetBrowserId: 'b1',
    parentBrowserId: null,
    expectedBefore: { title: 'old' },
    desiredAfter: { title: 'new' },
    reason: 'test',
    riskLevel: 'low',
    dependsOn: [],
    status: 'pending',
    inverseOfId: null,
    errorMessage: null,
    evidence: [],
    ...overrides,
  };
}

function makePlan(steps: OperationStep[]): OperationPlan {
  return {
    id: 'p1',
    title: 'plan',
    description: 'desc',
    createdAt: 0,
    approvedAt: null,
    basedOnGeneration: 1,
    steps,
    status: 'draft',
    metadata: {},
  };
}

describe('validatePlan', () => {
  it('accepts a plan with zero steps', () => {
    expect(() => validatePlan(makePlan([]))).not.toThrow();
  });

  it('accepts a well-formed plan', () => {
    expect(() => validatePlan(makePlan([makeStep()]))).not.toThrow();
  });

  it('rejects a plan without an id', () => {
    const p = makePlan([]);
    (p as { id: string }).id = '';
    expect(() => validatePlan(p)).toThrow(AppErrorImpl);
  });

  it('rejects a step with a duplicate id', () => {
    expect(() => validatePlan(makePlan([makeStep({ id: 'a' }), makeStep({ id: 'a', order: 1 })]))).toThrow(/duplicate step id/);
  });

  it('rejects an unknown action', () => {
    expect(() => validatePlan(makePlan([makeStep({ action: 'fly' as unknown as 'rename' })]))).toThrow(/invalid action/);
  });

  it('rejects a delete step without targetBrowserId', () => {
    expect(() => validatePlan(makePlan([makeStep({ action: 'delete', targetBrowserId: null })]))).toThrow(/delete requires targetBrowserId/);
  });

  it('rejects a create step without parentBrowserId', () => {
    expect(() => validatePlan(makePlan([makeStep({ action: 'create', parentBrowserId: null })]))).toThrow(/create requires parentBrowserId/);
  });

  it('rejects a step that depends on a missing step', () => {
    expect(() => validatePlan(makePlan([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', order: 1, dependsOn: ['zzz'] }),
    ]))).toThrow(/depends on unknown step/);
  });

  it('rejects a cycle', () => {
    expect(() => validatePlan(makePlan([
      makeStep({ id: 'a', order: 0, dependsOn: ['b'] }),
      makeStep({ id: 'b', order: 1, dependsOn: ['a'] }),
    ]))).toThrow(/dependency cycle/);
  });

  it('rejects a high-risk step with empty reason', () => {
    expect(() => validatePlan(makePlan([
      makeStep({ action: 'delete', riskLevel: 'high', reason: '' }),
    ]))).toThrow(/high-risk steps require a non-empty reason/);
  });

  it('rejects multiple steps sharing the same order', () => {
    expect(() => validatePlan(makePlan([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', order: 0 }),
    ]))).toThrow(/multiple steps share order/);
  });
});
