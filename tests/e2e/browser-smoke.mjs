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
manifest.host_permissions = ['https://api.minimax.io/*'];
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const background = path.join(extension, manifest.background.service_worker);
const mock = `
// TEST ONLY bootstrap: never forward requests to the internet.
globalThis.__mockCalls = [];
globalThis.__mockErrors = [];
globalThis.fetch = async (url, init) => {
 try {
 if (String(url) !== 'https://api.minimax.io/v1/chat/completions') throw new Error('E2E blocked network');
 const body = JSON.parse(init.body); globalThis.__mockCalls.push(body);
 const context = JSON.parse(body.messages.at(-1).content);
 const bookmark = context.bookmarks.find(b => b.title === 'Synthetic Guide');
 const folder = context.existingFolders.find(f => f.title === 'Synthetic Target');
 if (!bookmark) throw new Error('Synthetic Guide missing from provider bookmark candidates');
 if (context.mode==='organize' && !folder) throw new Error('Empty Synthetic Target folder missing from provider existingFolders');
 const message = {role:'assistant', content:JSON.stringify({text: 'Synthetic answer '+globalThis.__mockCalls.length,
 references:[{bookmarkId:bookmark.bookmarkId,reason:'Synthetic relevance'}],
 folders: context.mode==='organize' ? [{proposalId:'new:synthetic',title:'Synthetic AI Folder',parentFolderId:folder.id}] : [],
 moves: context.mode==='organize' ? [{bookmarkId:bookmark.bookmarkId,targetFolderId:'new:synthetic',reason:'Synthetic move'}] : []})};
 return new Response(JSON.stringify({choices:[{message,finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
 } catch(error) {globalThis.__mockErrors.push(String(error));throw error;}
};
`;
await writeFile(background,mock+await readFile(background,'utf8'));
let context; let page; let worker; const checks=[]; const errors=[];
const pass = name => { checks.push(name); console.log('PASS',name); };
try {
 context = await chromium.launchPersistentContext(path.join(temp,'profile'), {
  ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {channel:'chromium'}), headless:true,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-dev-shm-usage','--disable-background-networking'],
  viewport:{width:1440,height:1000},acceptDownloads:true,
 });
 worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const extensionId = new URL(worker.url()).host;
 page = await context.newPage(); page.on('pageerror', e=>errors.push(e.message));
 await page.goto(`chrome-extension://${extensionId}/options.html`);
 await page.getByText('Bookmark Workspace',{exact:true}).waitFor(); pass('production extension loads and workspace renders');
 const native = (fn,arg) => page.evaluate(fn,arg);
 const request = async (type, extra={}) => {
  const response = await page.evaluate(data=>chrome.runtime.sendMessage({...data,requestId:crypto.randomUUID()}),{type,...extra});
  assert.equal(response.ok,true,`${type}: ${JSON.stringify(response)}`); return response.data;
 };
 const ids = await native(async()=>{
  const tree=await chrome.bookmarks.getTree();
  const root=tree[0].children.find(n=>n.id==='1')||tree[0].children[0];
  const source=await chrome.bookmarks.create({parentId:root.id,title:'Synthetic Source'});
  const nested=await chrome.bookmarks.create({parentId:source.id,title:'Synthetic Nested'});
  const target=await chrome.bookmarks.create({parentId:root.id,title:'Synthetic Target'});
  const guide=await chrome.bookmarks.create({parentId:nested.id,title:'Synthetic Guide',url:'https://example.test/guide?Original=YES#frag'});
  const duplicate=await chrome.bookmarks.create({parentId:source.id,title:'Synthetic Duplicate',url:guide.url});
  return {source:source.id,nested:nested.id,target:target.id,guide:guide.id,duplicate:duplicate.id};
 });
 await request('SYNC'); await page.reload();
 await page.getByRole('link',{name:'Synthetic Guide ↗',exact:true}).waitFor();
 const rows=await request('BOOKMARKS_LIST',{limit:200}); assert(rows.rows.some(b=>b.browserId===ids.guide)); pass('native nested bookmarks synchronize to IndexedDB and rendered UI');
 const indexedFolders=await request('BOOKMARKS_TREE');
 assert(indexedFolders.some(f=>f.browserId===ids.target), 'Empty native Synthetic Target folder must appear in indexed folders');
 pass('empty native destination folder remains available to workspace and assistant');
 await page.getByRole('button',{name:'整理计划',exact:true}).click();
 await page.getByRole('button',{name:'检查完全相同的 URL',exact:true}).click();
 await page.locator('.duplicate-card').waitFor(); assert.equal(await page.locator('.duplicate-card p').count(),2); pass('duplicate preview finds exact original URL pair without deletion');
 await request('ASSISTANT_SETTINGS_SAVE',{settings:{region:'global',model:'MiniMax-M2.5',apiKey:'synthetic-test-key',consent:true}});
 const session=await request('ASSISTANT_CREATE',{input:{mode:'organize'}});
 const first=await request('ASSISTANT_TURN',{sessionId:session.id,text:'Organize Synthetic Guide'});
 const second=await request('ASSISTANT_TURN',{sessionId:session.id,text:'Keep the same reference and explain it'});
 assert.equal(second.messages.length,4); assert.equal(second.citations[0].citationId,first.citations[0].citationId);
 assert.equal(second.citations[0].url,'https://example.test/guide?Original=YES#frag');
 await page.reload(); const restored=await request('ASSISTANT_GET',{sessionId:session.id}); assert.equal(restored.messages.length,4);
 const calls=await worker.evaluate(()=>globalThis.__mockCalls); assert.equal(calls.length,2); assert.equal(calls[1].messages.length,4);
 pass('two-turn mock AI keeps prior context, exact URL, stable citation, and persisted history across page reload');
 // Select the persisted session using the visible chat history selector.
 const selects=page.locator('.chat-controls .el-select');
 await selects.nth(1).click(); await page.getByRole('option',{name:'Organize Synthetic Guide',exact:true}).click();
 await page.getByText('Synthetic answer 2',{exact:true}).waitFor();
 await page.getByRole('button',{name:'整理计划',exact:true}).click();
 await page.getByRole('button',{name:'预览本轮 AI 移动建议',exact:true}).click();
 await page.locator('.approval-box').waitFor();
 const execute=page.getByRole('button',{name:/3\. 批准并执行/}); assert(await execute.isDisabled());
 assert.equal((await native(id=>chrome.bookmarks.get(id),ids.guide))[0].parentId,ids.nested);
 const downloadPromise=page.waitForEvent('download'); await page.getByRole('button',{name:'1. 导出此计划的恢复备份',exact:true}).click();
 const download=await downloadPromise; const backupPath=path.join(artifactDir,'synthetic-plan-backup.json'); await download.saveAs(backupPath);
 const backup=JSON.parse(await readFile(backupPath,'utf8')); assert.equal(backup.formatVersion,1); assert(!JSON.stringify(backup).includes('synthetic-test-key'));
 assert(await execute.isDisabled());
 await page.locator('.approval-box label.el-checkbox').click();
 assert(await page.getByRole('checkbox',{name:'2. 已保存备份，逐项核对并批准以上更改',exact:true}).isChecked());
 await execute.click(); await page.getByText('本计划已执行。请查看操作历史；如需重试，请创建并审核新计划。',{exact:true}).waitFor();
 const movedGuide=(await native(id=>chrome.bookmarks.get(id),ids.guide))[0];
 const createdFolder=(await native(id=>chrome.bookmarks.get(id),movedGuide.parentId))[0];
 assert.equal(createdFolder.title,'Synthetic AI Folder'); assert.equal(createdFolder.parentId,ids.target); assert(await execute.isDisabled());
 pass('AI new-folder + dependent move UI enforces preview → backup download → explicit approval → native execution; repeat execute disabled');
 await page.screenshot({path:path.join(artifactDir,'workspace-plan-completed.png'),fullPage:true});
 // Destructive changes have an additional visible typed-confirmation gate.
 await page.getByRole('button',{name:'浏览与引用',exact:true}).click();
 await page.getByRole('textbox',{name:'搜索原生书签',exact:true}).fill('Synthetic Duplicate');
 await page.waitForFunction(()=>document.querySelectorAll('.el-table__body-wrapper tbody tr').length===1 && document.querySelector('.el-table__body-wrapper tbody')?.textContent.includes('Synthetic Duplicate'));
 await page.locator('.el-table__body-wrapper label.el-checkbox').click();
 assert(await page.locator('.el-table__body-wrapper').getByRole('checkbox').isChecked());
 await page.getByRole('button',{name:'预览删除',exact:true}).click();
 await page.locator('.approval-box').waitFor(); assert(await execute.isDisabled());
 const deleteDownload=page.waitForEvent('download'); await page.getByRole('button',{name:'1. 导出此计划的恢复备份',exact:true}).click();
 await (await deleteDownload).saveAs(path.join(artifactDir,'synthetic-delete-backup.json'));
 await page.locator('.approval-box label.el-checkbox').click();
 assert(await page.getByRole('checkbox',{name:'2. 已保存备份，逐项核对并批准以上更改',exact:true}).isChecked());
 assert(await execute.isDisabled()); await page.getByPlaceholder('删除',{exact:true}).fill('删除');
 await execute.click(); await page.getByText('本计划已执行。请查看操作历史；如需重试，请创建并审核新计划。',{exact:true}).waitFor();
 assert.equal(await native(async id=>{try{await chrome.bookmarks.get(id);return true;}catch{return false;}},ids.duplicate),false);
 pass('selected synthetic duplicate deletion requires backup, approval and exact typed confirmation before native removal');
 // Restore the nested source from a real backup, after deleting only synthetic data.
 await native(id=>chrome.bookmarks.removeTree(id),ids.source);
 await native(id=>chrome.bookmarks.removeTree(id),createdFolder.id); await request('SYNC');
 const rawJson=JSON.stringify(backup);
 const preview=await request('IMPORT_PREVIEW',{rawJson,mode:'additive'}); assert(preview.summary.adds>0);
 const plan=await request('PLAN_DRAFT',{rawJson,mode:'additive',title:'Synthetic nested recovery'});
 const approval=await request('APPROVE',{planId:plan.id});
 const result=await request('EXECUTE',{planId:plan.id,approvalToken:approval.token}); assert.equal(result.status,'completed');
 const tree=await native(()=>chrome.bookmarks.getTree());
 const flatten=nodes=>nodes.flatMap(n=>[n,...flatten(n.children||[])]);
 const recoveredSource=flatten(tree).find(n=>n.title==='Synthetic Source');
 assert(recoveredSource); const recoveredNested=recoveredSource.children.find(n=>n.title==='Synthetic Nested');
 assert(recoveredNested); assert(recoveredNested.children.some(n=>n.title==='Synthetic Guide'&&n.url==='https://example.test/guide?Original=YES#frag'));
 pass('backup additive recovery preserves newly created nested folders and exact leaf URL');
 assert.deepEqual(errors,[]); pass('no uncaught workspace page errors');
 await writeFile(path.join(artifactDir,'report.json'),JSON.stringify({checks,errors,syntheticOnly:true,mockProvider:true},null,2));
 console.log(`Artifacts: ${artifactDir}`);
} catch(error) {
 // These diagnostics contain only the synthetic fixture; never save auth headers.
 if(worker) {const diagnostics=await worker.evaluate(()=>({mockErrors:globalThis.__mockErrors,mockCalls:globalThis.__mockCalls})).catch(e=>({diagnosticError:String(e)}));await writeFile(path.join(artifactDir,'mock-diagnostics.json'),JSON.stringify(diagnostics,null,2));console.error('Mock diagnostics:',JSON.stringify(diagnostics));}
 if(page) {await page.screenshot({path:path.join(artifactDir,'failure.png'),fullPage:true}).catch(()=>{}); console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,4500));}
 await writeFile(path.join(artifactDir,'report.json'),JSON.stringify({checks,errors,failure:String(error),syntheticOnly:true,mockProvider:true},null,2));
 throw error;
} finally {if(context)await context.close(); await rm(temp,{recursive:true,force:true});}
