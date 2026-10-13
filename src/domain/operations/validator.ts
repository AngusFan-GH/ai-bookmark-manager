// src/domain/operations/validator.ts
//
// PlanValidator — structural validation of a plan BEFORE execution.
// Per dev guide § 3.7: "合法 ID、权限、目标目录、前置状态一致性".
//
// What this checks (static, against the plan alone):
//   - Every step has a non-empty id
//   - Every action is one of the known set
//   - dependsOn ids all refer to steps in the same plan
//   - The dependency graph is acyclic
//   - The order values are unique within a plan (ties fall back to
//     lexicographic id order in sortSteps())
//   - Steps with riskLevel='high' have a non-empty reason
//   - Delete steps have a non-empty targetBrowserId
//   - Create steps have a non-empty parentBrowserId
//
// What this does NOT check (handled by executor at apply time):
//   - Whether the target browserId still exists
//   - Whether the parent exists
//   - Whether the live state matches expectedBefore
//
// Per dev guide § 3.7 "执行前重新查询浏览器实际状态" — that's the
// executor's job, not the static validator.

import type { OperationPlan, OperationStep } from './types';
import { AppErrorImpl } from '../../shared/errors';

const VALID_ACTIONS = new Set(['create', 'rename', 'update', 'move', 'delete']);

export function validatePlan(plan: OperationPlan): void {
  if (!plan || typeof plan !== 'object') {
    throw new AppErrorImpl('INVALID_REQUEST', 'plan must be an object', false);
  }
  if (!plan.id || typeof plan.id !== 'string') {
    throw new AppErrorImpl('INVALID_REQUEST', 'plan.id is required', false);
  }
  if (!Array.isArray(plan.steps)) {
    throw new AppErrorImpl('INVALID_REQUEST', 'plan.steps must be an array', false);
  }
  if (!Array.isArray(plan.steps)) {
    throw new AppErrorImpl('INVALID_REQUEST', 'plan.steps must be an array', false);
  }
  if (plan.steps.length > 0) {
    validateStepIds(plan.steps);
    validateActionShape(plan.steps);
    validateDependencyGraph(plan.steps);
    validateOrderUniqueness(plan.steps);
    validateRiskReasonShape(plan.steps);
  }
}

function validateStepIds(steps: OperationStep[]): void {
  const ids = new Set<string>();
  for (const s of steps) {
    if (!s.id || typeof s.id !== 'string') {
      throw new AppErrorImpl('INVALID_REQUEST', `step id is required (got ${JSON.stringify(s.id)})`, false);
    }
    if (ids.has(s.id)) {
      throw new AppErrorImpl('INVALID_REQUEST', `duplicate step id: ${s.id}`, false);
    }
    ids.add(s.id);
  }
}

function validateActionShape(steps: OperationStep[]): void {
  for (const s of steps) {
    if (!VALID_ACTIONS.has(s.action)) {
      throw new AppErrorImpl('INVALID_REQUEST', `step ${s.id}: invalid action ${s.action}`, false);
    }
    if (s.action === 'delete' && !s.targetBrowserId) {
      throw new AppErrorImpl('INVALID_REQUEST', `step ${s.id}: delete requires targetBrowserId`, false);
    }
    if (s.action === 'create' && !s.parentBrowserId) {
      throw new AppErrorImpl('INVALID_REQUEST', `step ${s.id}: create requires parentBrowserId`, false);
    }
  }
}

function validateDependencyGraph(steps: OperationStep[]): void {
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new AppErrorImpl('INVALID_REQUEST', `step ${s.id} depends on unknown step ${dep}`, false);
      }
    }
  }
  // Cycle detection via DFS coloring. We use a small inline algorithm
  // because the typical plan has tens of steps at most.
  const adjacency = new Map<string, string[]>();
  for (const s of steps) adjacency.set(s.id, s.dependsOn ?? []);

  enum Color { White, Gray, Black }
  const color = new Map<string, Color>();
  for (const s of steps) color.set(s.id, Color.White);

  const visit = (id: string, path: string[]): void => {
    const c = color.get(id);
    if (c === Color.Gray) {
      throw new AppErrorImpl('INVALID_REQUEST', `dependency cycle: ${[...path, id].join(' -> ')}`, false);
    }
    if (c === Color.Black) return;
    color.set(id, Color.Gray);
    for (const dep of adjacency.get(id) ?? []) {
      visit(dep, [...path, id]);
    }
    color.set(id, Color.Black);
  };

  for (const s of steps) {
    if (color.get(s.id) === Color.White) visit(s.id, []);
  }
}

function validateOrderUniqueness(steps: OperationStep[]): void {
  // Ties fall back to lexicographic id order in sortSteps(), so
  // duplicates are not strictly a correctness problem, but they
  // usually indicate a bug in the planner. We warn via error.
  const orders = new Map<number, number>();
  for (const s of steps) {
    if (typeof s.order !== 'number' || !Number.isFinite(s.order)) {
      throw new AppErrorImpl('INVALID_REQUEST', `step ${s.id}: order must be a finite number`, false);
    }
    orders.set(s.order, (orders.get(s.order) ?? 0) + 1);
  }
  for (const [order, count] of orders) {
    if (count > 1) {
      throw new AppErrorImpl('INVALID_REQUEST', `multiple steps share order ${order}`, false);
    }
  }
}

function validateRiskReasonShape(steps: OperationStep[]): void {
  for (const s of steps) {
    if (s.riskLevel === 'high' && (!s.reason || typeof s.reason !== 'string' || s.reason.trim().length === 0)) {
      throw new AppErrorImpl('INVALID_REQUEST', `step ${s.id}: high-risk steps require a non-empty reason`, false);
    }
  }
}
