// src/domain/operations/types.ts
//
// Operation plan / step / approval / snapshot domain types.
// Mirrors dev guide § 3.7 (OPS) and § 4.2 (OperationStep record).
//
// Design constraints (dev guide § 3.7):
//   - Every step carries expectedBefore + desiredAfter so the executor
//     can re-validate the live browser state before each write.
//   - inverseOperation is a "best-effort" undo; compensation does NOT
//     guarantee the original browserId or timestamps are recovered.
//   - Plans are immutable once approved. Re-execution requires a new plan
//     and a new approval token.

export type OperationAction = 'create' | 'update' | 'move' | 'rename' | 'delete';

export type PlanStatus =
  | 'draft'
  | 'validated'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'compensated'
  | 'skipped';

/**
 * Risk level for a single step. The UI uses this to require additional
 * confirmation for high-risk operations (dev guide § 3.7 — "高风险
 * 批量删除二次确认").
 */
export type RiskLevel = 'low' | 'medium' | 'high';

export interface OperationStep {
  /** Stable, app-scoped id (uuid v4). */
  id: string;
  /** Plan this step belongs to. */
  planId: string;
  /**
   * Execution order within the plan. Steps are applied in ascending
   * order; ties are resolved by id lexicographically.
   */
  order: number;
  action: OperationAction;
  /**
   * chrome.bookmarks id of the node this step targets, when applicable.
   * For 'create' this is null.
   */
  targetBrowserId: string | null;
  /**
   * Bookmarks.create() requires a parentId. For 'create' this is the
   * folder that will contain the new node.
   */
  parentBrowserId: string | null;
  /**
   * Expected state of the target at the moment of execution. The
   * executor re-queries the live tree and compares this snapshot; on
   * mismatch the step is failed (dev guide BM / OPS "执行前重新查询").
   */
  expectedBefore: Record<string, unknown>;
  /**
   * Fields to set on success. For 'delete' this is empty.
   */
  desiredAfter: Record<string, unknown>;
  /** Human-readable explanation surfaced in the UI. */
  reason: string;
  /** Risk level driving UI confirmation. */
  riskLevel: RiskLevel;
  /**
   * Steps that must be applied before this one. Used for renames
   * that depend on a folder being created first, etc.
   */
  dependsOn: string[];
  /** Status tracking (dev guide § 4.2). */
  status: StepStatus;
  /**
   * If this step failed and was compensated, this is the id of the
   * inverse step (or null if no compensation was possible).
   */
  inverseOfId: string | null;
  /**
   * Free-form error message captured on failure. Never shown to the
   * user verbatim — surfaced via the UI's error mapping.
   */
  errorMessage: string | null;
  /**
   * Evidence: which check produced the expectedBefore snapshot. E.g.
   * "sync.generation=12; verified against chrome.bookmarks.get(b123)".
   */
  evidence: string[];
}

export interface OperationPlan {
  id: string;
  /** Plan title shown in the UI. */
  title: string;
  /** Human-readable description. */
  description: string;
  /** When the plan was first drafted. */
  createdAt: number;
  /** When the user approved the plan (null if still draft). */
  approvedAt: number | null;
  /** The syncGeneration this plan was computed against. */
  basedOnGeneration: number;
  /** All steps in execution order. */
  steps: OperationStep[];
  /** Plan status. */
  status: PlanStatus;
  /**
   * Free-form metadata for the UI (e.g. "import-source-file: backup-2024.json").
   * Never trusted as input — only echoed.
   */
  metadata: Record<string, string>;
}

/**
 * Approval record. Issued by the UI on a real user click, validated by
 * the executor before any step is applied. Dev guide § 3.6 / § 3.7:
 * "Token 由本地 UI 的真实确认动作签发，模型不能生成".
 */
export interface Approval {
  /** Approval token id (uuid v4). Single-use. */
  token: string;
  /** Plan this token approves. */
  planId: string;
  /** When the user clicked Approve. */
  issuedAt: number;
  /** How long the token is valid (ms). */
  ttlMs: number;
  /**
   * One-time secret the user must type / re-confirm for high-risk
   * plans. Stored hashed, never in plaintext. The executor compares
   * the live browser state against the plan's basedOnGeneration
   * and the hash of this secret.
   */
  confirmationHash: string | null;
  /** Audit trail: which UI component issued this. */
  issuedBy: string;
}

/**
 * Snapshot of the bookmarks tree at a point in time. Used for undo /
 * recovery. Dev guide § 3.7 "删除/移动前创建恢复快照".
 */
export interface TreeSnapshot {
  id: string;
  /** Plan that triggered the snapshot (null for ad-hoc snapshots). */
  planId: string | null;
  createdAt: number;
  /** syncGeneration at the time of the snapshot. */
  syncGeneration: number;
  /** Snapshot of the native tree (chrome.bookmarks.getTree shape). */
  tree: unknown;
  /** Snapshot of the local index (Dexie shape). */
  localIndex: { bookmarks: unknown[]; folders: unknown[] };
  /**
   * What the snapshot was taken for, e.g. "before plan <id> execution"
   * or "before delete <browserId>".
   */
  reason: string;
}

/**
 * Per-step audit row. Stored separately so it cannot be wiped by an
 * ordinary sync (dev guide § 4.2 "操作日志不可被普通同步清理").
 */
export interface OperationAuditEntry {
  id: string;
  planId: string;
  stepId: string;
  action: OperationAction;
  targetBrowserId: string | null;
  status: StepStatus;
  message: string;
  recordedAt: number;
}
