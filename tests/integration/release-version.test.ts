// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps explicit extension manifest, package and lockfile release versions aligned', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const config = readFileSync('wxt.config.ts', 'utf8');
  expect(config.match(/\bversion:\s*'([^']+)'/)?.[1]).toBe(packageJson.version);
  expect(lock.version).toBe(packageJson.version);
  expect(lock.packages[''].version).toBe(packageJson.version);
});
