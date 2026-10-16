import { describe, expect, it } from 'vitest';
import { buildFolderTree, safeBookmarkHref, initialSearch, canExecuteReviewedPlan, selectedOrigins, organizationSteps, describePlanStep, actionLabel, riskLabel, planStatusLabel, stepErrorLabel, stepStatusLabel, hasPlanExecutionResult, folderDisplayPath, duplicateDeleteSteps, contentResultLabel, workspaceErrorLabel } from '../../entrypoints/options/workspace-helpers';
import { flattenTree } from '../../src/domain/bookmarks/normalize';
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
  it('requires both verified backup evidence and explicit plan review',()=>{
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

describe('plan-bound execution completion',()=>{
  it('keeps completion after refreshing the same plan object and blocks replay',()=>{
    const executed=new Set(['applied-plan']);
    const beforeRefresh={id:'applied-plan',status:'validated'};
    const afterRefresh={id:'applied-plan',status:'completed'};
    expect(hasPlanExecutionResult(beforeRefresh,executed)).toBe(true);
    expect(hasPlanExecutionResult({...afterRefresh},executed)).toBe(true);
    expect(canExecuteReviewedPlan({status:beforeRefresh.status,stepCount:1,applied:hasPlanExecutionResult(beforeRefresh,executed),backedUp:true,reviewed:true,hasDeletes:false,deleteConfirmation:'',busy:false})).toBe(false);
  });
  it('does not transfer completion to another draft and remembers a revisited plan',()=>{
    const executed=new Set(['first']);
    expect(hasPlanExecutionResult({id:'second',status:'validated'},executed)).toBe(false);
    expect(hasPlanExecutionResult(undefined,executed)).toBe(false);
    expect(hasPlanExecutionResult({id:'first',status:'validated'},executed)).toBe(true);
  });
  it('recognizes terminal history results without local execution state',()=>{
    for(const status of ['completed','partially_completed','failed']) expect(hasPlanExecutionResult({id:'history',status},new Set())).toBe(true);
    for(const status of ['draft','validated','approved','executing','cancelled']) expect(hasPlanExecutionResult({id:'other',status},new Set())).toBe(false);
  });
});

describe('normalized folder display paths',()=>{
  it('does not append a folder title already present in normalized paths',()=>{
    const {folders}=flattenTree([{id:'0',title:'',children:[{id:'1',parentId:'0',title:'Bookmarks bar',children:[{id:'2',parentId:'1',title:'Synthetic Target',children:[]}]}]}],{now:1,generation:1});
    const target=folders.find(f=>f.id==='2')!;
    expect(target.path).toBe('Bookmarks bar / Synthetic Target');
    expect(folderDisplayPath(target)).toBe('Bookmarks bar / Synthetic Target');
    const create={id:'new-folder',action:'create',riskLevel:'low',parentBrowserId:'2',expectedBefore:{},desiredAfter:{title:'Synthetic AI Folder'}} as unknown as import('../../src/domain/operations/types').OperationStep;
    const move={id:'move',action:'move',riskLevel:'medium',parentStepId:'new-folder',expectedBefore:{title:'Source',parentId:'1'},desiredAfter:{}} as unknown as import('../../src/domain/operations/types').OperationStep;
    expect(describePlanStep(create,[create,move],folders,[]).targetPath).toBe('Bookmarks bar / Synthetic Target / Synthetic AI Folder');
    expect(describePlanStep(move,[create,move],folders,[]).targetPath).toBe('Bookmarks bar / Synthetic Target / Synthetic AI Folder（新建）');
  });
  it('falls back only when a normalized path is empty or unavailable',()=>{
    expect(folderDisplayPath({path:'',title:'Bookmarks bar'})).toBe('Bookmarks bar');
    expect(folderDisplayPath({path:'',title:''})).toBe('根目录');
    expect(folderDisplayPath(undefined)).toBe('目录名称不可用');
  });
});


describe('exact duplicate cleanup selection',()=>{
  const groups=[{bookmarks:[{id:'a',browserId:'native-a'},{id:'b',browserId:'native-b'}]},{bookmarks:[{id:'c',browserId:'native-c'},{id:'d',browserId:'native-d'}]}];
  it('requires explicit choices and preserves at least one original in each group',()=>{
    expect(()=>duplicateDeleteSteps(groups,[])).toThrow('先选择');
    expect(()=>duplicateDeleteSteps(groups,['a','b'])).toThrow('至少需要保留');
    expect(()=>duplicateDeleteSteps(groups,['c','d'])).toThrow('至少需要保留');
  });
  it('previews only selected native records without relying on display names',()=>{
    expect(duplicateDeleteSteps(groups,['b','c']).map(step=>[step.action,step.targetBrowserId])).toEqual([['delete','native-b'],['delete','native-c']]);
    expect(duplicateDeleteSteps(groups,['a','a'])).toHaveLength(1);
  });
  it('rejects stale or out-of-scope selections',()=>{expect(()=>duplicateDeleteSteps(groups,['unknown'])).toThrow('重新检查');});
});
describe('safe readable content feedback',()=>{
  it('translates every content outcome without leaking arbitrary provider errors',()=>{
    expect(contentResultLabel('ready')).toContain('已提取');
    expect(contentResultLabel('login_required')).toContain('需要登录');
    expect(contentResultLabel('unsupported')).toContain('不支持');
    expect(contentResultLabel('unavailable','Host permission not granted')).toContain('权限');
    expect(contentResultLabel('unavailable','Request timed out')).toContain('超时');
    expect(contentResultLabel('unavailable','secret-token https://private.test/?key=secret')).not.toContain('secret');
  });
  it('never repeats raw remote exception messages',()=>{
    for(const error of [new Error('sk-secret https://private.test'),new Error('API key sk-secret rejected'),new Error('permission https://private.test?token=secret')]){
      expect(workspaceErrorLabel(error)).not.toContain('secret');expect(workspaceErrorLabel(error)).not.toContain('https://');
    }
  });
});


it('validates edited AI folder names only when their moves are selected',()=>{
 const moves=[{bookmarkId:'a',targetFolderId:'new:folder',reason:'Selected move'}];const folders=[{proposalId:'new:folder',title:'   ',parentFolderId:'bar'}];
 expect(organizationSteps(moves,folders,[])).toEqual([]);
 expect(()=>organizationSteps(moves,folders,['a'])).toThrow('名称不能为空');
 expect(organizationSteps(moves,[{...folders[0],title:'  Learning  '}],['a'])[0].desiredAfter?.title).toBe('Learning');
});
it('shows new bookmarks in their parent folder without appending the bookmark title as a directory',()=>{
 const step={id:'create',action:'create',riskLevel:'low',parentBrowserId:'bar',expectedBefore:{},desiredAfter:{title:'Learn Vue',url:'https://vuejs.org/?original=YES#intro'}} as unknown as import('../../src/domain/operations/types').OperationStep;
 const view=describePlanStep(step,[step],[{...folder('bar',null),path:'Bookmarks bar'}],[]);
 expect(view.targetPath).toBe('Bookmarks bar');expect(view.targetTitle).toBe('Learn Vue');expect(view.targetUrl).toBe('https://vuejs.org/?original=YES#intro');
});

it('keeps the captured source directory after live records move to their new location',()=>{
 const step={id:'moved',action:'move',riskLevel:'medium',targetBrowserId:'bookmark',parentBrowserId:'destination',expectedBefore:{title:'Original title',url:'https://example.test/original',parentId:'source'},desiredAfter:{}} as unknown as import('../../src/domain/operations/types').OperationStep;
 const folders=[{...folder('source',null),path:'Source / Nested'},{...folder('destination',null),path:'Destination'}];
 const current=[{id:'bookmark',title:'Current title',url:'https://example.test/current',path:'Destination'}];
 expect(describePlanStep(step,[step],folders,current)).toMatchObject({sourceTitle:'Original title',sourceUrl:'https://example.test/original',sourcePath:'Source / Nested',targetPath:'Destination'});
});
