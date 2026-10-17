import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const component = readFileSync('entrypoints/options/App.vue', 'utf8');
const style = component.slice(component.indexOf('<style scoped>'));
const rule = (selector: string) => style.split(`${selector}{`)[1]?.split('}')[0];

// happy-dom cannot establish visual geometry. This protects the positioning
// contract; open-menu bounds and document overflow are checked in browser-smoke.
describe('workspace tools menu layout contract', () => {
  it('anchors the menu within a toolbar wide enough for both header layouts', () => {
    expect(rule('.header-actions')).toContain('position:relative');
    expect(rule('.header-actions')).toContain('min-width:min(180px,100%)');
    expect(rule('.utility-menu')).toContain('position:static');
    const menu = rule('.utility-actions');
    expect(menu).toContain('position:absolute');
    expect(menu).toContain('right:0');
    expect(menu).toContain('left:auto');
    expect(menu).toContain('width:180px');
    expect(menu).toContain('max-width:100%');
    expect(menu).toContain('min-width:0');
  });

  it('does not hide page overflow to mask an off-screen dropdown', () => {
    expect(rule('.workspace')).not.toMatch(/overflow(?:-x)?:hidden/);
    expect(rule(':global(body)')).not.toMatch(/overflow(?:-x)?:hidden/);
  });
});
