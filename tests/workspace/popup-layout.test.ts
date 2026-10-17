import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const documentCss = readFileSync('entrypoints/popup/popup.css', 'utf8');
const entrypoint = readFileSync('entrypoints/popup/main.ts', 'utf8');
const component = readFileSync('entrypoints/popup/App.vue', 'utf8');

// happy-dom does not implement browser layout. This guards the intrinsic-width
// contract; native Chrome dimensions and text geometry belong in browser-smoke.
describe('native popup intrinsic width contract', () => {
  it('anchors the document width before mount instead of capping it to the initial viewport', () => {
    expect(entrypoint.indexOf("import './popup.css'")).toBeGreaterThan(-1);
    expect(entrypoint.indexOf("import './popup.css'")).toBeLessThan(entrypoint.indexOf('createApp(App)'));
    const body = document.createElement('div').style;
    body.cssText = documentCss.match(/body\s*\{([^}]+)\}/)![1];
    expect(body.width).toBe('380px');
    expect(parseFloat(body.margin)).toBe(0);
    expect(body.boxSizing).toBe('border-box');
    const app = document.createElement('div').style;
    app.cssText = documentCss.match(/#app\s*\{([^}]+)\}/)![1];
    expect(app.width).toBe('100%');
    expect(parseFloat(app.minWidth)).toBe(0);
    expect(documentCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\d(?:vw|vi|dvw|svw|lvw)\b/);
  });

  it('keeps the padded content inside its document width without a viewport-dependent cap', () => {
    const popup = component.match(/\.popup\{([^}]+)\}/)![1];
    expect(popup).toContain('width:100%');
    expect(popup).toContain('box-sizing:border-box');
    expect(popup).not.toMatch(/max-width|\d(?:vw|vi|dvw|svw|lvw)\b/);
  });
});
