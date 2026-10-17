import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { BookmarkRecord } from './domain/bookmarks/types';
import { findExistingBookmarks } from './workspace-client';

/** Local-only membership lookup. An unknown answer must never authorize AI. */
export function useCaptureStatus(getUrl: () => string, isActive: () => boolean = () => true) {
  const bookmarks = ref<BookmarkRecord[]>([]);
  const state = ref<'idle'|'checking'|'ready'|'error'>('idle');
  let sequence = 0;
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  async function check() {
    clearTimeout(refreshTimer);
    const current = ++sequence;
    const url = getUrl().trim();
    bookmarks.value = [];
    state.value = 'idle';
    if (!isActive() || !/^https?:\/\//i.test(url)) return;
    state.value = 'checking';
    try {
      const result = await findExistingBookmarks(url);
      if (disposed || current !== sequence || url !== getUrl().trim() || !isActive()) return;
      bookmarks.value = result.bookmarks;
      state.value = 'ready';
    } catch {
      if (!disposed && current === sequence) state.value = 'error';
    }
  }
  watch([getUrl, isActive], () => { void check(); }, { immediate:true, flush:'sync' });
  // Native changes can occur while this form remains open. Invalidate first,
  // then coalesce import/move bursts into one fresh local read.
  const nativeEvents = typeof chrome === 'undefined' ? [] : [
    chrome.bookmarks?.onCreated, chrome.bookmarks?.onChanged,
    chrome.bookmarks?.onRemoved, chrome.bookmarks?.onMoved,
  ].filter(Boolean);
  function refreshAfterChange() {
    if (!isActive() || !/^https?:\/\//i.test(getUrl().trim())) return;
    ++sequence;
    state.value = 'checking';
    bookmarks.value = [];
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void check(); }, 150);
  }
  for (const event of nativeEvents) event?.addListener(refreshAfterChange);
  onBeforeUnmount(() => {
    disposed = true; ++sequence; clearTimeout(refreshTimer);
    for (const event of nativeEvents) event?.removeListener(refreshAfterChange);
  });
  const unsaved = computed(() => state.value === 'ready' && bookmarks.value.length === 0);
  return { bookmarks, state, unsaved, check };
}
