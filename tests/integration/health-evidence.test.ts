import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectContentSignal } from '../../src/domain/health/content-signals';
import { HealthService, type HealthServiceDeps } from '../../src/domain/health/service';
import { TaskScheduler, type SchedulerDeps } from '../../src/domain/health/scheduler';
import type { LinkCheckRecord } from '../../src/domain/health/types';

const url = 'https://health-fixture.test/article';
const bookmark = {id:'b',browserId:'b',kind:'bookmark' as const,parentId:null,index:0,title:'Fixture',url,updatedAt:0,syncGeneration:2,path:''};
function fixture(fetch: HealthServiceDeps['fetch'], saved: LinkCheckRecord[], overrides: Partial<HealthServiceDeps> = {}) {
  return new HealthService({listBookmarks:async()=>[bookmark],latestChecks:async()=>saved,saveCheck:async r=>{saved.push(r);},fetch,
    canFetch:async()=>true,readAllowPrivateHosts:async()=>false,
    config:{defaultTimeoutMs:100,defaultMaxRedirects:0,defaultMaxResponseBytes:65536,defaultUserAgent:'test',globalConcurrency:1,perHostConcurrency:1,maxRetries:1,allowPrivateHosts:false},
    now:()=>Date.now(),newId:()=>crypto.randomUUID(),isPaused:()=>false,...overrides});
}
afterEach(()=>vi.useRealTimers());

describe('bounded tentative page signals', () => {
  it.each(['<title>404 Not Found</title>','<h1>Page not found</h1>','<title>页面不存在 - Example</title>'])('recognizes an error heading: %s', body=>{
    expect(detectContentSignal(body,'text/html')).toBe('soft_404');
  });
  it('requires both a login heading and password input',()=>{
    expect(detectContentSignal('<title>Sign in to Example</title><input type="password">','text/html')).toBe('login');
    expect(detectContentSignal('<title>Sign in to Example</title><p>Article</p>','text/html')).toBeUndefined();
    expect(detectContentSignal('<title>Account settings</title><input type="password">','text/html')).toBeUndefined();
  });
  it.each(['<title>How to fix a 404 error</title>', '<h1>Not found in this article: examples</h1>', '<script>"<title>Not found</title>"</script>', '<!-- <title>Not found</title> -->'])('does not flag instructional or inactive markup: %s', body=>{
    expect(detectContentSignal(body,'text/html')).toBeUndefined();
  });
  it('ignores binary MIME and content beyond its bound',()=>{
    expect(detectContentSignal('<title>Not found</title>','application/octet-stream')).toBeUndefined();
    expect(detectContentSignal(' '.repeat(65536)+'<title>Not found</title>','text/html')).toBeUndefined();
  });
});

describe('health status and evidence matrix',()=>{
  it.each([
    [405,200,undefined,'healthy'],[200,200,'<title>Page not found</title>','suspected_soft_404'],
    [200,200,'<title>Login</title><input type=password>','suspected_login'],
    [404,404,undefined,'repeated_not_found'],[410,410,undefined,'repeated_not_found'],
    [401,401,undefined,'auth_required'],[403,403,undefined,'forbidden'],[500,503,undefined,'network_error'],
  ] as const)('HEAD %i GET %i produces %s evidence',async(head,get,body,status)=>{
    vi.useFakeTimers();const saved:LinkCheckRecord[]=[];
    const fetch = vi.fn(async(req: Parameters<HealthServiceDeps['fetch']>[0])=>({status:req.method==='HEAD'?head:get,url,retryAfterSec:null,body:req.method==='GET'?body:undefined,contentType:'text/html'}));
    const svc=fixture(fetch,saved);await svc.start();await vi.runAllTimersAsync();
    expect(saved).toHaveLength(1);expect(saved[0].status).toBe(status);
    expect(saved[0].observations?.length).toBe(head===404||head===410||head===500?2:1);
    expect(saved[0].observations?.every(row=>row.method==='GET'&&row.checkedAt>0)).toBe(true);
    expect(saved[0].evidence).toContain(`前置 HEAD：${head}`);
    if(body) expect(JSON.stringify(saved)).not.toContain(body);
  });
  it('does not GET after 429, opaque redirect or 204',async()=>{
    vi.useFakeTimers();
    for(const [code,status,redirectBlocked] of [[429,'rate_limited',false],[0,'redirect_pending',true],[204,'healthy',false]] as const){
      const saved:LinkCheckRecord[]=[];const fetch=vi.fn(async()=>({status:code,url,retryAfterSec:30,redirectBlocked}));
      await fixture(fetch,saved).start();await vi.runAllTimersAsync();expect(fetch).toHaveBeenCalledTimes(1);expect(saved[0].status).toBe(status);
    }
  });
  it('invalid URLs never reach the fetcher',async()=>{
    const saved:LinkCheckRecord[]=[];const fetch=vi.fn();const svc=fixture(fetch,saved,{listBookmarks:async()=>[{...bookmark,url:'not a URL'}]});
    await svc.start();expect(fetch).not.toHaveBeenCalled();expect(saved[0].status).toBe('unsupported');
  });
  it('migrates legacy wording without fabricating historical evidence',async()=>{
    const saved:LinkCheckRecord[]=[{id:'old',bookmarkId:'b',url,syncGeneration:2,status:'confirmed_dead',checkedAt:1,evidence:['404']}];
    const row=(await fixture(vi.fn(),saved).snapshot()).rows[0];expect(row.status).toBe('repeated_not_found');expect(row.observations).toBeUndefined();expect(row.evidence.join()).toContain('旧版');
    expect(saved[0].status).toBe('confirmed_dead');
  });
  it('marks generation changes outdated even when URL is unchanged',async()=>{
    const saved:LinkCheckRecord[]=[{id:'old',bookmarkId:'b',url,syncGeneration:1,status:'repeated_not_found',checkedAt:1,evidence:[]}];
    expect((await fixture(vi.fn(),saved).snapshot()).rows[0].status).toBe('outdated');
  });
});

function schedulerDeps(overrides: Partial<SchedulerDeps>): SchedulerDeps {
  return {probe:async()=>({status:'healthy',final:true,evidence:[]}),saveCheck:async()=>{},now:()=>Date.now(),newId:()=>crypto.randomUUID(),globalConcurrency:1,perHostConcurrency:1,maxRetries:1,isPaused:()=>false,...overrides};
}
const items=[{bookmarkId:'a',url:'https://same.test/a',syncGeneration:1},{bookmarkId:'b',url:'https://same.test/b',syncGeneration:1}];
describe('queue lifecycle evidence',()=>{
  it('wakes a host-gated queue after Retry-After and not before',async()=>{
    vi.useFakeTimers();const calls:string[]=[];
    const sched=new TaskScheduler(schedulerDeps({probe:async(id)=>{calls.push(id);return {status:id==='a'?'rate_limited':'healthy',final:true,evidence:[],retryAfterSec:id==='a'?2:null};}}));
    sched.enqueue(items);await vi.advanceTimersByTimeAsync(0);expect(calls).toEqual(['a']);expect(sched.status().nextEligibleAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1999);expect(calls).toEqual(['a']);await vi.advanceTimersByTimeAsync(10);expect(calls).toEqual(['a','b']);await sched.drain();
  });
  it('cancels sleeping retries promptly and never saves a cancelled probe',async()=>{
    vi.useFakeTimers();const saveCheck=vi.fn();const probe=vi.fn(async()=>({status:'network_error' as const,final:false,evidence:[]}));
    const sched=new TaskScheduler(schedulerDeps({probe,saveCheck}));sched.enqueue(items.slice(0,1));await vi.advanceTimersByTimeAsync(0);sched.cancelAll();await vi.advanceTimersByTimeAsync(20);await sched.drain();
    expect(probe).toHaveBeenCalledTimes(1);expect(saveCheck).not.toHaveBeenCalled();expect(sched.status().inflight).toBe(0);
  });
  it('surfaces save failures instead of falsely completing the queue',async()=>{
    vi.useFakeTimers();const sched=new TaskScheduler(schedulerDeps({saveCheck:async()=>{throw new Error('disk full');}}));sched.enqueue(items);await vi.advanceTimersByTimeAsync(0);await expect(sched.drain()).rejects.toThrow('disk full');
    expect(sched.status().queued).toBe(0);
  });
});
