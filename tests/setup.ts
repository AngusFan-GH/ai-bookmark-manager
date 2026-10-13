// tests/setup.ts
//
// Vitest setup: polyfill indexedDB so Dexie works under Node + happy-dom.
// happy-dom v15 does not include an indexedDB implementation, but
// fake-indexeddb is a drop-in shim for IDBFactory, IDBKeyRange, etc.

import 'fake-indexeddb/auto';
