import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    // We run all .test.ts files inside tests/, including the legacy
    // tests/normalize.test.ts and the new tests/integration/* suites.
    include: ['tests/**/*.test.ts'],
    // Dexie needs a window-like environment. happy-dom gives us
    // localStorage, fetch, etc. without pulling in jsdom, but does NOT
    // ship an indexedDB shim — we inject fake-indexeddb in setup.ts
    // (see below) so Dexie works under Node.
    environment: 'happy-dom',
    setupFiles: ['tests/setup.ts'],
    // Reasonable timeout for the 10k-bookmark test on slow CI.
    testTimeout: 10_000,
  },
});
