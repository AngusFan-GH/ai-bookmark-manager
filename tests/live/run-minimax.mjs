import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
try {
  const bundlePath = join(process.env.RUNNER_TEMP || tmpdir(), 'bookmark-minimax-live.mjs');
  if (process.argv.includes('--build')) {
    // A separate step without the secret: esbuild's helper never inherits it.
    const { build } = await import('esbuild');
    await build({ entryPoints: ['tests/live/minimax-acceptance.ts'], bundle: true, outfile: bundlePath, format: 'esm', platform: 'node', logLevel: 'silent' });
  } else {
    const { liveGate, runLiveAcceptance } = await import(pathToFileURL(bundlePath).href);
    if (!liveGate(process.env)) throw new Error();
    const apiKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    if (!apiKey?.trim()) throw new Error();
    const report = await runLiveAcceptance(apiKey);
    const sanitized = JSON.stringify(report, null, 2);
    console.log(sanitized);
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `MiniMax synthetic live acceptance\n\n${sanitized}\n`, { flag: 'a' });
    process.exitCode = report.passed ? 0 : 1;
  }
} catch {
  // Never print thrown errors, source-map dumps, request objects or environment.
  console.error('MiniMax live acceptance could not start or report safely. Check the explicit gate, secret presence, and build setup.');
  process.exitCode = 1;
}
