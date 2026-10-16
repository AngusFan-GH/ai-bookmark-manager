/** Real Chromium extension acceptance; all bookmarks/profile/AI replies are synthetic.
 * Run after npm run build: node tests/e2e/browser-smoke.mjs
 * Requires playwright and its bundled Chromium (or CHROMIUM_PATH override).
 * The shipped build is copied to a temporary directory; only that copy gets a mock
 * fetch bootstrap and provider host permission. No real API or user key is used.
 */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd();
const temp = await mkdtemp(path.join(tmpdir(), 'bookmark-e2e-'));
const extension = path.join(temp, 'extension');
const artifactDir = process.env.E2E_ARTIFACT_DIR || path.join(tmpdir(), 'bookmark-e2e-artifacts');
await mkdir(artifactDir, {recursive:true});
await cp(path.join(root, '.output/chrome-mv3'), extension, {recursive:true});
const manifest = JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions = ['https://api.minimax.io/*','https://api.minimax.cn/*'];
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const background = path.join(extension, manifest.background.service_worker);
const mock = `
// TEST ONLY bootstrap: never forward requests to the internet.
globalThis.__mockCalls = [];
globalThis.__mockErrors = [];
globalThis.__mockMode = 'ok';
globalThis.fetch = async (url, init) => {
 if (!['https://api.minimax.io/v1/chat/completions','https://api.minimax.cn/v1/chat/completions'].includes(String(url))) throw new Error('E2E blocked network');
 const body = JSON.parse(init.body); globalThis.__mockCalls.push(body);
 if (globalThis.__mockMode === 'error') return new Response('{}',{status:429});
 if (globalThis.__mockMode === 'wait') return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
 const context = JSON.parse(body.messages.at(-1).content);
 const folder = context.existingFolders.find(f=>f.title==='Synthetic Target') || context.existingFolders[0];
 let result;
 if(context.page) result={title:'Synthetic advised title',targetFolderId:folder.id,reason:'Synthetic classification'};
 else {
 const bookmark=context.bookmarks.find(b=>b.title==='Synthetic Guide') || context.bookmarks[0];
 if(!bookmark) throw new Error('Synthetic candidate missing');
 result={text:'Synthetic answer '+globalThis.__mockCalls.length,references:[{bookmarkId:bookmark.bookmarkId,reason:'Synthetic relevance'}],
 folders:[{proposalId:'new:synthetic',title:'Synthetic AI Folder',parentFolderId:folder.id}],
 moves:[{bookmarkId:bookmark.bookmarkId,targetFolderId:'new:synthetic',reason:'Synthetic move'}]};
 }
 return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(result)},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
};
`;
await writeFile(background,mock+await readFile(background,'utf8'));
let context; let page; let worker; const checks=[]; const errors=[];
const pass = name => { checks.push(name); console.log('PASS',name); };
// Assertions poll rendered state rather than forcing controls or relying on sleeps.
async function eventually(assertion, timeout=10000) {
 const deadline=Date.now()+timeout; let last;
 do {try {await assertion();return;}catch(error){last=error;await new Promise(resolve=>setTimeout(resolve,100));}} while(Date.now()<deadline);
 throw last;
}
// Element Plus uses visually hidden native inputs. Click their associated visible
// label exactly as a user would, then assert the native checked state.
async function choose(input, checked=true) {
 if(await input.isChecked() !== checked) await input.locator('xpath=ancestor::label[1]').click();
 assert.equal(await input.isChecked(),checked,'Visible label must update native checked state');
}
async function screenshot(name) {await page.screenshot({path:path.join(artifactDir,name+'.png'),fullPage:true});}
async function noBodyOverflow(label) {
 const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
 assert(dimensions.scroll<=dimensions.width+1,`${label}: unexpected page horizontal overflow ${JSON.stringify(dimensions)}`);
}

try {
 context = await chromium.launchPersistentContext(path.join(temp,'profile'), {
  ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {channel:'chromium'}), headless:true,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-dev-shm-usage','--disable-background-networking'],
  viewport:{width:1440,height:1000},acceptDownloads:true,
 });
 // Even accidental page navigations cannot reach a real website.
 await context.route(/^https?:\/\//,route=>route.request().url().startsWith('https://example.test/')
  ?route.fulfill({status:200,contentType:'text/html',body:'<title>Synthetic capture page</title><p>Synthetic fixture only</p>'}):route.abort());
 worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const extensionId = new URL(worker.url()).host;
 const optionsUrl=`chrome-extension://${extensionId}/options.html`;
 page = await context.newPage(); page.on('pageerror', e=>errors.push(e.message));
 await page.goto(optionsUrl);
 await page.getByText('Bookmark Workspace',{exact:true}).waitFor(); pass('production extension loads and workspace renders');
 const native = (fn,arg) => page.evaluate(fn,arg);
 const request = async (type, extra={}) => {
  const response = await page.evaluate(data=>chrome.runtime.sendMessage({...data,requestId:crypto.randomUUID()}),{type,...extra});
  assert.equal(response.ok,true,`${type}: ${JSON.stringify(response)}`); return response.data;
 };
 const ids = await native(async()=>{
  const tree=await chrome.bookmarks.getTree();const root=tree[0].children.find(n=>n.id==='1')||tree[0].children[0];
  const source=await chrome.bookmarks.create({parentId:root.id,title:'Synthetic Source'});
  const nested=await chrome.bookmarks.create({parentId:source.id,title:'Synthetic Nested'});
  const target=await chrome.bookmarks.create({parentId:root.id,title:'Synthetic Target'});
  const guide=await chrome.bookmarks.create({parentId:nested.id,title:'Synthetic Guide',url:'https://example.test/guide?Original=YES#frag'});
  const duplicate=await chrome.bookmarks.create({parentId:source.id,title:'Synthetic Duplicate',url:guide.url});
  return {root:root.id,rootTitle:root.title,source:source.id,nested:nested.id,target:target.id,guide:guide.id,duplicate:duplicate.id};
 });
 await request('SYNC');await page.reload();
 await page.getByRole('link',{name:'Synthetic Guide ↗',exact:true}).waitFor();
 assert((await request('BOOKMARKS_LIST',{limit:200})).rows.some(b=>b.browserId===ids.guide));
 assert((await request('BOOKMARKS_TREE')).some(f=>f.browserId===ids.target));
 pass('native nested bookmarks synchronize to IndexedDB and UI; empty destination folder remains available');
 const goal=()=>page.getByRole('textbox',{name:'搜索书签或描述你的目标',exact:true});
 const browse=()=>page.getByRole('button',{name:/浏览书签/}).click();
 const search=async text=>{await goal().fill(text);await page.getByRole('button',{name:'本地搜索',exact:true}).click();await eventually(async()=>assert(!(await page.locator('.el-loading-mask:visible').count())));};
 const closeDialog=dialog=>dialog.getByRole('button',{name:'Close this dialog',exact:true}).click();
 const approve=async(deletion=false)=>{
  const box=page.locator('.approval-box');const execute=box.getByRole('button',{name:/^批准并执行/});
  await execute.waitFor();assert(await execute.isDisabled());
  await box.getByText('写入前快照已自动保存到此设备',{exact:false}).waitFor();
  await choose(box.getByRole('checkbox',{name:'已逐项核对并批准以上更改',exact:true}));
  if(deletion){assert(await execute.isDisabled());await box.getByPlaceholder('删除',{exact:true}).fill('删除');}
  await execute.click();await box.getByText('此计划已执行，不能重复执行。恢复操作也会先生成新的预览供你审核。',{exact:true}).waitFor();
  assert.equal(await box.getByRole('button',{name:/^批准并执行/}).count(),0);
 };
 const exportPlan=async name=>{const promise=page.waitForEvent('download');await page.getByRole('button',{name:'导出此计划的恢复备份',exact:true}).click();const file=path.join(artifactDir,name);await(await promise).saveAs(file);return file;};
 // Settings are entered visibly, with model validation, cancellation and explicit local opt-in.
 await page.getByRole('button',{name:'AI 设置',exact:true}).click();
 let settingsDialog=page.getByRole('dialog',{name:'AI 连接与数据范围',exact:true});
 const model=()=>settingsDialog.locator('.el-form-item').filter({hasText:'模型'}).getByRole('textbox');
 await model().fill('');await settingsDialog.getByRole('button',{name:'保存设置',exact:true}).click();
 await settingsDialog.getByText('请输入模型名称。',{exact:true}).waitFor();
 await settingsDialog.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal((await request('ASSISTANT_SETTINGS_GET')).hasKey,false);
 await page.getByRole('button',{name:'AI 设置',exact:true}).click();
 await model().fill('MiniMax-M2.5');
 await settingsDialog.locator('input[type=password]').fill('synthetic-test-key');
 await choose(settingsDialog.getByRole('checkbox',{name:'在此设备记住密钥（可选）',exact:true}));
 await choose(settingsDialog.getByRole('checkbox',{name:/我同意将当前对话范围/}));
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('settings '+width);await screenshot('settings-'+width);}
 await settingsDialog.getByRole('button',{name:'保存设置',exact:true}).click();await settingsDialog.waitFor({state:'hidden'});
 assert.equal((await request('ASSISTANT_SETTINGS_GET')).keyStorage,'local');
 pass('visible settings validate inline, cancel safely, and save explicit remember-key opt-in');
 // No backend-generated session or turn: the real goal composer creates and sends both turns.
 await goal().fill('Organize Synthetic Guide');await page.getByRole('button',{name:'询问 AI',exact:true}).click();
 await page.getByText('Synthetic answer 1',{exact:true}).waitFor();
 await goal().fill('Keep the same reference and explain it');await page.getByRole('button',{name:'继续对话',exact:true}).click();
 await page.getByText('Synthetic answer 2',{exact:true}).waitFor();
 const sessions=await request('ASSISTANT_SESSIONS');const session=await request('ASSISTANT_GET',{sessionId:sessions[0].id});
 assert.equal(session.messages.length,4);assert.equal(session.messages[1].references[0].citationId,session.messages[3].references[0].citationId);
 assert.equal(session.citations[0].url,'https://example.test/guide?Original=YES#frag');
 const calls=await worker.evaluate(()=>globalThis.__mockCalls);assert.equal(calls.length,2);assert.equal(calls[1].messages.length,4);
 await page.reload();await page.getByRole('button',{name:'历史与恢复',exact:true}).click();
 await page.getByRole('button',{name:/Organize Synthetic Guide/}).click();await page.getByText('Synthetic answer 2',{exact:true}).waitFor();
 pass('visible two-turn AI composer retains full context, exact URL, stable citation and history after reload');
 await page.getByRole('button',{name:'审核整理建议（1）',exact:true}).last().click();
 await page.getByRole('button',{name:'预览已选 AI 建议',exact:true}).click();
 assert.equal((await native(id=>chrome.bookmarks.get(id),ids.guide))[0].parentId,ids.nested);
 const backupPath=await exportPlan('synthetic-plan-backup.json');const backup=JSON.parse(await readFile(backupPath,'utf8'));
 assert.equal(backup.formatVersion,1);assert(!JSON.stringify(backup).includes('synthetic-test-key'));
 await approve();
 const moved=(await native(id=>chrome.bookmarks.get(id),ids.guide))[0];const created=(await native(id=>chrome.bookmarks.get(id),moved.parentId))[0];
 assert.equal(created.title,'Synthetic AI Folder');assert.equal(created.parentId,ids.target);
 await exportPlan('synthetic-completed-plan-backup.json');await screenshot('workspace-plan-completed');
 pass('AI folder + dependent move visibly review and execute using automatic snapshot; repeat execution blocked; completed backup export works');
 // Recovery is a real visible inverse-plan review, not a hidden runtime approval.
 await page.getByRole('button',{name:'预览恢复',exact:true}).click();await approve(true);
 assert.equal((await native(id=>chrome.bookmarks.get(id),ids.guide))[0].parentId,ids.nested);
 pass('visible completed-plan recovery preview restores original native bookmark position');
 // Dedup keeps one copy and never writes during analysis or selection.
 await page.getByRole('button',{name:'检查完全相同的 URL',exact:true}).click();
 const duplicateCard=page.locator('.duplicate-card');await duplicateCard.waitFor();
 assert.equal(await duplicateCard.getByRole('checkbox').count(),2);
 await choose(duplicateCard.getByRole('checkbox',{name:'Synthetic Duplicate',exact:true}));
 assert(await duplicateCard.getByRole('checkbox',{name:'Synthetic Guide',exact:true}).isDisabled());
 assert.equal((await native(id=>chrome.bookmarks.get(id),ids.duplicate)).length,1);
 await page.getByRole('button',{name:'预览移除 1 个重复书签',exact:true}).click();await approve(true);
 assert.equal(await native(async id=>{try{await chrome.bookmarks.get(id);return true;}catch{return false;}},ids.duplicate),false);
 await page.getByRole('button',{name:'检查完全相同的 URL',exact:true}).click();
 await page.getByText('当前范围没有完全相同的 URL，无需清理。',{exact:true}).waitFor();
 pass('inline duplicate selection keeps one copy; exact typed deletion gate and explicit zero-result state work');
 await browse();await page.getByRole('button',{name:'目录',exact:true}).click();
 await page.getByRole('dialog',{name:'我的书签目录',exact:true}).getByText(ids.rootTitle,{exact:true}).click();
 await page.getByRole('button',{name:/整理书签/}).click();assert.equal(await page.locator('.duplicates-section').count(),0);
 await page.getByRole('button',{name:'目录',exact:true}).click();await page.getByRole('button',{name:'▤ 全部书签',exact:true}).click();
 pass('changing directory invalidates previous duplicate results');
 // Ordinary add/edit/move controls also use the exact same safe plan review.
 await page.getByRole('button',{name:/收藏网址/}).click();
 let editor=page.getByRole('dialog',{name:'添加书签',exact:true});
 await editor.getByRole('button',{name:'预览更改',exact:false}).click();await editor.getByText(/请输入.*标题/).waitFor();
 await editor.locator('#bookmark-editor-title').fill('Synthetic Manual');await editor.locator('#bookmark-editor-url').fill('https://example.test/manual?Keep=YES#frag');
 await editor.getByRole('button',{name:'预览更改',exact:false}).click();await approve();
 await search('Synthetic Manual');await page.getByRole('link',{name:'Synthetic Manual ↗',exact:true}).waitFor();
 let manualRow=page.locator('.results-panel tbody tr').filter({hasText:'Synthetic Manual'});
 await manualRow.getByRole('button',{name:'编辑',exact:true}).click();editor=page.getByRole('dialog',{name:'编辑书签',exact:true});
 await editor.locator('#bookmark-editor-title').fill('Synthetic Manual Edited');await editor.getByRole('button',{name:'预览更改',exact:false}).click();await approve();
 await search('Synthetic Manual Edited');manualRow=page.locator('.results-panel tbody tr').filter({hasText:'Synthetic Manual Edited'});await manualRow.getByRole('button',{name:'移动',exact:true}).click();
 editor=page.getByRole('dialog',{name:'移动到目录',exact:true});await editor.locator('.el-select').click();await page.getByRole('option',{name:/Synthetic Target$/}).click();
 await editor.getByRole('button',{name:'预览更改',exact:false}).click();await approve();
 const manual=(await native(()=>chrome.bookmarks.search({title:'Synthetic Manual Edited'})))[0];assert.equal(manual.parentId,ids.target);assert.equal(manual.url,'https://example.test/manual?Keep=YES#frag');
 pass('manual add validation, title editing and destination move execute only after visible review and preserve exact URL');
 // Local search and tools have separate state. Import recovery uses the file chooser and visible approval.
 await search('Synthetic Guide');await page.getByRole('link',{name:'Synthetic Guide ↗',exact:true}).waitFor();
 await page.getByRole('button',{name:'导入 / 导出',exact:true}).click();
 const toolsDialog=page.getByRole('dialog',{name:'书签工具',exact:true});await toolsDialog.waitFor();
 assert.equal(await page.locator('.results-panel tbody tr').count(),1);
 assert((await page.locator('.results-panel tbody').innerText()).includes('Synthetic Guide'));
 await closeDialog(toolsDialog);assert.equal(await goal().inputValue(),'Synthetic Guide');
 pass('opening and closing tools preserves local search and the main result table');
 // Delete only this run's synthetic source to prove nested additive recovery from the exported snapshot.
 await native(id=>chrome.bookmarks.removeTree(id),ids.source);await request('SYNC');
 await page.getByRole('button',{name:'导入 / 导出',exact:true}).click();
 await toolsDialog.getByRole('button',{name:'导入 JSON 备份',exact:true}).click();
 let importDialog=page.getByRole('dialog',{name:'导入 JSON 备份',exact:true});
 const chooseBackup=async()=>{const chooser=page.waitForEvent('filechooser');await importDialog.getByRole('button',{name:/^(选择文件|更换文件)$/}).click();await(await chooser).setFiles(backupPath);await importDialog.locator('.preview-card').waitFor();};
 await chooseBackup();
 await choose(importDialog.getByRole('checkbox',{name:/显示高级合并模式/}));await choose(importDialog.getByRole('radio',{name:'受控合并',exact:true}));
 await closeDialog(importDialog);await toolsDialog.getByRole('button',{name:'导入 JSON 备份',exact:true}).click();
 importDialog=page.getByRole('dialog',{name:'导入 JSON 备份',exact:true});await chooseBackup();
 assert(await importDialog.getByRole('radio',{name:'仅添加',exact:true}).isChecked());
 assert.equal(await importDialog.getByRole('radio',{name:'受控合并',exact:true}).count(),0);
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('import '+width);await screenshot('import-'+width);}
 await importDialog.getByRole('button',{name:'创建计划',exact:true}).click();
 const importApprove=importDialog.getByRole('button',{name:'批准',exact:true});await importApprove.waitFor();assert(await importApprove.isDisabled());
 await choose(importDialog.getByRole('checkbox',{name:'我已逐项核对并同意以上所有更改',exact:true}));await importApprove.click();
 await importDialog.getByRole('button',{name:'执行',exact:true}).click();await importDialog.getByRole('button',{name:'关闭',exact:true}).waitFor();
 const recovered=await native(()=>chrome.bookmarks.getTree());const flatten=nodes=>nodes.flatMap(n=>[n,...flatten(n.children||[])]);
 const restoredSource=flatten(recovered).find(n=>n.title==='Synthetic Source');assert(restoredSource);const restoredNested=restoredSource.children.find(n=>n.title==='Synthetic Nested');
 assert(restoredNested.children.some(n=>n.title==='Synthetic Guide'&&n.url==='https://example.test/guide?Original=YES#frag'));
 await importDialog.getByRole('button',{name:'关闭',exact:true}).click();await closeDialog(toolsDialog);
 pass('visible same-file import resets to additive, requires review, and restores nested folders with exact leaf URL');
 // Safe health rendering without running any external scan.
 await native(async root=>{await chrome.bookmarks.create({parentId:root,title:'Synthetic unsafe protocol',url:'javascript:void(0)'});},ids.root);await request('SYNC');
 await page.getByRole('button',{name:'链接健康',exact:true}).click();
 await toolsDialog.getByText('javascript:void(0)',{exact:true}).waitFor();
 assert.equal(await toolsDialog.locator('a[href^="javascript:"],a[href^="data:"]').count(),0);
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('health '+width);await screenshot('health-'+width);}
 await closeDialog(toolsDialog);pass('health leaves unsafe schemes nonclickable and fits four viewport sizes');
 // Historical candidate IDs were deleted and restored under new IDs. Reusing that
 // conversation must fail before transmitting its stale private history.
 const callsBeforeStaleHistory=await worker.evaluate(()=>globalThis.__mockCalls.length);
 await goal().fill('Continue after synthetic recovery');await page.getByRole('button',{name:'继续对话',exact:true}).click();
 await page.locator('.main-pane > .el-alert').waitFor();
 await eventually(async()=>assert(!(await goal().isDisabled())));
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),callsBeforeStaleHistory);
 await goal().fill('');await page.getByRole('button',{name:'新任务',exact:true}).click();
 pass('stale private conversation history is blocked before provider transmission; visible new-task action starts cleanly');
 // Provider failures and cancellation retain the user's prompt and allow a later successful retry.
 await worker.evaluate(()=>{globalThis.__mockMode='error';});await goal().fill('Synthetic retry request');
 await page.getByRole('button',{name:/^(询问 AI|继续对话)$/}).click();await page.getByText('AI 请求暂时受限，请稍后重试，并检查服务账户的额度与调用频率。',{exact:true}).waitFor();assert.equal(await goal().inputValue(),'Synthetic retry request');
 const beforeCancelCalls=await worker.evaluate(()=>globalThis.__mockCalls.length);
 await worker.evaluate(()=>{globalThis.__mockMode='wait';});await page.getByRole('button',{name:/^(询问 AI|继续对话)$/}).click();
 await eventually(async()=>assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),beforeCancelCalls+1));
 await page.getByRole('button',{name:'取消生成',exact:true}).click();await eventually(async()=>assert(!(await goal().isDisabled())));
 assert.equal(await goal().inputValue(),'Synthetic retry request');
 await worker.evaluate(()=>{globalThis.__mockMode='ok';});await page.getByRole('button',{name:/^(询问 AI|继续对话)$/}).click();await eventually(async()=>assert.equal(await goal().inputValue(),''));
 pass('visible provider error and cancellation preserve the prompt; retry completes successfully');
 // Selection scope freezes an explicitly selected native bookmark, independently of search text.
 await search('Synthetic Manual Edited');let scopedRow=page.locator('.results-panel tbody tr').filter({hasText:'Synthetic Manual Edited'});
 await choose(scopedRow.getByRole('checkbox'));await goal().fill('');await page.getByRole('button',{name:'AI 整理所选',exact:true}).click();
 await page.getByRole('button',{name:'询问 AI',exact:true}).click();await eventually(async()=>assert.equal(await goal().inputValue(),''));
 const scopeCall=await worker.evaluate(()=>JSON.parse(globalThis.__mockCalls.at(-1).messages.at(-1).content));
 assert.equal(scopeCall.scope.bookmarkIds.length,1);assert.equal(scopeCall.bookmarks.length,1);assert.equal(scopeCall.bookmarks[0].title,'Synthetic Manual Edited');
 pass('selected-bookmark AI task transmits exactly the frozen selection, not all search results');
 await browse();await search('');
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('workspace '+width);await screenshot('workspace-'+width);}
 await goal().focus();await page.keyboard.type('Synthetic Guide');await page.getByRole('button',{name:'本地搜索',exact:true}).click();
 await page.getByRole('link',{name:'Synthetic Guide ↗',exact:true}).waitFor();await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.activeElement!==document.body));
 pass('workspace responsive screenshots and keyboard-driven local search work');
 // Sidepanel document runs the same full workspace at realistic narrow widths.
 await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);await page.getByRole('textbox',{name:'搜索书签或描述你的目标',exact:true}).waitFor();
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('sidepanel '+width);await screenshot('sidepanel-'+width);}
 pass('sidepanel document loads the complete workspace without horizontal overflow');
 // Opening popup.html as a tab cannot reproduce Chrome's activeTab grant. Use the real extension action popup.
 const sourcePage=await context.newPage();await sourcePage.goto('https://example.test/capture?Keep=YES#frag');await sourcePage.bringToFront();
 const popupPromise=context.waitForEvent('page',{timeout:10000});
 await worker.evaluate(()=>chrome.action.openPopup());
 const popup=await popupPromise;popup.on('pageerror',e=>errors.push(e.message));await popup.waitForLoadState();
 await popup.getByLabel('标题',{exact:true}).fill('Synthetic Quick Save');
 await popup.getByRole('button',{name:'确认收藏',exact:true}).click();await popup.getByRole('button',{name:'✓ 已收藏',exact:true}).waitFor();
 await popup.getByRole('searchbox',{name:'搜索已有书签',exact:true}).fill('Synthetic Quick Save');
 await popup.getByRole('button',{name:/Synthetic Quick Save.*example\.test/}).waitFor();
 const quick=(await native(()=>chrome.bookmarks.search({title:'Synthetic Quick Save'})))[0];assert.equal(quick.url,'https://example.test/capture?Keep=YES#frag');
 await popup.screenshot({path:path.join(artifactDir,'popup-quick-save.png')});
 pass('real extension action popup saves the active synthetic page and finds it through local search');
 assert.deepEqual(errors,[]);pass('no uncaught workspace page errors');
 await writeFile(path.join(artifactDir,'report.json'),JSON.stringify({checks,errors,syntheticOnly:true,mockProvider:true,liveProviderTested:false},null,2));
 console.log(`Artifacts: ${artifactDir}`);
} catch(error) {
 if(page){await page.screenshot({path:path.join(artifactDir,'failure.png'),fullPage:true}).catch(()=>{});console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,6000));}
 await writeFile(path.join(artifactDir,'report.json'),JSON.stringify({checks,errors,failure:String(error),syntheticOnly:true,mockProvider:true},null,2));throw error;
} finally {if(context)await context.close();await rm(temp,{recursive:true,force:true});}
