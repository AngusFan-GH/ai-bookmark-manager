/** Real Chromium extension acceptance; all bookmarks/profile/AI replies are synthetic.
 * Run after npm run build: node tests/e2e/browser-smoke.mjs
 * Requires playwright and its bundled Chromium (or CHROMIUM_PATH override).
 * The shipped build is copied to a temporary directory; only that copy gets a mock
 * fetch bootstrap and provider host permission. No real API or user key is used.
 */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { HEALTH_FIXTURE_ORIGIN, createHealthHttpFixture, assertHealthHttpMatrix } from './health-http-fixture.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
const root = process.cwd();
const temp = await mkdtemp(path.join(tmpdir(), 'bookmark-e2e-'));
const extension = path.join(temp, 'extension');
const artifactDir = process.env.E2E_ARTIFACT_DIR || path.join(tmpdir(), 'bookmark-e2e-artifacts');
await mkdir(artifactDir, {recursive:true});
await cp(path.join(root, '.output/chrome-mv3'), extension, {recursive:true});
const manifest = JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
manifest.host_permissions = ['https://api.minimax.io/*','https://api.minimax.cn/*',HEALTH_FIXTURE_ORIGIN];
if(process.env.E2E_NATIVE_POPUP==='shortcut') manifest.commands={...manifest.commands,_execute_action:{suggested_key:{default:'Ctrl+Shift+Y'}}};
await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const background = path.join(extension, manifest.background.service_worker);
const mock = `
// TEST ONLY bootstrap: never forward requests to the internet.
const nativeFetchForHealthFixture = globalThis.fetch.bind(globalThis);
globalThis.__mockCalls = [];
globalThis.__mockErrors = [];
globalThis.__mockMode = 'ok';
globalThis.fetch = async (url, init) => {
 const fixtureUrl=new URL(String(url));
 if (fixtureUrl.protocol==='https:'&&fixtureUrl.pathname==='/probe'&&!fixtureUrl.search&&['fallback','missing','gone','forbidden','limited','retry','redirect','soft404','login','timeout','cancel'].some(name=>fixtureUrl.hostname===name+'.health-fixture.test')) return nativeFetchForHealthFixture(url,init);
 if (!['https://api.minimax.io/v1/chat/completions','https://api.minimax.cn/v1/chat/completions'].includes(String(url))) throw new Error('E2E blocked network');
 const body = JSON.parse(init.body); globalThis.__mockCalls.push(body);
 if (globalThis.__mockMode === 'error') return new Response('{}',{status:429});
 if (globalThis.__mockMode === 'wait') return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
 if(body.messages.length===1 && body.messages[0].content==='Reply with OK.') return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
 const context = JSON.parse(body.messages.at(-1).content);
 const folder = context.existingFolders.find(f=>f.title==='Synthetic Target') || context.existingFolders[0];
 let result;
 if(context.page) result={title:'Synthetic advised title',targetFolderId:folder.id,reason:'Synthetic classification'};
 else {
 const bookmark=context.bookmarks.find(b=>b.title==='Synthetic Guide') || context.bookmarks[0];
 if(!bookmark) throw new Error('Synthetic candidate missing');
 const second=context.bookmarks.find(b=>b.bookmarkId!==bookmark.bookmarkId);
 const refs=[bookmark,...(second?[second]:[])];
 if(context.request.includes('second item'))refs.reverse();
 result={text:'Synthetic answer '+globalThis.__mockCalls.length,references:refs.map(b=>({bookmarkId:b.bookmarkId,reason:'Synthetic relevance'})),
 folders:context.mode==='recommend'?[]:[{proposalId:'new:synthetic',title:'Synthetic AI Folder',parentFolderId:folder.id}],
 moves:context.mode==='recommend'?[]:(globalThis.__mockMode==='theme'?refs:[bookmark]).map(b=>({bookmarkId:b.bookmarkId,targetFolderId:'new:synthetic',reason:'Synthetic move'}))};
 }
 if(body.stream===true) {
  const encoded=JSON.stringify(result);const prefix='{"text":"Synthetic ';let cancelled=false;
  const encoder=new TextEncoder();
  const stream=new ReadableStream({
   start(controller) {
    const event=value=>controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\\n\\n'));
    event({choices:[{index:0,delta:{content:prefix},finish_reason:null}]});
    const finish=()=>{
     if(cancelled)return false;
     event({choices:[{index:0,delta:{content:encoded.slice(prefix.length)},finish_reason:null}]});
     event({choices:[{index:0,delta:{},finish_reason:'stop'}]});
     controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));controller.close();return true;
    };
    if(globalThis.__mockMode==='stream-gated')globalThis.__releaseStream=finish;
    else finish();
   },
   cancel(){cancelled=true;},
  });
  return new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}});
 }
 return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(result)},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
};
`;
await writeFile(background,mock+await readFile(background,'utf8'));
const healthFixture=createHealthHttpFixture();
const blockedHttpRequests=[];
let context; let page; let worker; const checks=[]; const errors=[]; const captureErrors=[];
let currentStage='launch isolated browser';
const startedAt=Date.now();
const report = extra => ({checks,errors,captureErrors,currentStage,elapsedMs:Date.now()-startedAt,syntheticOnly:true,mockProvider:true,interceptedBrowserHealthHttp:true,liveProviderTested:false,liveWebsitesTested:false,...extra});
const checkpoint = name => {
 currentStage=name;console.log('STAGE',name);
 writeFileSync(path.join(artifactDir,'progress.json'),JSON.stringify(report({status:'running'}),null,2));
};
const pass = name => { checks.push(name); console.log('PASS',name); checkpoint('after: '+name); };
const bounded = async (operation,timeout,label) => {
 let timer;
 try {return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out after '+timeout+'ms')),timeout);})]);}
 finally {clearTimeout(timer);}
};
// This watchdog also covers evaluate(), browser startup and shutdown, which do
// not inherit Playwright locator timeouts. Persist evidence before terminating.
const watchdog=setTimeout(()=>{
 const failure='Browser suite exceeded its 8-minute budget at: '+currentStage;
 console.error(failure);
 writeFileSync(path.join(artifactDir,'report.json'),JSON.stringify(report({failure}),null,2));
 process.exit(1);
},8*60*1000);
watchdog.unref();
checkpoint(currentStage);
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
async function settledModalEvidence(name,target) {
 // Let CSS transitions finish on wall-clock time. Background extension windows
 // may throttle rAF, so do not await animations.finished or renderer frames.
 await new Promise(resolve=>setTimeout(resolve,400));
 let state=[];let previousGeometry;
 try {
  await eventually(async()=>{
   state=await target.evaluate(()=>[...document.querySelectorAll('.el-dialog,.el-overlay')].flatMap(element=>{
    const rect=element.getBoundingClientRect();const style=getComputedStyle(element);
    if(!rect.width||!rect.height||style.display==='none'||style.visibility!=='visible')return [];
    const ancestors=[];
    for(let current=element;current;current=current.parentElement){
     const css=getComputedStyle(current);
     ancestors.push({tag:current.tagName,className:String(current.className),opacity:Number(css.opacity),visibility:css.visibility});
    }
    return [{className:String(element.className),x:rect.x,y:rect.y,width:rect.width,height:rect.height,ancestors}];
   }));
   assert(state.every(element=>element.ancestors.every(ancestor=>ancestor.opacity===1&&ancestor.visibility==='visible')),name+': modal/overlay is still fading '+JSON.stringify(state));
   const geometry=JSON.stringify(state.map(({className,x,y,width,height})=>({className,x,y,width,height})));
   const stable=previousGeometry===geometry;previousGeometry=geometry;
   assert(stable,name+': modal geometry has not settled between wall-clock samples');
  },2000);
 } finally {
  if(state.length)await writeFile(path.join(artifactDir,name+'-modal-state.json'),JSON.stringify({name,sampledAt:Date.now(),state},null,2));
 }
}
async function screenshot(name,target=page,fullPage=true) {
 checkpoint('screenshot: '+name);
 // Screenshots are evidence, not a frame-scheduler assertion. Headed extension
 // pages can throttle requestAnimationFrame after resizing. Rely on the explicit
 // UI/geometry assertions, then take an ordinary bounded capture without
 // changing animation state or waiting for renderer frame callbacks.
 await eventually(async()=>assert.equal(await target.locator('.el-message:visible').count(),0));
 await settledModalEvidence(name,target);
 try {
  await target.screenshot({path:path.join(artifactDir,name+'.png'),fullPage,timeout:10000});
 } catch(error) {
  let captureError=error;
  if(String(error).includes('Page.captureScreenshot): Unable to capture screenshot')) {
   // Retry exactly this transient capture race once. Functional assertions are
   // outside this helper and are never suppressed by capture error handling.
   console.warn('Retrying transient screenshot capture:',name);
   await writeFile(path.join(artifactDir,name+'-capture-retry.json'),JSON.stringify({name,error:String(error)},null,2));
   await new Promise(resolve=>setTimeout(resolve,150));
   try {await target.screenshot({path:path.join(artifactDir,name+'.png'),fullPage,timeout:10000});return;}
   catch(retryError){captureError=retryError;}
  }
  captureErrors.push({name,error:String(captureError)});
  await writeFile(path.join(artifactDir,'capture-errors.json'),JSON.stringify(captureErrors,null,2));
  console.error('Screenshot unavailable; continuing functional assertions:',name,String(captureError));
 }

}

async function noBodyOverflow(label) {
 const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,
  overflowing:[...document.querySelectorAll('body *')].map(element=>{const r=element.getBoundingClientRect();return {tag:element.tagName,className:String(element.className),left:r.left,right:r.right,width:r.width};}).filter(element=>element.width>0&&(element.right>innerWidth+1||element.left< -1)).slice(0,30),
 }));
 if(dimensions.scroll>dimensions.width+1)await writeFile(path.join(artifactDir,'overflow-'+label.replace(/[^a-z0-9]+/gi,'-')+'.json'),JSON.stringify(dimensions,null,2));
 assert(dimensions.scroll<=dimensions.width+1,`${label}: unexpected page horizontal overflow ${JSON.stringify(dimensions)}`);
}


// Visibility alone includes off-screen controls. Check bounds and real hit targets
// without Playwright auto-scrolling first, so clipped/sticky-footer regressions fail.
async function reachable(locator, label) {
 await eventually(async()=>{
  const state=await locator.evaluate(element=>{
   const r=element.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
   return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,hit:!!hit&&element.contains(hit)};
  });
  assert(state.left>=0&&state.right<=state.width+1&&state.top>=0&&state.bottom<=state.height+1&&state.hit,`${label}: control clipped or covered ${JSON.stringify(state)}`);
 });
}
async function openNativePopupFor(sourcePage) {
  checkpoint('open native action popup');
  await sourcePage.bringToFront();
  const popupPromise=context.waitForEvent('page',{timeout:15000}).catch(error=>({popupError:String(error)}));
  if(process.env.E2E_NATIVE_POPUP==='shortcut') await execFileAsync('xdotool',['key','--clearmodifiers','ctrl+shift+y']);
  else await worker.evaluate(()=>chrome.action.openPopup());
  const cdp=await context.newCDPSession(sourcePage);const targets=await cdp.send('Target.getTargets');
  await writeFile(path.join(artifactDir,'popup-targets.json'),JSON.stringify({headed:process.env.E2E_HEADED==='1',nativePopup:process.env.E2E_NATIVE_POPUP??'openPopup',targets},null,2));
  await cdp.detach();
  const popup=await popupPromise;
  assert(!popup.popupError,`Native action popup was not exposed as a Playwright page: ${popup.popupError}; see popup-targets.json`);
  popup.on('pageerror',e=>errors.push(e.message));await popup.waitForLoadState();return popup;
}
async function nativePopupLayout(popup,label) {
 // Observe browser-managed action-window size. Never emulate a viewport on a
 // CDP `other` target: doing so hides Chrome autosizing regressions.
 const metrics=await popup.evaluate(()=>({
  width:innerWidth,scroll:document.documentElement.scrollWidth,
  headings:[...document.querySelectorAll('h1,h2')].map(element=>({text:element.textContent,height:element.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(element).fontSize)})),
  controls:[...document.querySelectorAll('input,select,button')].map(element=>({text:element.getAttribute('aria-label')||element.textContent,left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right})),
 }));
 await writeFile(path.join(artifactDir,label+'-geometry.json'),JSON.stringify(metrics,null,2));
 assert(metrics.width>=380&&metrics.width<=400,`${label}: native popup must be 380–400 CSS px, got ${metrics.width}`);
 assert(metrics.scroll<=metrics.width+1,`${label}: native popup has horizontal overflow`);
 for(const heading of metrics.headings) assert(heading.height<=heading.fontSize*1.8,`${label}: heading wraps vertically: ${JSON.stringify(heading)}`);
 for(const control of metrics.controls) assert(control.left>=0&&control.right<=metrics.width+1,`${label}: control clipped horizontally: ${JSON.stringify(control)}`);
}
async function settingsFooter(dialog,label) {
 await reachable(dialog.getByRole('button',{name:'保存并测试连接',exact:true}),label+' save/test');
 await reachable(dialog.locator('.settings-actions button').first(),label+' local/cancel action');
 const body=dialog.locator('.el-dialog__body');
 const scroll=await body.evaluate(element=>({height:element.clientHeight,scroll:element.scrollHeight,overflow:getComputedStyle(element).overflowY}));
 assert(scroll.height>0&&['auto','scroll'].includes(scroll.overflow),label+': settings body must own its scroll');
}

try {
 context = await chromium.launchPersistentContext(path.join(temp,'profile'), {
  ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {channel:'chromium'}), headless:process.env.E2E_HEADED !== '1',
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-dev-shm-usage','--disable-background-networking'],
  // Native action popups must retain their own browser-managed dimensions.
  // A context default viewport also gets applied to CDP other targets.
  viewport:null,acceptDownloads:true,
 });
 context.setDefaultTimeout(20000);
 context.setDefaultNavigationTimeout(30000);
 checkpoint('load workspace and first-run setup');
 // Even accidental page navigations cannot reach a real website.
 await context.route(/^https?:\/\//,async route=>{
  const url=new URL(route.request().url());
  if(url.protocol==='https:'&&url.hostname.endsWith('.health-fixture.test'))return healthFixture.handle(route);
  if(url.origin==='https://example.test')return route.fulfill({status:200,contentType:'text/html',body:'<title>Synthetic capture page</title><p>Synthetic fixture only</p>'});
  blockedHttpRequests.push(route.request().url());
  return route.abort();
 });
 worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const extensionId = new URL(worker.url()).host;
 const optionsUrl=`chrome-extension://${extensionId}/options.html`;
 page = await context.newPage();await page.setViewportSize({width:1440,height:1000});page.on('pageerror', e=>errors.push(e.message));
 await page.goto(optionsUrl);
 await page.getByText('Bookmark Workspace',{exact:true}).waitFor(); pass('production extension loads and workspace renders');
 const native = (fn,arg) => page.evaluate(fn,arg);
 const request = async (type, extra={}) => {
  const response = await page.evaluate(data=>chrome.runtime.sendMessage({...data,requestId:crypto.randomUUID()}),{type,...extra});
  assert.equal(response.ok,true,`${type}: ${JSON.stringify(response)}`); return response.data;
 };
 checkpoint('first-run onboarding');
 // Fresh-profile onboarding must permit a genuinely local-only path.
 const onboarding=page.getByRole('dialog',{name:'欢迎使用 · 连接你的 AI 助手',exact:true});
 await onboarding.waitFor();await screenshot('first-run-onboarding');
 for(const [width,height] of [[390,600],[768,720],[1440,1000]]) {
  await page.setViewportSize({width,height});await settingsFooter(onboarding,'onboarding '+width);
  await screenshot('first-run-onboarding-'+width+'x'+height);
 }
 await page.setViewportSize({width:390,height:600});
 await onboarding.getByRole('button',{name:'保存并测试连接',exact:true}).click();
 await reachable(onboarding.locator('.settings-feedback'),'onboarding missing-key feedback');
 await onboarding.getByText('请先输入所选区域的 API Key，再测试连接。',{exact:true}).waitFor();
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),0);
 assert.equal((await request('ASSISTANT_SETTINGS_GET')).onboardingCompleted,false);
 await screenshot('first-run-missing-key-390x600');
 pass('first-run local exit and save actions stay reachable at short/narrow sizes; missing key fails inline without a provider call');
 await onboarding.getByRole('button',{name:'稍后配置，先用本地功能',exact:true}).click();
 await onboarding.waitFor({state:'hidden'});await page.setViewportSize({width:1440,height:1000});
 assert.equal((await request('ASSISTANT_SETTINGS_GET')).onboardingCompleted,true);
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),0);
 await page.reload();await page.getByText('Bookmark Workspace',{exact:true}).waitFor();
 assert.equal(await onboarding.isVisible(),false);
 pass('first-install onboarding can be skipped persistently without any provider transmission');
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
 const openTool=async name=>{
  const tools=page.locator('details').filter({has:page.locator('summary').filter({hasText:'更多工具'})});
  if(!await tools.evaluate(element=>element.open))await tools.locator('summary').click();
  await tools.getByRole('button',{name,exact:true}).click();
 };
 const search=async text=>{await goal().fill(text);await page.getByRole('button',{name:'仅本地搜索',exact:true}).click();await eventually(async()=>assert(!(await page.locator('.el-loading-mask:visible').count())));};
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
 await search('Synthetic Guide');
 await page.waitForTimeout(1100);assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),0);
 pass('local search after skipped setup remains usable and never calls an unconfigured provider');
 checkpoint('utility menu responsive bounds');
 const utilityMenu=page.locator('.utility-menu');
 if(!await utilityMenu.evaluate(element=>element.open))await utilityMenu.locator('summary').click();
 for(const width of [390,520,768,1024,1440]) {
  await page.setViewportSize({width,height:1000});
  await noBodyOverflow('utility-menu '+width);
  await reachable(utilityMenu.getByRole('button',{name:'历史与恢复',exact:true}),'utility first action '+width);
  await reachable(utilityMenu.getByRole('button',{name:'刷新原生书签',exact:true}),'utility last action '+width);
  if(width===768)await screenshot('utility-menu-768');
 }
 await utilityMenu.locator('summary').click();
 pass('open utility menu stays fully reachable without horizontal overflow at five viewport widths');
 checkpoint('settings validation and connection');
 // Settings are entered visibly, with model validation, cancellation and explicit local opt-in.
 await page.getByRole('button',{name:'AI 设置',exact:true}).click();
 let settingsDialog=page.getByRole('dialog',{name:'AI 连接与数据范围',exact:true});
 const model=()=>settingsDialog.locator('.el-form-item').filter({hasText:'模型'}).getByRole('textbox');
 const advancedSettings=async open=>{
  const details=settingsDialog.locator('.privacy-settings');
  if(await details.evaluate(element=>element.open)!==open)await details.locator('summary').click();
 };
 await advancedSettings(true);
 await model().fill('');await settingsDialog.getByRole('button',{name:'保存设置',exact:true}).click();
 await settingsDialog.getByText('请输入模型名称。',{exact:true}).waitFor();
 await settingsDialog.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal((await request('ASSISTANT_SETTINGS_GET')).hasKey,false);
 await page.getByRole('button',{name:'AI 设置',exact:true}).click();
 await advancedSettings(true);await model().fill('MiniMax-M2.5');await advancedSettings(false);
 await settingsDialog.locator('input[type=password]').fill('synthetic-test-key');
 await choose(settingsDialog.getByRole('checkbox',{name:'在此设备记住密钥（可选）',exact:true}));
 await choose(settingsDialog.getByRole('checkbox',{name:/我同意将当前对话范围/}));
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('settings '+width);await settingsFooter(settingsDialog,'settings '+width);await screenshot('settings-'+width);}
 await page.setViewportSize({width:390,height:600});
 await advancedSettings(true);
 await settingsDialog.locator('.el-input-number').scrollIntoViewIfNeeded();
 await settingsFooter(settingsDialog,'advanced settings 390x600');await screenshot('settings-advanced-390x600');
 await advancedSettings(false);
 await page.setViewportSize({width:1440,height:1000});
 pass('settings footer remains on screen with independently scrolling advanced options at 390x600');
 await choose(settingsDialog.getByRole('checkbox',{name:'自动提供 AI 建议',exact:true}));
 await settingsDialog.getByRole('button',{name:'保存并测试连接',exact:true}).click();
 await eventually(async()=>assert.equal((await request('ASSISTANT_SETTINGS_GET')).connectionTested,true));
 await settingsDialog.waitFor({state:'hidden'});
 const connectionCalls=await worker.evaluate(()=>globalThis.__mockCalls);
 assert.equal(connectionCalls.length,1);assert.deepEqual(connectionCalls[0].messages,[{role:'user',content:'Reply with OK.'}]);
 assert.equal((await request('ASSISTANT_SETTINGS_GET')).keyStorage,'local');
 pass('settings reopen after skip, validate inline, cancel safely, and test connectivity with a fixed bookmark-free prompt');
 checkpoint('priority native popup sizing smoke');
 const earlySource=await context.newPage();await earlySource.goto('about:blank');
 const earlyUnavailable=await openNativePopupFor(earlySource);
 await earlyUnavailable.getByText('这个页面无法快捷收藏。请在普通网页中打开扩展。',{exact:true}).waitFor();
 await nativePopupLayout(earlyUnavailable,'priority-popup-unavailable');
 await screenshot('priority-popup-unavailable',earlyUnavailable,false);
 await earlyUnavailable.close();
 await earlySource.goto('https://example.test/early-capture');
 const earlyValid=await openNativePopupFor(earlySource);
 await earlyValid.getByRole('button',{name:'采用标题',exact:true}).waitFor();
 await nativePopupLayout(earlyValid,'priority-popup-valid');
 await screenshot('priority-popup-valid',earlyValid,false);
 assert.equal((await native(()=>chrome.bookmarks.search({url:'https://example.test/early-capture'}))).length,0);
 await earlyValid.close();await earlySource.close();await page.bringToFront();
 pass('priority native popup retains readable browser-managed width for unsupported and valid pages without saving');
 checkpoint('automatic guidance cancellation and scope');
 // Exercise automatic guidance separately, then isolate the existing manual journeys.
 const configuredSettings=await request('ASSISTANT_SETTINGS_GET');
 const autoCard=page.getByRole('complementary',{name:'自动 AI 建议',exact:true});
 const localOnlyCalls=await worker.evaluate(()=>globalThis.__mockCalls.length);
 await search('Synthetic Guide');await page.waitForTimeout(1100);
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),localOnlyCalls);
 assert.equal(await page.locator('.results-panel tbody tr').count(),1);
 pass('explicit local-only search stays usable with configured AI and transmits no metadata');
 await page.getByRole('button',{name:/整理书签/}).click();await autoCard.getByRole('button',{name:'查看建议详情',exact:true}).waitFor();
 const autoCall=await worker.evaluate(()=>JSON.parse(globalThis.__mockCalls.at(-1).messages.at(-1).content));
 assert.equal(autoCall.mode,'organize');assert(autoCall.bookmarks.every(bookmark=>!bookmark.snippet));assert.equal(autoCall.scope.bookmarkIds.length,1);assert.equal(autoCall.bookmarks.length,1);
 assert.equal(autoCall.bookmarks[0].title,'Synthetic Guide');
 assert.equal((await native(id=>chrome.bookmarks.get(id),ids.guide))[0].parentId,ids.nested);
 await autoCard.getByRole('button',{name:'忽略建议',exact:true}).click();await autoCard.waitFor({state:'hidden'});
 pass('entering organize produces bounded no-write suggestions that can be dismissed');
 await browse();await search('Synthetic');await worker.evaluate(()=>{globalThis.__mockMode='wait';});
 let waitingCalls=await worker.evaluate(()=>globalThis.__mockCalls.length);
 await page.getByRole('button',{name:/整理书签/}).click();
 await eventually(async()=>assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),waitingCalls+1));
 await autoCard.getByRole('button',{name:'取消本次建议',exact:true}).click();await autoCard.waitFor({state:'hidden'});
 await page.waitForTimeout(1100);assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),waitingCalls+1);
 await search('Guide');waitingCalls=await worker.evaluate(()=>globalThis.__mockCalls.length);
 await page.getByRole('button',{name:/整理书签/}).click();
 await eventually(async()=>assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),waitingCalls+1));
 await search('');await autoCard.waitFor({state:'hidden'});
 await worker.evaluate(()=>{globalThis.__mockMode='ok';});
 pass('automatic suggestions can be canceled and invalidated by changing local search; neither silently retries');
 await request('ASSISTANT_SETTINGS_SAVE',{settings:{...configuredSettings,consent:false}});await page.reload();await goal().waitFor();
 const callsWithoutConsent=await worker.evaluate(()=>globalThis.__mockCalls.length);await search('Synthetic Guide');
 await page.getByRole('button',{name:'开始任务',exact:true}).click();
 await page.waitForTimeout(1100);assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),callsWithoutConsent);assert.equal(await autoCard.count(),0);
 pass('saved and tested key without metadata consent never triggers automatic search');
 await request('ASSISTANT_SETTINGS_SAVE',{settings:{...configuredSettings,autoSuggestions:false}});
 await page.reload();await goal().waitFor();
 await worker.evaluate(()=>{globalThis.__mockCalls=[];});
 checkpoint('multi-turn task context and history');
 // No backend-generated session or turn: the real goal composer creates and sends every turn.
 await worker.evaluate(()=>{globalThis.__mockMode='stream-gated';});
 await goal().fill('Organize Synthetic Guide; only beginner-friendly Chinese sources');await page.getByRole('button',{name:'开始任务',exact:true}).click();
 const provisional=page.getByRole('article',{name:'正在生成的回复',exact:true});
 await provisional.getByText('Synthetic',{exact:true}).waitFor();
 await page.locator('.local-task-results').waitFor();
 assert.equal(await provisional.locator('a,button,.message-references').count(),0);
 assert.equal(await page.getByRole('button',{name:'审核整理建议（1）',exact:true}).count(),0);
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.at(-1).stream),true);
 await screenshot('conversation-streaming-partial');
 assert.equal(await worker.evaluate(()=>globalThis.__releaseStream()),true);
 await page.getByText('Synthetic answer 1',{exact:true}).waitFor();
 await provisional.waitFor({state:'hidden'});
 await worker.evaluate(()=>{globalThis.__mockMode='ok';});
 pass('streaming renders real provisional text before validated references or action controls; final reply replaces the preview');
 const firstResultIds=await page.locator('.task-result-list .citation-id').allTextContents();
 assert.equal(firstResultIds.length,2);
 await goal().fill('Explain the second item; retain the beginner-friendly Chinese-source requirement');await page.getByRole('button',{name:'继续任务',exact:true}).click();
 await page.getByText('Synthetic answer 2',{exact:true}).waitFor();
 const secondResultIds=await page.locator('.task-result-list .citation-id').allTextContents();
 assert.deepEqual(secondResultIds,[...firstResultIds].reverse(),'Reordered visible results retain source IDs');
 assert.equal(await page.getByText('Synthetic answer 1',{exact:true}).isVisible(),false);
 const secondContext=await worker.evaluate(()=>JSON.parse(globalThis.__mockCalls.at(-1).messages.at(-1).content));
 assert.equal(secondContext.taskContext.objective,'Organize Synthetic Guide; only beginner-friendly Chinese sources');
 assert.equal(secondContext.taskContext.resultOrder[1].citationId,firstResultIds[1]);
 await goal().fill('Make a concise reading plan with the same constraints');await page.getByRole('button',{name:'继续任务',exact:true}).click();
 await page.getByText('Synthetic answer 3',{exact:true}).waitFor();
 const thirdContext=await worker.evaluate(()=>JSON.parse(globalThis.__mockCalls.at(-1).messages.at(-1).content));
 assert(thirdContext.taskContext.refinements.includes('Explain the second item; retain the beginner-friendly Chinese-source requirement'));
 assert.equal(thirdContext.taskContext.resultOrder[1].citationId,secondResultIds[1]);
 pass('task-first local results precede validated AI sources; follow-up constraints and displayed ordinal IDs survive reordering');
 const sessions=await request('ASSISTANT_SESSIONS');const session=await request('ASSISTANT_GET',{sessionId:sessions[0].id});
 assert.equal(session.messages.length,6);assert.equal(session.messages[1].references[0].citationId,session.messages[3].references[1].citationId);
 assert.equal(session.citations[0].url,'https://example.test/guide?Original=YES#frag');
 const calls=await worker.evaluate(()=>globalThis.__mockCalls);assert.equal(calls.length,3);
 // Full local history survives; outbound history deliberately keeps only the last
 // exchange plus structured task context, without retransmitting stale candidates.
 assert.deepEqual(session.messages.filter(message=>message.role==='user').map(message=>message.text),[
  'Organize Synthetic Guide; only beginner-friendly Chinese sources',
  'Explain the second item; retain the beginner-friendly Chinese-source requirement',
  'Make a concise reading plan with the same constraints',
 ]);
 for(const call of calls.slice(1)) {
  assert.deepEqual(call.messages.map(message=>message.role),['system','user','assistant','user']);
  assert.deepEqual(Object.keys(JSON.parse(call.messages[1].content)),['request'],'Historical user exchange must not carry old candidate metadata');
 }
 assert.equal(JSON.parse(calls[2].messages[1].content).request,session.messages[2].text);
 assert.equal(JSON.parse(calls[2].messages[2].content).text,'Synthetic answer 2');
 assert.equal(thirdContext.taskContext.objective,session.messages[0].text);
 assert.deepEqual(thirdContext.taskContext.refinements,[session.messages[2].text]);
 await page.reload();await eventually(async()=>assert.equal(await goal().inputValue(),''));await openTool('历史与恢复');
 await page.getByRole('button',{name:/Organize Synthetic Guide/}).click();await page.getByRole('dialog',{name:'历史与恢复',exact:true}).waitFor({state:'hidden'});
 assert.equal(await page.getByRole('dialog',{name:'切换对话',exact:true}).count(),0);await page.getByText('Synthetic answer 3',{exact:true}).waitFor();
 pass('visible multi-turn AI composer retains full context, exact URL, stable citation and history after reload');
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
 checkpoint('inverse-plan recovery');
 // Recovery is a real visible inverse-plan review, not a hidden runtime approval.
 await page.getByRole('button',{name:'预览恢复',exact:true}).click();await approve(true);
 assert.equal((await native(id=>chrome.bookmarks.get(id),ids.guide))[0].parentId,ids.nested);
 pass('visible completed-plan recovery preview restores original native bookmark position');
 checkpoint('duplicate review and deletion');
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
 await browse();await page.getByRole('button',{name:'选择目录',exact:true}).click();
 await page.getByRole('dialog',{name:'我的书签目录',exact:true}).getByText(ids.rootTitle,{exact:true}).click();
 await page.getByRole('button',{name:/整理书签/}).click();assert.equal(await page.locator('.duplicates-section').count(),0);
 await browse();await page.getByRole('button',{name:'选择目录',exact:true}).click();await page.getByRole('button',{name:'▤ 全部书签',exact:true}).click();
 pass('changing directory invalidates previous duplicate results');
 checkpoint('manual bookmark editor');
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
 checkpoint('tools and import recovery');
 // Local search and tools have separate state. Import recovery uses the file chooser and visible approval.
 await search('Synthetic Guide');await page.getByRole('link',{name:'Synthetic Guide ↗',exact:true}).waitFor();
 await openTool('导入 / 导出');
 const toolsDialog=page.getByRole('dialog',{name:'书签工具',exact:true});await toolsDialog.waitFor();
 assert.equal(await page.locator('.results-panel tbody tr').count(),1);
 assert((await page.locator('.results-panel tbody').innerText()).includes('Synthetic Guide'));
 await closeDialog(toolsDialog);assert.equal(await goal().inputValue(),'Synthetic Guide');
 pass('opening and closing tools preserves local search and the main result table');
 // Delete only this run's synthetic source to prove nested additive recovery from the exported snapshot.
 await native(id=>chrome.bookmarks.removeTree(id),ids.source);await request('SYNC');
 await openTool('导入 / 导出');
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
 checkpoint('link-health rendering');
 // The native browser transport runs only against intercepted synthetic HTTP.
 await assertHealthHttpMatrix({native,request,fixture:healthFixture,root:ids.root,eventually,pass,blockedHttpRequests,onResults:async()=>{await openTool('链接健康');await screenshot('health-controlled-http-matrix');await closeDialog(toolsDialog);},writeEvidence:data=>writeFile(path.join(artifactDir,'health-http-matrix.json'),JSON.stringify(data,null,2))});
 await native(async root=>{await chrome.bookmarks.create({parentId:root,title:'Synthetic unsafe protocol',url:'javascript:void(0)'});},ids.root);await request('SYNC');
 await openTool('链接健康');
 await toolsDialog.getByText('javascript:void(0)',{exact:true}).waitFor();
 assert.equal(await toolsDialog.locator('a[href^="javascript:"],a[href^="data:"]').count(),0);
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('health '+width);await reachable(toolsDialog.getByRole('button',{name:'返回工作台',exact:true}),'health close '+width);await screenshot('health-'+width);}
 await closeDialog(toolsDialog);pass('health leaves unsafe schemes nonclickable and fits four viewport sizes');
 checkpoint('stale conversation protection');
 // Historical candidate IDs were deleted and restored under new IDs. Reusing that
 // conversation must fail before transmitting its stale private history.
 const callsBeforeStaleHistory=await worker.evaluate(()=>globalThis.__mockCalls.length);
 await goal().fill('Continue after synthetic recovery');await page.getByRole('button',{name:'继续任务',exact:true}).click();
 await page.locator('.main-pane > .el-alert').waitFor();
 await eventually(async()=>assert(!(await goal().isDisabled())));
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),callsBeforeStaleHistory);
 await goal().fill('');await page.getByRole('button',{name:'新任务',exact:true}).click();
 pass('stale private conversation history is blocked before provider transmission; visible new-task action starts cleanly');
 checkpoint('provider failure and cancellation');
 // Provider failures and cancellation retain the user's prompt and allow a later successful retry.
 await worker.evaluate(()=>{globalThis.__mockMode='error';});await goal().fill('Synthetic retry request');
 await page.getByRole('button',{name:/^(开始任务|继续任务)$/}).click();await page.getByText('AI 请求暂时受限，请稍后重试，并检查服务账户的额度与调用频率。',{exact:true}).waitFor();assert.equal(await goal().inputValue(),'Synthetic retry request');
 const beforeCancelCalls=await worker.evaluate(()=>globalThis.__mockCalls.length);
 await worker.evaluate(()=>{globalThis.__mockMode='stream-gated';});await page.getByRole('button',{name:/^(开始任务|继续任务)$/}).click();
 await eventually(async()=>assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),beforeCancelCalls+1));
 await provisional.getByText('Synthetic',{exact:true}).waitFor();
 const historyBeforeCancel=await request('ASSISTANT_SESSIONS');
 await page.getByRole('button',{name:'取消生成',exact:true}).click();await eventually(async()=>assert(!(await goal().isDisabled())));
 assert.equal(await goal().inputValue(),'Synthetic retry request');
 await provisional.waitFor({state:'hidden'});
 await worker.evaluate(()=>globalThis.__releaseStream());
 assert.deepEqual(await request('ASSISTANT_SESSIONS'),historyBeforeCancel);
 assert.equal(await provisional.count(),0);
 await screenshot('conversation-stream-cancelled');
 await worker.evaluate(()=>{globalThis.__mockMode='ok';});await page.getByRole('button',{name:/^(开始任务|继续任务)$/}).click();await eventually(async()=>assert.equal(await goal().inputValue(),''));
 pass('visible provider error and cancellation preserve the prompt; retry completes successfully');
 checkpoint('selected bookmark scope');
 // Selection scope freezes an explicitly selected native bookmark, independently of search text.
 await search('Synthetic Manual Edited');let scopedRow=page.locator('.results-panel tbody tr').filter({hasText:'Synthetic Manual Edited'});
 await choose(scopedRow.getByRole('checkbox'));await goal().fill('');await page.getByRole('button',{name:'AI 整理所选',exact:true}).click();
 await page.getByRole('button',{name:'开始任务',exact:true}).click();await eventually(async()=>assert.equal(await goal().inputValue(),''));
 const scopeCall=await worker.evaluate(()=>JSON.parse(globalThis.__mockCalls.at(-1).messages.at(-1).content));
 assert.equal(scopeCall.scope.bookmarkIds.length,1);assert.equal(scopeCall.bookmarks.length,1);assert.equal(scopeCall.bookmarks[0].title,'Synthetic Manual Edited');
 pass('selected-bookmark AI task transmits exactly the frozen selection, not all search results');
 checkpoint('virtual themes and task resume');
 await page.getByRole('button',{name:'新任务',exact:true}).click();
 // Element Plus overlays its internal input with the visible selected label.
 // Click the actual user-facing select, then verify its accessible expanded state.
 const taskScope=page.locator('.task-context .el-select');
 const taskScopeInput=taskScope.getByRole('combobox',{name:'新任务的书签范围',exact:true});
 await reachable(taskScope,'new-task scope selector');
 await taskScope.click();
 assert.equal(await taskScopeInput.getAttribute('aria-expanded'),'true');
 await page.getByRole('option',{name:'全部书签',exact:true}).click();
 await taskScope.getByText('全部书签',{exact:true}).waitFor();
 assert.equal(await taskScopeInput.getAttribute('aria-expanded'),'false');
 const treeBeforeThemes=await native(()=>chrome.bookmarks.getTree());
 await worker.evaluate(()=>{globalThis.__mockMode='theme';});
 await goal().fill('Group my synthetic reading sources into a useful theme');
 await page.getByRole('button',{name:'开始任务',exact:true}).click();
 const themes=page.getByRole('navigation',{name:'虚拟主题视图',exact:true});
 await themes.getByRole('button',{name:'Synthetic AI Folder · 2',exact:true}).waitFor();
 assert.deepEqual(await worker.evaluate(()=>JSON.parse(globalThis.__mockCalls.at(-1).messages.at(-1).content).scope),{},'New theme task must use the visibly selected all-bookmarks scope');
 await themes.getByText('不改变原生目录',{exact:true}).waitFor();
 await themes.getByRole('button',{name:'Synthetic AI Folder · 2',exact:true}).click();
 assert.equal(await page.locator('.results-panel tbody tr').count(),2);
 await page.getByText(/虚拟主题 · 2 个书签/).waitFor();
 assert.deepEqual(await native(()=>chrome.bookmarks.getTree()),treeBeforeThemes);
 await screenshot('virtual-theme-without-native-mutation');
 await themes.getByRole('button',{name:'隐藏主题 Synthetic AI Folder',exact:true}).click();
 await page.reload();await goal().waitFor();
 assert.equal(await themes.getByRole('button',{name:'Synthetic AI Folder · 2',exact:true}).count(),0);
 await page.getByRole('button',{name:'新任务',exact:true}).click();
 const recent=page.getByLabel('最近任务',{exact:true});
 await recent.getByRole('button',{name:/Group my synthetic reading sources/}).click();
 await page.getByRole('region',{name:'本轮来源引用',exact:true}).waitFor();
 assert.equal(await page.locator('.task-result-list li').count(),2);
 assert.deepEqual(await native(()=>chrome.bookmarks.getTree()),treeBeforeThemes);
 await worker.evaluate(()=>{globalThis.__mockMode='ok';});
 pass('virtual themes group validated suggestions without native mutation; dismissal persists and recent task resumes');
 checkpoint('review conflicts preserve concurrent native changes');
 await search('Synthetic Manual Edited');
 const conflictRow=page.locator('.results-panel tbody tr').filter({hasText:'Synthetic Manual Edited'});
 await conflictRow.getByRole('button',{name:'编辑',exact:true}).click();
 const conflictEditor=page.getByRole('dialog',{name:'编辑书签',exact:true});
 await conflictEditor.locator('#bookmark-editor-title').fill('Synthetic proposed overwrite');
 await conflictEditor.getByRole('button',{name:'预览更改',exact:false}).click();
 await exportPlan('synthetic-conflict-backup.json');
 await native(id=>chrome.bookmarks.update(id,{title:'Synthetic concurrent native edit'}),manual.id);
 await choose(page.locator('.approval-box').getByRole('checkbox',{name:'已逐项核对并批准以上更改',exact:true}));
 await page.locator('.approval-box').getByRole('button',{name:/^批准并执行/}).click();
 await page.getByText(/书签或会话已变化|原生书签已变化/).first().waitFor();
 assert.equal((await native(id=>chrome.bookmarks.get(id),manual.id))[0].title,'Synthetic concurrent native edit');
 assert.equal((await native(()=>chrome.bookmarks.search({title:'Synthetic proposed overwrite'}))).length,0);
 await screenshot('native-conflict-blocks-overwrite');
 pass('reviewed snapshot conflict blocks stale writes and preserves a concurrent native edit');
 await browse();await search('');
 // The product debounces local filtering by 200ms. Await the actual complete
 // result set before responsive evidence, rather than capturing old filtered rows.
 const clearedResults=await request('BOOKMARKS_LIST',{query:'',limit:200,offset:0});
 await eventually(async()=>assert.equal(await page.locator('.results-panel tbody tr').count(),clearedResults.rows.length));
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('workspace '+width);await page.locator('.goal-form').scrollIntoViewIfNeeded();await reachable(page.getByRole('button',{name:'仅本地搜索',exact:true}),'local search '+width);await screenshot('workspace-'+width);}
 await goal().focus();await page.keyboard.type('Synthetic Guide');await page.getByRole('button',{name:'仅本地搜索',exact:true}).click();
 await page.getByRole('link',{name:'Synthetic Guide ↗',exact:true}).waitFor();await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.activeElement!==document.body));
 pass('workspace responsive screenshots and keyboard-driven local search work');
 checkpoint('sidepanel responsive rendering');
 // Sidepanel document runs the same full workspace at realistic narrow widths.
 await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);await page.getByRole('textbox',{name:'搜索书签或描述你的目标',exact:true}).waitFor();
 for(const width of [390,768,1024,1440]){await page.setViewportSize({width,height:1000});await noBodyOverflow('sidepanel '+width);await screenshot('sidepanel-'+width);}
 pass('sidepanel document loads the complete workspace without horizontal overflow');
 await request('ASSISTANT_SETTINGS_SAVE',{settings:{...await request('ASSISTANT_SETTINGS_GET'),autoSuggestions:true}});
 // Opening popup.html as a tab cannot reproduce Chrome's activeTab grant. Use the real extension action popup.
 const sourcePage=await context.newPage();await sourcePage.goto('https://example.test/capture?Keep=YES#frag');await sourcePage.bringToFront();
 const openNativePopup=()=>openNativePopupFor(sourcePage);
 // Exercise an unsupported page first: the minimal initial content must not
 // collapse native autosizing before a later valid-page capture opens.
 await sourcePage.goto('about:blank');
 const unavailableCalls=await worker.evaluate(()=>globalThis.__mockCalls.length);
 const unavailablePopup=await openNativePopup();
 await unavailablePopup.getByText('这个页面无法快捷收藏。请在普通网页中打开扩展。',{exact:true}).waitFor();
 await nativePopupLayout(unavailablePopup,'popup-unavailable-page');
 assert.equal(await unavailablePopup.locator('button.primary').count(),0);
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),unavailableCalls);
 await screenshot('popup-unavailable-page',unavailablePopup,false);
 await unavailablePopup.close();
 pass('native unsupported-page popup retains readable width and headings without capture or provider calls');
 await sourcePage.goto('https://example.test/capture?Keep=YES#frag');
 const popup=await openNativePopup();
 await popup.getByRole('button',{name:'采用标题',exact:true}).waitFor();
 await nativePopupLayout(popup,'popup-unsaved-page');
 await screenshot('popup-unsaved-inline-advice',popup,false);
 assert.equal(await popup.getByLabel('标题',{exact:true}).inputValue(),'Synthetic capture page');
 const originalFolder=await popup.getByLabel('保存到',{exact:true}).inputValue();
 assert.notEqual(originalFolder,ids.target);
 const popupAdviceCall=await worker.evaluate(()=>JSON.parse(globalThis.__mockCalls.at(-1).messages.at(-1).content));
 assert.equal(popupAdviceCall.page.url,'https://example.test/capture?Keep=YES#frag');
 await popup.getByRole('button',{name:'采用标题',exact:true}).click();
 assert.equal(await popup.getByLabel('保存到',{exact:true}).inputValue(),originalFolder);
 await popup.getByRole('button',{name:'采用位置',exact:true}).click();
 assert.equal(await popup.getByLabel('标题',{exact:true}).inputValue(),'Synthetic advised title');
 assert.equal(await popup.getByLabel('保存到',{exact:true}).inputValue(),ids.target);
 assert.equal((await native(()=>chrome.bookmarks.search({url:'https://example.test/capture?Keep=YES#frag'}))).length,0);
 pass('native popup offers inline advice only after local lookup; applying each field leaves the other untouched and never saves');
 await popup.getByLabel('标题',{exact:true}).fill('Synthetic Quick Save');
 await popup.getByRole('button',{name:'确认收藏',exact:true}).click();await popup.getByRole('button',{name:'✓ 已收藏',exact:true}).waitFor();
 await popup.locator('.lookup > summary').click();
 await popup.getByRole('searchbox',{name:'搜索已有书签',exact:true}).fill('Synthetic Quick Save');
 await popup.getByRole('button',{name:/Synthetic Quick Save.*example\.test/}).waitFor();
 const quick=(await native(()=>chrome.bookmarks.search({title:'Synthetic Quick Save'})))[0];assert.equal(quick.url,'https://example.test/capture?Keep=YES#frag');
 await screenshot('popup-quick-save',popup,false);
 pass('real extension action popup saves the active synthetic page and finds it through local search');
 await popup.close();
 // Create another native copy without requesting SYNC. Capture status must read
 // current native membership and display every location, not a cached index hit.
 await native(async ({root,url})=>{
  const folder=await chrome.bookmarks.create({parentId:root,title:'Synthetic Fresh Capture Folder'});
  await chrome.bookmarks.create({parentId:folder.id,title:'Synthetic Fresh Native Copy',url});
 },{root:ids.root,url:'https://example.test/capture?Keep=YES#frag'});
 const callsBeforeExisting=await worker.evaluate(()=>globalThis.__mockCalls.length);
 const existingPopup=await openNativePopup();
 await existingPopup.getByText('这个页面已收藏',{exact:true}).waitFor();
 await nativePopupLayout(existingPopup,'popup-existing-page');
 const savedStatus=existingPopup.locator('.saved-status');
 await savedStatus.getByText(/Synthetic Fresh Capture Folder/).waitFor();
 assert.equal(await savedStatus.getByRole('button',{name:'查看',exact:true}).count(),2);
 assert.equal(await savedStatus.getByRole('button',{name:'编辑已有书签',exact:true}).count(),2);
 await existingPopup.waitForTimeout(1200);
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),callsBeforeExisting);
 assert.equal(await existingPopup.locator('.inline-suggestion').count(),0);
 assert.equal((await native(()=>chrome.bookmarks.search({url:'https://example.test/capture?Keep=YES#frag'}))).length,2);
 await screenshot('popup-existing-locations',existingPopup,false);
 pass('reopened native popup shows both saved locations without explicit index sync and offers view/edit with zero automatic AI calls');
 await existingPopup.close();
 // A failed authoritative membership read must not be interpreted as unsaved.
 await sourcePage.goto('https://example.test/unknown-capture');
 await worker.evaluate(()=>{globalThis.__realGetTree=chrome.bookmarks.getTree;chrome.bookmarks.getTree=async()=>{throw new Error('Synthetic native lookup failure');};});
 const callsBeforeUnknown=await worker.evaluate(()=>globalThis.__mockCalls.length);
 const unknownPopup=await openNativePopup();
 await unknownPopup.getByText('暂时无法确认收藏状态，已暂停建议',{exact:false}).waitFor();
 await unknownPopup.getByRole('button',{name:'重新检查',exact:true}).waitFor();
 await unknownPopup.waitForTimeout(1200);
 assert.equal(await worker.evaluate(()=>globalThis.__mockCalls.length),callsBeforeUnknown);
 assert.equal(await unknownPopup.locator('.inline-suggestion').count(),0);
 await screenshot('popup-lookup-error',unknownPopup,false);
 await worker.evaluate(()=>{chrome.bookmarks.getTree=globalThis.__realGetTree;delete globalThis.__realGetTree;});
 await unknownPopup.getByRole('button',{name:'重新检查',exact:true}).click();
 await unknownPopup.getByRole('button',{name:'采用标题',exact:true}).waitFor();
 assert.equal((await native(()=>chrome.bookmarks.search({url:'https://example.test/unknown-capture'}))).length,0);
 await screenshot('popup-lookup-recovered',unknownPopup,false);
 await unknownPopup.close();
 pass('native lookup retry recovers inline advice without saving a bookmark');
 pass('failed native capture lookup pauses automatic advice instead of treating unknown status as a new bookmark');
 checkpoint('one-click capture while AI is pending');
 await sourcePage.goto('https://example.test/fast-capture');
 await worker.evaluate(()=>{globalThis.__mockMode='wait';});
 const fastPopup=await openNativePopup();
 await fastPopup.getByText('正在看看有没有更合适的标题和位置…',{exact:true}).waitFor();
 const fastSave=fastPopup.getByRole('button',{name:'确认收藏',exact:true});
 assert.equal(await fastSave.isEnabled(),true,'Pending advice cannot disable local capture');
 await fastSave.click();
 await fastPopup.getByRole('button',{name:'✓ 已收藏',exact:true}).waitFor();
 const fastSaved=await native(()=>chrome.bookmarks.search({url:'https://example.test/fast-capture'}));
 assert.equal(fastSaved.length,1);assert.equal(fastSaved[0].title,'Synthetic capture page');
 await screenshot('popup-save-without-ai-delay',fastPopup,false);
 await fastPopup.close();await worker.evaluate(()=>{globalThis.__mockMode='ok';});
 pass('one-click native capture completes with unchanged title while AI response is indefinitely pending');
 assert.deepEqual(errors,[]);pass('no uncaught workspace page errors');
 assert.deepEqual(captureErrors,[],'Functional checks completed but visual evidence is incomplete; see capture-errors.json');
 await writeFile(path.join(artifactDir,'report.json'),JSON.stringify(report({status:'passed'}),null,2));
 console.log(`Artifacts: ${artifactDir}`);
} catch(error) {
 // Save the assertion failure before asking a possibly unhealthy browser for
 // diagnostics. Neither screenshot capture nor cleanup may swallow this report.
 await writeFile(path.join(artifactDir,'report.json'),JSON.stringify(report({failure:String(error)}),null,2));
 if(page){
  await bounded(page.screenshot({path:path.join(artifactDir,'failure.png'),fullPage:true,timeout:5000}),6000,'failure screenshot').catch(diagnostic=>console.error(String(diagnostic)));
  console.error((await page.locator('body').innerText({timeout:5000}).catch(()=>'' )).slice(0,6000));
 }
 throw error;
} finally {
 try {
  if(context)await bounded(context.close(),10000,'isolated browser cleanup');
  await bounded(rm(temp,{recursive:true,force:true}),5000,'temporary profile cleanup');
 } catch(cleanupError) {
  console.error(String(cleanupError));
  writeFileSync(path.join(artifactDir,'cleanup-error.json'),JSON.stringify(report({failure:String(cleanupError)}),null,2));
  // Unclosed Chromium transports can otherwise keep Node alive indefinitely.
  process.exitCode=1;setTimeout(()=>process.exit(1),1000).unref();
 } finally {clearTimeout(watchdog);}
}
