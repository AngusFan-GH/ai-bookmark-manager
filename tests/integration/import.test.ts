// tests/integration/import.test.ts
//
// JSON import validation tests. Per dev guide § 3.3 + § 10:
//   - Reject inputs larger than the hard cap
//   - Reject inputs that fail to parse as JSON
//   - Reject inputs missing formatVersion / browserTree
//   - Reject unknown formatVersion
//   - Reject known-dangerous fields (apiKey, token, etc.) — dev guide § 10

import { describe, expect, it } from 'vitest';
import { validateImport, hasForbiddenKeys, MAX_IMPORT_BYTES, SUPPORTED_FORMAT_VERSIONS } from '../../src/domain/operations/import';

const validV1 = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  formatVersion: 1,
  exportedAt: '2026-10-13T00:00:00.000Z',
  appVersion: '0.1.0',
  browserTree: [{ id: '0', title: '', children: [] }],
  ...overrides,
});

describe('validateImport', () => {
  it('accepts a minimal valid v1 payload', () => {
    const p = validateImport(validV1());
    expect(p.formatVersion).toBe(1);
    expect(p.browserTree).toBeInstanceOf(Array);
  });

  it('rejects a non-string input', () => {
    expect(() => validateImport(123 as unknown as string)).toThrow(/must be a string/);
  });

  it('rejects an empty input', () => {
    expect(() => validateImport('')).toThrow(/empty/);
  });

  it('rejects input larger than the cap', () => {
    const big = ' '.repeat(MAX_IMPORT_BYTES + 1);
    expect(() => validateImport(big)).toThrow(/too large/);
  });

  it('rejects non-JSON text', () => {
    expect(() => validateImport('not json')).toThrow(/not valid JSON/);
  });

  it('rejects a non-object JSON value', () => {
    expect(() => validateImport('[]')).toThrow(/JSON object/);
  });

  it('rejects a missing formatVersion', () => {
    const raw = JSON.stringify({ browserTree: [] });
    expect(() => validateImport(raw)).toThrow(/formatVersion/);
  });

  it('rejects an unknown formatVersion', () => {
    const raw = JSON.stringify({ formatVersion: 99, browserTree: [] });
    expect(() => validateImport(raw)).toThrow(/unsupported formatVersion 99/);
  });

  it('rejects a missing browserTree', () => {
    const raw = JSON.stringify({ formatVersion: 1 });
    expect(() => validateImport(raw)).toThrow(/browserTree/);
  });

  it('rejects a non-array browserTree', () => {
    const raw = JSON.stringify({ formatVersion: 1, browserTree: 'oops' });
    expect(() => validateImport(raw)).toThrow(/browserTree must be an array/);
  });

  it('rejects a non-object node inside browserTree', () => {
    const raw = JSON.stringify({ formatVersion: 1, browserTree: ['bad'] });
    expect(() => validateImport(raw)).toThrow(/non-object node/);
  });

  it('accepts a payload with localIndex (optional)', () => {
    const p = validateImport(validV1({ localIndex: { bookmarks: [], folders: [] } }));
    expect(p.localIndex).toBeDefined();
  });

  it('rejects a malformed localIndex', () => {
    expect(() => validateImport(validV1({ localIndex: 'nope' }))).toThrow(/localIndex must be an object/);
  });

  it('lists the supported format versions', () => {
    expect(SUPPORTED_FORMAT_VERSIONS).toEqual([1]);
  });
});

describe('hasForbiddenKeys', () => {
  it('returns null for a clean payload', () => {
    expect(hasForbiddenKeys({ formatVersion: 1, browserTree: [] })).toBeNull();
  });

  it('detects apiKey at the top level', () => {
    expect(hasForbiddenKeys({ formatVersion: 1, apiKey: 'sk-123' })).toBe('apiKey');
  });

  it('detects token nested in localIndex', () => {
    expect(hasForbiddenKeys({ localIndex: { token: 'secret' } })).toBe('localIndex.token');
  });

  it('detects pageText deep inside a tree', () => {
    const payload = { browserTree: [{ children: [{ pageText: 'leaked' }] }] };
    expect(hasForbiddenKeys(payload)).toBe('browserTree.0.children.0.pageText');
  });

  it('detects every key in the forbidden set', () => {
    for (const k of ['apiKey', 'token', 'auth', 'password', 'pageText', 'html', 'chat', 'messages']) {
      expect(hasForbiddenKeys({ [k]: 'x' })).toBe(k);
    }
  });
});
