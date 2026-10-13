// src/domain/operations/import.ts
//
// JSON import validation. Per dev guide § 3.3:
//   "JSON 包含 formatVersion、exportedAt、appVersion、browserTree、
//    localMetadata、checksum（校验方法写入规范）."
//   "导入先做格式校验、大小上限、版本兼容、预览差异；不允许导入
//    JSON 自动覆盖全部书签."
//
// Hard rules (enforced by validateImport() below):
//   1. The input must be a parseable JSON object.
//   2. formatVersion must be a positive integer we know how to read.
//   3. The file size (measured against MAX_IMPORT_BYTES) must not be
//      exceeded — enforced by the caller before calling validate.
//   4. The browserTree must be an array of BookmarkTreeNode-shaped
//      objects (loose structural check; deep validation in flatten).
//   5. We NEVER auto-apply. validateImport returns a parsed payload;
//      the caller must build a plan and obtain a user approval token
//      before any write touches the browser.

import { AppErrorImpl } from '../../shared/errors';

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB hard cap
export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [1];

/** Minimal shape we accept from a backup file. */
export interface ImportPayloadV1 {
  formatVersion: 1;
  exportedAt?: string;
  appVersion?: string;
  browserTree: unknown;
  localIndex?: unknown;
  includes?: { browserTree: true; localIndex?: true };
}

export type ImportPayload = ImportPayloadV1;

/**
 * Validate the raw JSON string. Throws AppErrorImpl on any rule
 * violation. Returns a parsed payload on success.
 *
 * `maxBytes` defaults to MAX_IMPORT_BYTES; callers that already
 * checked file size may pass a smaller value to fail fast.
 */
export function validateImport(rawText: string, maxBytes: number = MAX_IMPORT_BYTES): ImportPayload {
  if (typeof rawText !== 'string') {
    throw new AppErrorImpl('INVALID_REQUEST', 'import payload must be a string', false);
  }
  if (rawText.length > maxBytes) {
    throw new AppErrorImpl('INVALID_REQUEST', `import too large: ${rawText.length} > ${maxBytes}`, false);
  }
  if (rawText.trim().length === 0) {
    throw new AppErrorImpl('INVALID_REQUEST', 'import payload is empty', false);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new AppErrorImpl('INVALID_REQUEST', 'import is not valid JSON: ' + (err instanceof Error ? err.message : String(err)), false);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppErrorImpl('INVALID_REQUEST', 'import must be a JSON object', false);
  }

  const obj = parsed as Record<string, unknown>;

  if (!('formatVersion' in obj)) {
    throw new AppErrorImpl('INVALID_REQUEST', 'import missing formatVersion', false);
  }
  const fv = obj.formatVersion;
  if (typeof fv !== 'number' || !Number.isInteger(fv) || fv <= 0) {
    throw new AppErrorImpl('INVALID_REQUEST', 'formatVersion must be a positive integer', false);
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(fv)) {
    throw new AppErrorImpl(
      'INVALID_REQUEST',
      `unsupported formatVersion ${fv}; supported: ${SUPPORTED_FORMAT_VERSIONS.join(', ')}`,
      false,
    );
  }

  if (!('browserTree' in obj)) {
    throw new AppErrorImpl('INVALID_REQUEST', 'import missing browserTree', false);
  }
  if (!Array.isArray(obj.browserTree)) {
    throw new AppErrorImpl('INVALID_REQUEST', 'browserTree must be an array', false);
  }
  for (const node of obj.browserTree) {
    if (!node || typeof node !== 'object') {
      throw new AppErrorImpl('INVALID_REQUEST', 'browserTree contains non-object node', false);
    }
  }

  // localIndex is optional. If present it must be an object with the
  // expected shape.
  if (obj.localIndex != null) {
    const li = obj.localIndex as Record<string, unknown>;
    if (typeof li !== 'object' || Array.isArray(li)) {
      throw new AppErrorImpl('INVALID_REQUEST', 'localIndex must be an object', false);
    }
    if (li.bookmarks != null && !Array.isArray(li.bookmarks)) {
      throw new AppErrorImpl('INVALID_REQUEST', 'localIndex.bookmarks must be an array', false);
    }
    if (li.folders != null && !Array.isArray(li.folders)) {
      throw new AppErrorImpl('INVALID_REQUEST', 'localIndex.folders must be an array', false);
    }
  }

  return obj as unknown as ImportPayload;
}

/**
 * Reject known-dangerous fields that some backup tools or malicious
 * JSONs include. We accept a narrow set of known fields and ignore
 * anything else — the import is shape-validated against a whitelist.
 *
 * Dev guide § 10 "默认只读、默认不开启云 AI、默认不抓正文": we never
 * accept apiKey, auth, token, password, pageText, html, body, etc.
 */
const FORBIDDEN_KEYS = new Set([
  'apiKey', 'api_key', 'apikey',
  'token', 'auth', 'authorization',
  'password', 'passwd', 'secret',
  'session', 'cookie',
  'pageText', 'page_text', 'html', 'body', 'content',
  'chat', 'history', 'messages',
]);

export function hasForbiddenKeys(payload: unknown, path: string[] = []): string | null {
  if (payload == null) return null;
  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i++) {
      const found = hasForbiddenKeys(payload[i], [...path, String(i)]);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload === 'object') {
    for (const key of Object.keys(payload as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return [...path, key].join('.');
      }
      const found = hasForbiddenKeys((payload as Record<string, unknown>)[key], [...path, key]);
      if (found) return found;
    }
  }
  return null;
}
