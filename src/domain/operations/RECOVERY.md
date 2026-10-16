# Targeted recovery contract

`PlanService.draftRecovery(sourcePlanId)` creates a new draft, never writes native bookmarks, and requires the ordinary review and single-use approval flow. It inverts only succeeded, uncompensated steps. Execution takes another durable tree/local-index backup before writing.

- Durable before/after step evidence and the execution-time snapshot are required. Older plans without evidence cannot be safely recovered automatically.
- Update/rename restore only fields changed by that step. Moves restore the original parent and recorded position. Created nodes are removed by their exact assigned native ID, with empty-only folder deletion.
- Deleted nodes are recreated using new native IDs. Parent create-step references map nested descendants to those new IDs. Original IDs and timestamps cannot be restored.
- Later unrelated bookmarks remain untouched. A changed target, missing parent, uncertain interrupted write, or externally added child blocks automatic recovery. Position changes block move recovery.
- Repeated requests return the same pending recovery draft. Once that recovery has been attempted, another recovery of the source is blocked, including after partial failure. Inspect the audit and download backups before manual recovery; silently repeating restoration could duplicate nodes.
- Recovery plans cannot themselves be automatically recovered. Recovery is a reviewed compensation, not a whole-library reset.
- A storage interruption while reserving a recovery may leave it blocked without a usable draft. This deliberately favors avoiding duplicate restoration over automatic retries.
- Expired approval tokens are never reused. Regular organization plans can be drafted again from fresh live state. A reserved recovery with an expired approval requires inspection rather than creating an unlinked duplicate.

Organization deletion is empty-folder-only by default. To remove a nonempty folder, explicitly include all its descendants in child-first order in the reviewed plan; there is no hidden subtree deletion. Nested creation accepts `parentStepIndex` referencing an earlier folder creation.
