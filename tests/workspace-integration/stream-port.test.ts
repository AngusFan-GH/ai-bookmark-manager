import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamAssistantTurn } from '../../src/assistant-stream-client';
import { attachAssistantStreamPort, ASSISTANT_STREAM_PORT } from '../../src/infrastructure/messaging/assistant-stream-port';
import { BackgroundRouter, type RequestContext } from '../../src/infrastructure/messaging/background-router';

function event() {
  const listeners=new Set<(...args:any[])=>void>();
  return {addListener:(fn:(...args:any[])=>void)=>listeners.add(fn),removeListener:(fn:(...args:any[])=>void)=>listeners.delete(fn),fire:(...args:any[])=>{for(const fn of [...listeners])fn(...args);},listeners};
}
function ports() {
  const uiMessages=event(),serverMessages=event(),uiDisconnect=event(),serverDisconnect=event();let closed=false;
  const close=vi.fn(()=>{if(closed)return;closed=true;uiDisconnect.fire();serverDisconnect.fire();});
  const ui={name:ASSISTANT_STREAM_PORT,onMessage:uiMessages,onDisconnect:uiDisconnect,postMessage:vi.fn((msg:unknown)=>{if(closed)throw new Error('closed');serverMessages.fire(msg);}),disconnect:close};
  const server={name:ASSISTANT_STREAM_PORT,sender:{id:'ext',url:'chrome-extension://ext/options.html'},onMessage:serverMessages,onDisconnect:serverDisconnect,postMessage:vi.fn((msg:unknown)=>{if(closed)throw new Error('closed');uiMessages.fire(msg);}),disconnect:close};
  vi.stubGlobal('chrome',{runtime:{connect:vi.fn(()=>ui),sendMessage:vi.fn(async()=>({ok:true,requestId:'get',data:result()})),lastError:undefined}});
  return {ui,server,uiMessages,serverMessages,serverDisconnect,close};
}
function router() {return new BackgroundRouter({} as ConstructorParameters<typeof BackgroundRouter>[0]);}
function result() {return {id:'s',revision:1,messages:[],citations:[],scope:{},mode:'assist' as const,createdAt:1,updatedAt:2};}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

describe('request-owned conversational streaming ports',()=>{
  it('delivers partial text before a final session and settles/disconnects exactly once',async()=>{
    const p=ports(),r=router();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    r.register('ASSISTANT_TURN',async(_req,context)=>{context?.onText?.('第一段');await gate;context?.onText?.('第一段 第二段');return result();});
    attachAssistantStreamPort(p.server as unknown as chrome.runtime.Port,r,'ext','chrome-extension://ext/');
    const onText=vi.fn();const pending=streamAssistantTurn('s','hello','r',{onText});
    expect(onText).toHaveBeenCalledWith('第一段');expect(p.close).not.toHaveBeenCalled();release();
    expect(await pending).toEqual(result());expect(onText).toHaveBeenLastCalledWith('第一段 第二段');expect(p.close).toHaveBeenCalledOnce();
    expect(p.uiMessages.listeners.size).toBe(0);expect(p.ui.onDisconnect.listeners.size).toBe(0);
  });
  it('ignores mismatched request/session events and all late events after success',async()=>{
    const p=ports();const onText=vi.fn();const pending=streamAssistantTurn('s','hello','r',{onText});
    p.uiMessages.fire({type:'text',sessionId:'s',requestId:'other',text:'stale'});
    p.uiMessages.fire({type:'text',sessionId:'other',requestId:'r',text:'stale'});expect(onText).not.toHaveBeenCalled();
    p.uiMessages.fire({type:'result',sessionId:'s',requestId:'r',response:{ok:true,requestId:'r',data:result()}});await pending;
    p.uiMessages.fire({type:'text',sessionId:'s',requestId:'r',text:'late'});expect(onText).not.toHaveBeenCalled();
  });
  it('abort waits for the terminal result, preserves a committed turn, and blocks late output',async()=>{
    const p=ports(),r=router();let context!:RequestContext;let release!:()=>void;
    r.register('ASSISTANT_TURN',async(_req,ctx)=>{context=ctx!;return new Promise(resolve=>{release=()=>resolve(result());});});
    attachAssistantStreamPort(p.server as unknown as chrome.runtime.Port,r,'ext','chrome-extension://ext/');
    const controller=new AbortController(),onText=vi.fn();const pending=streamAssistantTurn('s','hello','r',{signal:controller.signal,onText});
    controller.abort();expect(context.signal?.aborted).toBe(true);
    context.onText?.('late');release();expect(await pending).toEqual(result());expect(onText).not.toHaveBeenCalled();
  });
  it('surface worker disconnection rather than hanging or retrying another provider call',async()=>{
    const p=ports();const pending=streamAssistantTurn('s','hello','r',{});p.ui.onDisconnect.fire();
    await expect(pending).rejects.toThrow('中断');expect(chrome.runtime.connect).toHaveBeenCalledOnce();
  });
  it('keeps MV3 active while awaiting the first token and removes timers on cancellation',async()=>{
    vi.useFakeTimers();const p=ports();const controller=new AbortController();const pending=streamAssistantTurn('s','hello','r',{signal:controller.signal});
    const assertion=expect(pending).rejects.toThrow('停止');await vi.advanceTimersByTimeAsync(30000);
    expect(p.ui.postMessage.mock.calls.filter(([message])=>(message as any).type==='ping')).toHaveLength(2);
    controller.abort();p.uiMessages.fire({type:'result',sessionId:'s',requestId:'r',response:{ok:false,requestId:'r',error:{code:'INTERNAL',message:'请求已停止',retryable:false}}});await assertion;const count=p.ui.postMessage.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(p.ui.postMessage).toHaveBeenCalledTimes(count);
  });
  it('does not connect an already aborted request',async()=>{
    ports();const controller=new AbortController();controller.abort();await expect(streamAssistantTurn('s','hello','r',{signal:controller.signal})).rejects.toThrow('停止');expect(chrome.runtime.connect).not.toHaveBeenCalled();
  });
  it.each([{id:'other',url:'chrome-extension://ext/options.html'},{id:'ext',url:'https://example.com'},{}])('rejects unauthorized port senders %#',sender=>{
    const p=ports();p.server.sender=sender as typeof p.server.sender;const r=router();const dispatch=vi.spyOn(r,'dispatch');attachAssistantStreamPort(p.server as unknown as chrome.runtime.Port,r,'ext','chrome-extension://ext/');expect(p.close).toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  });
  it('accepts only one bounded turn per port, never replaying duplicates',async()=>{
    const p=ports(),r=router();const handler=vi.fn(async(_request:unknown,_context?:RequestContext)=>new Promise(()=>{}));r.register('ASSISTANT_TURN',handler);
    attachAssistantStreamPort(p.server as unknown as chrome.runtime.Port,r,'ext','chrome-extension://ext/');
    const message={type:'ASSISTANT_TURN',sessionId:'s',requestId:'r',text:'hello'};p.serverMessages.fire(message);p.serverMessages.fire(message);expect(handler).toHaveBeenCalledOnce();expect(p.close).toHaveBeenCalledOnce();expect(handler.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('propagates a safe final validation error and never emits a result as text',async()=>{
    const p=ports(),r=router();r.register('ASSISTANT_TURN',async(_req,context)=>{context?.onText?.('provisional');throw new Error('校验失败');});attachAssistantStreamPort(p.server as unknown as chrome.runtime.Port,r,'ext','chrome-extension://ext/');
    const onText=vi.fn();await expect(streamAssistantTurn('s','hello','r',{onText})).rejects.toThrow('校验失败');expect(onText).toHaveBeenCalledExactlyOnceWith('provisional');
  });
});

describe('terminal reconciliation after a lost stream port',()=>{
 it('recovers exactly the committed request after disconnect without another provider call',async()=>{
  const p=ports();vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ok:true,requestId:'get',data:{...result(),lastTurnRequestId:'r'}});
  const pending=streamAssistantTurn('s','hello','r',{expectedRevision:0});p.ui.onDisconnect.fire();
  expect(await pending).toMatchObject({lastTurnRequestId:'r'});expect(chrome.runtime.connect).toHaveBeenCalledOnce();expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({type:'ASSISTANT_GET',sessionId:'s'}));
  expect(p.ui.postMessage).toHaveBeenCalledWith(expect.objectContaining({expectedRevision:0}));
 });
 it('does not mistake a different saved turn for this canceled request',async()=>{
  const p=ports();vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ok:true,requestId:'get',data:{...result(),lastTurnRequestId:'other'}});
  const controller=new AbortController();const pending=streamAssistantTurn('s','hello','r',{signal:controller.signal});controller.abort();p.ui.onDisconnect.fire();await expect(pending).rejects.toThrow('停止');
 });
 it('reports an uncertain saved state when reconciliation cannot reach the background',async()=>{
  const p=ports();vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error('worker unavailable'));
  const pending=streamAssistantTurn('s','hello','r',{});p.ui.onDisconnect.fire();await expect(pending).rejects.toThrow('核对后再发送');expect(chrome.runtime.connect).toHaveBeenCalledOnce();
 });
 it('waits for explicit cancellation completion instead of enabling an immediate duplicate retry',async()=>{
  const p=ports(),r=router();let reject!: (error:Error)=>void;let context!:RequestContext;
  r.register('ASSISTANT_TURN',async(_req,ctx)=>{context=ctx!;return new Promise((_resolve,fail)=>{reject=fail;});});
  attachAssistantStreamPort(p.server as unknown as chrome.runtime.Port,r,'ext','chrome-extension://ext/');
  const controller=new AbortController();const pending=streamAssistantTurn('s','hello','r',{signal:controller.signal});let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
  controller.abort();await Promise.resolve();expect(context.signal?.aborted).toBe(true);expect(settled).toBe(false);expect(p.close).not.toHaveBeenCalled();
  reject(new Error('请求已停止'));await expect(pending).rejects.toThrow('停止');expect(p.close).toHaveBeenCalledOnce();
 });
});


it('recovers its committed message even when another window has since completed a newer turn',async()=>{
 const p=ports();vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ok:true,requestId:'get',data:{...result(),lastTurnRequestId:'newer',messages:[{id:'message',role:'assistant',requestId:'r',text:'answer',createdAt:1}]}});
 const pending=streamAssistantTurn('s','hello','r',{expectedRevision:0});p.ui.onDisconnect.fire();expect((await pending).messages[0].requestId).toBe('r');
});
