import { describe, expect, it } from 'vitest';
import { buildFolderTree, safeBookmarkHref, initialSearch, canExecuteReviewedPlan, selectedOrigins, organizationSteps, describePlanStep, actionLabel, riskLabel, planStatusLabel, stepErrorLabel, stepStatusLabel } from '../../entrypoints/options/workspace-helpers';
import type { FolderRecord } from '../../src/domain/bookmarks/types';
const folder = (id:string,parentId:string|null,index=0):FolderRecord => ({id,browserId:id,parentId,index,title:id,path:'untrusted cached path',updatedAt:0,syncGeneration:0});
describe('workspace presentation boundaries', () => {
  it('uses native parent ids and native sibling order', () => { const tree=buildFolderTree([folder('b','root',2),folder('root',null),folder('a','root',1)]); expect(tree[0].children.map(n=>n.id)).toEqual(['a','b']); });
  it('keeps orphan and cyclic folders visible without recursive cycles', () => { expect(buildFolderTree([folder('a','b'),folder('b','a'),folder('c','missing')]).map(n=>n.id)).toEqual(['a','b','c']); });
  it('opens only http(s), preserving the original address exactly', () => { const url='https://example.org/a?b=2&a=1#frag'; expect(safeBookmarkHref(url)).toBe(url); for(const unsafe of ['javascript:alert(1)','file:///a','data:text/html,hi','invalid']) expect(safeBookmarkHref(unsafe)).toBeUndefined(); });
  it('reads popup search without interpreting markup', () => {expect(initialSearch('?q=%3Cscript%3E')).toBe('<script>'); expect(initialSearch('')).toBe('');});
});

describe('workspace write gates and origin permissions', () => {
  const ready = {status:'validated',stepCount:1,applied:false,backedUp:true,reviewed:true,hasDeletes:false,deleteConfirmation:'',busy:false};
  it('requires both downloaded backup acknowledgement and reviewed plan',()=>{
    expect(canExecuteReviewedPlan(ready)).toBe(true);
    expect(canExecuteReviewedPlan({...ready,backedUp:false})).toBe(false);
    expect(canExecuteReviewedPlan({...ready,reviewed:false})).toBe(false);
  });
  it('blocks repeated execution, in-flight actions, empty plans, and historical plans',()=>{
    for(const status of ['approved','executing','completed','partially_completed','failed','cancelled']) expect(canExecuteReviewedPlan({...ready,status})).toBe(false);
    expect(canExecuteReviewedPlan({...ready,applied:true})).toBe(false);
    expect(canExecuteReviewedPlan({...ready,busy:true})).toBe(false);
    expect(canExecuteReviewedPlan({...ready,stepCount:0})).toBe(false);
  });
  it('requires explicit typed deletion confirmation',()=>{
    expect(canExecuteReviewedPlan({...ready,hasDeletes:true})).toBe(false);
    expect(canExecuteReviewedPlan({...ready,hasDeletes:true,deleteConfirmation:'删除'})).toBe(true);
    expect(canExecuteReviewedPlan({...ready,hasDeletes:true,deleteConfirmation:'delete'})).toBe(false);
  });
  it('deduplicates only exact selected HTTP(S) origins',()=>{
    expect(selectedOrigins(['https://example.com/a','https://example.com/b','https://docs.example.com/','http://example.com/','javascript:alert(1)',undefined])).toEqual(['https://example.com/*','https://docs.example.com/*','http://example.com/*']);
  });
});

describe('reviewed organization translation',()=>{
  const folders=[{proposalId:'new:used',title:'Vue 学习',parentFolderId:'root'},{proposalId:'new:unused',title:'Unused',parentFolderId:'root'}];
  const moves=[{bookmarkId:'a',targetFolderId:'new:used',reason:'Vue'},{bookmarkId:'b',targetFolderId:'existing',reason:'Existing'}];
  it('creates only selected moves destination folders and links by step index',()=>{
    const steps=organizationSteps(moves,folders,['a','b']);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({action:'create',parentBrowserId:'root',desiredAfter:{title:'Vue 学习'}});
    expect(steps[1]).toMatchObject({action:'move',targetBrowserId:'a',parentStepIndex:0});
    expect(steps[1].parentBrowserId).toBeUndefined();
    expect(steps[2]).toMatchObject({parentBrowserId:'existing'});
  });
  it('unchecked suggestions cannot write or create unused folders',()=>{
    expect(organizationSteps(moves,folders,[])).toEqual([]);
    expect(organizationSteps(moves,folders,['b'])).toHaveLength(1);
  });
  it('rejects missing temporary folder references',()=>{expect(()=>organizationSteps(moves,[],['a'])).toThrow('新目录不存在');});
});

describe('human-readable plan labels',()=>{
  it('uses Chinese action, risk and status labels',()=>{expect(actionLabel('delete')).toBe('删除');expect(actionLabel('create')).toBe('新建');expect(riskLabel('high')).toBe('高风险');expect(planStatusLabel('partially_completed')).toBe('部分完成');});
  it('resolves original URL and proposed folder destination for review',()=>{
    const create={id:'create-step',action:'create',parentBrowserId:'root',desiredAfter:{title:'Vue'}} as unknown as import('../../src/domain/operations/types').OperationStep;
    const move={id:'move-step',action:'move',riskLevel:'medium',targetBrowserId:'b',parentStepId:'create-step',expectedBefore:{title:'Learn Vue',url:'https://vuejs.org/?a=1#x',parentId:'root'},desiredAfter:{}} as unknown as import('../../src/domain/operations/types').OperationStep;
    const view=describePlanStep(move,[create,move],[folder('root',null)],[]);
    expect(view.sourceTitle).toBe('Learn Vue');expect(view.sourceUrl).toBe('https://vuejs.org/?a=1#x');expect(view.targetPath).toContain('Vue（新建）');expect(view.action).toBe('移动');expect(view.risk).toBe('中风险');
  });
});

it('shows safe execution failure explanations without echoing arbitrary secrets',()=>{
  expect(stepStatusLabel('compensated')).toBe('已补偿');
  expect(stepErrorLabel('Error secret-token https://private.example/?key=123')).not.toContain('secret-token');
  expect(stepErrorLabel('compensation failed: secret')).toContain('自动补偿也未完成');
  expect(stepErrorLabel('skipped due to earlier failure')).toContain('前面的步骤失败');
  expect(stepErrorLabel(null)).toBe('');
});
