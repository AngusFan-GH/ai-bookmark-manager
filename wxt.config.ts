import { defineConfig, defineWebExtConfig } from 'wxt';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  modules: [],
  vite: () => ({ plugins: [vue()] }),
  // Why `webExt`:
  //   WXT's `wxt dev` (and `wxt`) auto-launches a fresh Chromium via
  //   `web-ext-run`. That browser is created with a TEMPORARY, isolated
  //   profile in /var/folders/.../tmp-web-ext--*/Default, so it has none of
  //   the developer's real bookmarks. We want the extension to read the
  //   developer's real Chrome profile, so we:
  //     1. pin the Chromium binary to the system Chrome (instead of letting
  //        web-ext-run hunt for one), and
  //     2. leave the profile to web-ext-run's temp one — the user should
  //        close that auto-opened window and load the unpacked extension
  //        from `.output/chrome-mv3-dev/` in their NORMAL Chrome via
  //        chrome://extensions (where their real bookmarks live).
  //
  //   We tried `.webextrc` `disabled: true` — that flag only affects WXT's
  //   help-text "canReopenBrowser" hint; it does not skip the auto-open
  //   call. WXT 0.20 has no CLI flag to skip it either. The accepted dev
  //   workflow is therefore: let the temp browser open, close it, load the
  //   extension in the developer's normal Chrome.
  webExt: defineWebExtConfig({
    binaries: {
      chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
  }),
  manifest: {
    name: 'AI Bookmark Manager',
    description: 'Local-first bookmark manager with safe indexing and JSON backup',
    version: '0.1.0',
    permissions: ['bookmarks', 'storage'],
    action: { default_title: 'AI Bookmark Manager' },
    // `commands` here augments WXT's defaults. We want the user to be
    // able to jump to the link-health tab with a single keyboard
    // shortcut. Alt+H is the proposed default (Alt+R is reserved by
    // WXT for "reload extension during development").
    commands: {
      'open-link-health': {
        suggested_key: { default: 'Alt+H' },
        description: 'Open link-health view',
      },
    },
  },
});
