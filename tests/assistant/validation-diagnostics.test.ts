import { describe, expect, it } from 'vitest';
import { AssistantError } from '../../src/domain/assistant/types';
import { parseSuggestion, SUGGESTION_VALIDATION_REASONS, SuggestionValidationError, type SuggestionValidationReason } from '../../src/domain/assistant/validation';

const base = { text: 'Safe', references: [], folders: [], moves: [], edits: [], deletions: [] };
const reference = { bookmarkId: 'b', reason: 'Reason' };
const folder = { proposalId: 'new:f', title: 'Folder', parentFolderId: 'f' };
const move = { bookmarkId: 'b', targetFolderId: 'f', reason: 'Reason' };
const edit = { bookmarkId: 'b', title: 'Title', reason: 'Reason' };
const deletion = { bookmarkId: 'b', reason: 'Reason' };
const cases: [SuggestionValidationReason, unknown][] = [
  ['root-schema', { ...base, extra: 'private' }],
  ['reference-schema', { ...base, references: [{ ...reference, extra: 'private' }] }],
  ['reference-id', { ...base, references: [{ ...reference, bookmarkId: 'private' }] }],
  ['duplicate-reference', { ...base, references: [reference, reference] }],
  ['folder-schema', { ...base, folders: [{ ...folder, title: '/' }] }],
  ['folder-id', { ...base, folders: [{ ...folder, parentFolderId: 'private' }] }],
  ['duplicate-folder', { ...base, folders: [folder, folder] }],
  ['move-schema', { ...base, moves: [{ ...move, reason: '' }] }],
  ['move-bookmark-id', { ...base, moves: [{ ...move, bookmarkId: 'private' }] }],
  ['move-target-id', { ...base, moves: [{ ...move, targetFolderId: 'private' }] }],
  ['duplicate-action', { ...base, moves: [move], edits: [edit] }],
  ['edit-schema', { ...base, edits: [{ ...edit, title: '' }] }],
  ['edit-bookmark-id', { ...base, edits: [{ ...edit, bookmarkId: 'private' }] }],
  ['deletion-schema', { ...base, deletions: [{ ...deletion, reason: '' }] }],
  ['deletion-bookmark-id', { ...base, deletions: [{ ...deletion, bookmarkId: 'private' }] }],
  ['empty-result', { ...base, text: '' }],
];
function check(content: string, reason: SuggestionValidationReason, mode: 'assist' | 'recommend' = 'assist') {
  let caught: unknown;
  try { parseSuggestion(content, mode, new Set(['b']), new Set(['f'])); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AssistantError);
  expect(caught).toBeInstanceOf(SuggestionValidationError);
  expect(caught).toMatchObject({ code: 'validation', validationReason: reason });
  expect((caught as Error).message).not.toContain('private');
}
describe('fixed suggestion validation diagnostics', () => {
  it.each(cases)('classifies %s without reflecting model data', (reason, value) => check(JSON.stringify(value), reason));
  it('classifies syntax, incomplete thinking, limits and read-only actions', () => {
    check('private', 'invalid-json');
    check('<think>private', 'incomplete-thinking');
    check('x'.repeat(100001), 'response-limit');
    check(JSON.stringify({ ...base, moves: [move] }), 'read-only-action', 'recommend');
  });
  it('covers every fixed reason and preserves valid organization', () => {
    expect(new Set([...cases.map(([reason]) => reason), 'invalid-json', 'incomplete-thinking', 'response-limit', 'read-only-action'])).toEqual(new Set(SUGGESTION_VALIDATION_REASONS));
    expect(parseSuggestion(JSON.stringify({ ...base, moves: [move] }), 'organize', new Set(['b']), new Set(['f']))).toEqual({ ...base, moves: [move] });
  });
});
