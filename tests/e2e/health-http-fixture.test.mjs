/** Fixture contract checks only; these are NOT browser acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHealthHttpFixture,healthFixtureUrl} from './health-http-fixture.mjs';
function route(name,method='HEAD',worker=true) {
 const result={};return {result,request:()=>({url:()=>healthFixtureUrl(name),method:()=>method,serviceWorker:()=>worker?{}:null,allHeaders:async()=>({})}),fulfill:async response=>{result.response=response;},abort:async()=>{result.aborted=true;}};
}
test('controlled HTTP matrix retains HEAD/GET and conservative signals',async()=>{
 const fixture=createHealthHttpFixture();
 const head=route('fallback');await fixture.handle(head);assert.equal(head.result.response.status,405);
 const get=route('fallback','GET');await fixture.handle(get);assert.equal(get.result.response.status,200);assert.match(get.result.response.body,/Readable synthetic/);
 for(const [name,status] of [['missing',404],['gone',410],['forbidden',403],['limited',429],['redirect',302]]){
  const current=route(name);await fixture.handle(current);assert.equal(current.result.response.status,status);
 }
 const redirect=route('redirect');await fixture.handle(redirect);assert.equal(redirect.result.response.headers.location,'http://127.0.0.1/never-contact-this');
 const soft=route('soft404','GET');await fixture.handle(soft);assert.equal(soft.result.response.status,200);assert.match(soft.result.response.body,/Page not found/);
 for(const method of ['HEAD','GET']){
  const first=route('retry',method);await fixture.handle(first);assert.equal(first.result.response.status,503);
  const second=route('retry',method);await fixture.handle(second);assert.equal(second.result.response.status,200);
 }
 assert.equal(fixture.requests.every(request=>request.worker),true);
});
test('fixture rejects unrecognized requests or a non-worker route',async()=>{
 await assert.rejects(()=>createHealthHttpFixture().handle(route('unknown')),/Unexpected synthetic/);
 await assert.rejects(()=>createHealthHttpFixture().handle(route('fallback','HEAD',false)),/service worker/);
});
test('hanging HTTP cases do not resolve before cleanup',async()=>{
 const fixture=createHealthHttpFixture();const timeout=route('timeout');const cancel=route('cancel');
 await fixture.handle(timeout);await fixture.handle(cancel);
 assert.deepEqual(timeout.result,{});assert.deepEqual(cancel.result,{});
 await fixture.dispose();assert.equal(timeout.result.aborted,true);assert.equal(cancel.result.aborted,true);
});
