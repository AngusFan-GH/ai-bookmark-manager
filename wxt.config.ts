import { defineConfig } from 'wxt';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  modules: [],
  vite: () => ({ plugins: [vue()] }),
  manifest: {
    name: 'AI Bookmark Manager',
    description: 'Local-first bookmark manager with safe indexing and JSON backup',
    version: '0.1.0',
    permissions: ['bookmarks', 'storage'],
    action: { default_title: 'AI Bookmark Manager' },
  },
});