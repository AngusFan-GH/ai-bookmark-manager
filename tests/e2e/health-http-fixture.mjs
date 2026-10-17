/** Controlled HTTP responses, intercepted below native browser fetch.
 * No server, DNS request, production guard bypass, credentials or real site.
 * A worker-origin route must be observed: missing SW interception fails the test.
 */
import assert from 'node:assert/strict';

export const HEALTH_FIXTURE_ORIGIN = 'https://*.health-fixture.test/*';
const cases = ['fallback','missing','gone','forbidden','limited','retry','redirect','soft404','login','timeout','cancel'];
export const healthFixtureUrl = name => `https://${name}.health-fixture.test/probe`;

export function createHealthHttpFixture() {
 const requests=[];
 const pending=[];
 async function handle(route) {
  const request=route.request();const url=new URL(request.url());
  const name=url.hostname.split('.')[0];
  assert(cases.includes(name)&&url.pathname==='/probe','Unexpected synthetic health target: '+url.href);
  const item={name,url:url.href,method:request.method(),worker:!!request.serviceWorker(),at:Date.now(),headers:await request.allHeaders()};
  requests.push(item);
  assert(item.worker,'Health transport must originate in the extension service worker');
  assert.equal(item.headers.cookie,undefined,'Health probes must omit cookies');
  assert.equal(item.headers.authorization,undefined,'Health probes must omit credentials');
  if(name==='timeout'||name==='cancel') { pending.push(route);return; }
  const method=item.method;const attempts=requests.filter(r=>r.name===name&&r.method===method).length;
  let status=200;let body='<html><title>Fixture document</title><main>Readable synthetic content</main></html>';
  const headers={'content-type':'text/html; charset=utf-8'};
  if(name==='fallback')status=method==='HEAD'?405:200;
  if(name==='missing')status=404;
  if(name==='gone')status=410;
  if(name==='forbidden')status=403;
  if(name==='limited'){status=429;headers['retry-after']='2';}
  if(name==='retry')status=attempts===1?503:200;
  if(name==='redirect'){status=302;headers.location='http://127.0.0.1/never-contact-this';}
  if(name==='soft404')body='<html><title>404 Page Not Found</title><h1>Page not found</h1><p>The requested page does not exist.</p></html>';
  if(name==='login')body='<html><title>Sign in to continue</title><form><input type="password"><button>Sign in</button></form></html>';
  item.status=status;
  await route.fulfill({status,headers,body:method==='HEAD'?'':body});
 }
 return {requests,handle,async dispose(){await Promise.all(pending.map(route=>route.abort().catch(()=>{})));}};
}

export async function assertHealthHttpMatrix({native,request,fixture,root,eventually,pass,writeEvidence,onResults,blockedHttpRequests=[]}) {
 const stableTree=nodes=>nodes.map(({id,title,url,parentId,index,children})=>({id,title,url,parentId,index,...(children?{children:stableTree(children)}:{})}));
 const initial=stableTree(await native(()=>chrome.bookmarks.getTree()));
 const folder=await native(root=>chrome.bookmarks.create({parentId:root,title:'Controlled HTTP acceptance'}),root);
 try {
  const browserIds={};
  for(const name of cases)browserIds[name]=(await native(data=>chrome.bookmarks.create(data),{parentId:folder.id,title:'Controlled HTTP '+name,url:healthFixtureUrl(name)})).id;
  await request('SYNC');
  // Native create events also schedule a 350ms background reconciliation. Wait
  // for its observable generation to settle before freezing scan evidence, or a
  // genuine later sync would correctly mark every result outdated mid-test.
  let rows;
  await eventually(async()=>{
   const before=(await request('BOOKMARKS_LIST',{limit:1000})).rows;
   await new Promise(resolve=>setTimeout(resolve,500));
   const after=(await request('BOOKMARKS_LIST',{limit:1000})).rows;
   assert.deepEqual(after.map(row=>[row.id,row.syncGeneration]),before.map(row=>[row.id,row.syncGeneration]),'Fixture index reconciliation is still pending');
   rows=after;
  });
  const ids=Object.fromEntries(cases.map(name=>[name,rows.find(row=>row.browserId===browserIds[name])?.id]));
  assert(Object.values(ids).every(Boolean),'Every HTTP fixture must be in the real bookmark index');
  const scanCases=cases.filter(name=>name!=='cancel');
  await request('HEALTH_START',{bookmarkIds:scanCases.map(name=>ids[name])});
  await eventually(async()=>assert.equal((await request('HEALTH_STATUS')).status,'completed'),90000);
  const checked=(await request('HEALTH_LIST')).rows;
  const get=name=>{const row=checked.find(row=>row.bookmarkId===ids[name]);assert(row,'Missing result: '+name);return row;};
  const expected={fallback:'healthy',missing:'repeated_not_found',gone:'repeated_not_found',forbidden:'forbidden',limited:'rate_limited',retry:'healthy',redirect:'redirect_pending',soft404:'suspected_soft_404',login:'suspected_login',timeout:'network_error'};
  for(const [name,status] of Object.entries(expected))assert.equal(get(name).status,status,name+': '+JSON.stringify(get(name)));
  assert.deepEqual(fixture.requests.filter(r=>r.name==='fallback').map(r=>r.method),['HEAD','GET']);
  for(const name of ['missing','gone']){
   assert(fixture.requests.filter(r=>r.name===name&&r.method==='GET').length>=2,name+' must have repeated bounded GET evidence');
   const observations=get(name).observations;
   assert(observations.filter(item=>item.method==='GET'&&[404,410].includes(item.httpCode)&&Number.isFinite(item.checkedAt)).length>=2,name+' must preserve dated structured evidence');
  }
  assert(fixture.requests.some(r=>r.name==='retry'&&r.status===503)&&fixture.requests.some(r=>r.name==='retry'&&r.status===200),'Retry must recover after actual intercepted 503 responses');
  assert.deepEqual(fixture.requests.filter(r=>r.name==='limited').map(r=>r.method),['HEAD'],'429 must honor rate limit without GET');
 assert(get('limited').retryAt>get('limited').checkedAt,'429 exposes retry time');
  assert(!blockedHttpRequests.some(url=>url.startsWith('http://127.0.0.1/never-contact-this')),'Browser must never attempt the private redirect destination, even when the harness would abort it');
  assert.equal(fixture.requests.filter(r=>r.name==='redirect').length,1,'Opaque redirect must not trigger GET or follow the private target');
  assert.equal(get('timeout').errorCode,'abort');
  assert(fixture.requests.some(r=>r.name==='soft404'&&r.method==='GET'),'200 error-page classification requires bounded body GET');
  await writeEvidence({requests:fixture.requests,results:scanCases.map(get)});
  if(onResults)await onResults();
  pass('controlled browser HTTP routes exercise native extension fetch: HEAD fallback, repeated 404/410, 403, 429, retry, opaque redirect, soft 404/login and timeout');
  const beforeCancel=(await request('HEALTH_LIST')).rows.find(row=>row.bookmarkId===ids.cancel);
  await request('HEALTH_START',{bookmarkIds:[ids.cancel]});
  await eventually(async()=>assert(fixture.requests.some(r=>r.name==='cancel')));
  await request('HEALTH_CANCEL');
  await eventually(async()=>{const status=await request('HEALTH_STATUS');assert.equal(status.status,'cancelled');assert.equal(status.inflight,0);});
  const afterCancel=(await request('HEALTH_LIST')).rows.find(row=>row.bookmarkId===ids.cancel);
  assert.deepEqual(afterCancel,beforeCancel,'Cancelled probe must not publish late classification');
  assert.equal(fixture.requests.filter(r=>r.name==='cancel').length,1,'Cancel must not start fallback GET');
  await writeEvidence({requests:fixture.requests,results:scanCases.map(get),cancelled:true});
  pass('real in-flight browser health request cancels without late result or fallback request');
 } finally {
  await request('HEALTH_CANCEL');await fixture.dispose();
  await native(id=>chrome.bookmarks.removeTree(id),folder.id);await request('SYNC');
 }
 // Fixture creation/removal must leave all preexisting user-like native data intact.
 assert.deepEqual(stableTree(await native(()=>chrome.bookmarks.getTree())),initial);
}
