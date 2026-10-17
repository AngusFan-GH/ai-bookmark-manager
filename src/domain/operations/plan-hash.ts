import type { OperationPlan } from './types';

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

/**
 * Hash every operation-relevant field in a stable order. This deliberately
 * excludes mutable runtime status/audit fields, but includes the generation
 * and exact desired/expected states the user approved.
 */
export async function hashApprovedPlan(plan: OperationPlan): Promise<string> {
  const payload = JSON.stringify(normalize({
    id: plan.id,
    basedOnGeneration: plan.basedOnGeneration,
    // Evidence changes alter which native writes are safe; runtime snapshot IDs do not.
    organizationEvidence: plan.metadata['plan-service.evidence'] ?? null,
    steps: [...plan.steps]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((step) => ({
        id: step.id,
        order: step.order,
        action: step.action,
        targetBrowserId: step.targetBrowserId,
        parentBrowserId: step.parentBrowserId,
        parentStepId: step.parentStepId,
        expectedBefore: step.expectedBefore,
        desiredAfter: step.desiredAfter,
        riskLevel: step.riskLevel,
        dependsOn: [...step.dependsOn].sort(),
      })),
  }));
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
