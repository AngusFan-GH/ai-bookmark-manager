// src/db.ts
//
// Backward-compatible re-export. Phase 1 moved the schema into
// `src/infrastructure/database/db.ts`. Old imports keep working.

export { db, readSyncState, writeSyncState } from './infrastructure/database/db';
