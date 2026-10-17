import { describe, expect, it, vi } from 'vitest';
import { previewSuggestionText, readMiniMaxStream } from '../../src/domain/assistant/stream';
import { createMiniMaxProvider } from '../../src/domain/assistant/provider';

const chunk = (content: unknown, finish_reason: string | null = null, delta: object = {}) => `data: ${JSON.stringify({choices:[{index:0, delta:{content,...delta},finish_reason}]})}\n\n`;
const stop = chunk('', 'stop'); const done = 'data: [DONE]\n\n';
function response(text: string, size = 13) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({start(controller) {for (let i=0;i<bytes.length;i+=size) controller.enqueue(bytes.slice(i,i+size));controller.close();}}),{headers:{'content-type':'text/event-stream; charset=utf-8'}});
}
describe('MiniMax SSE transport', () => {
  it.each([1,2,3,7,31,1000])('handles UTF-8 and records split every %i bytes',async size=>{
    const progress:string[]=[];
    const result=await readMiniMaxStream(response(': keepalive\n\n'+chunk('中文😀')+chunk(' second')+stop+done,size),undefined,value=>progress.push(value));
    expect(result).toEqual({message:{role:'assistant',content:'中文😀 second'},finishReason:'stop'});
    expect(progress[0]).toBe('中文😀'); expect(progress.at(-1)).toBe('中文😀 second');
  });
  it.each([1,2,7,31])('accepts observed M2.5 stop plus clean EOF without DONE at %i-byte boundaries',async size=>{
    const content=JSON.stringify({text:'中文完整回答😀',references:[],moves:[],folders:[],edits:[],deletions:[]});
    // Observed protocol shape: ordinary deltas omit finish_reason; the final
    // delta object has finish_reason:stop, then transport EOF, no DONE/usage.
    const fragments=Array.from({length:7},(_,i)=>content.slice(Math.floor(content.length*i/7),Math.floor(content.length*(i+1)/7)));
    const frames=fragments.map(fragment=>`data: ${JSON.stringify({choices:[{index:0,delta:{content:fragment}}]})}\n\n`).join('');
    const terminal='data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    const progress=vi.fn();const result=await readMiniMaxStream(response(frames+terminal,size),undefined,progress);
    expect(result).toEqual({message:{role:'assistant',content},finishReason:'stop'});expect(progress.mock.calls.length).toBeGreaterThan(1);
  });
  it('accepts a terminal usage-only frame before clean EOF without requiring DONE',async()=>{
    const result=await readMiniMaxStream(response(chunk('answer')+stop+'data: {"choices":[],"usage":{"total_tokens":20}}\n\n'));
    expect(result.message.content).toBe('answer');
  });
  it('rejects an incomplete UTF-8 sequence after stop rather than treating it as clean EOF',async()=>{
    const source=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(chunk('answer')+stop));controller.enqueue(new Uint8Array([0xc3]));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
    await expect(readMiniMaxStream(source)).rejects.toThrow();
  });
  it('does not treat a read error after stop as clean EOF',async()=>{
    let reads=0;
    const source=new Response(new ReadableStream({pull(controller){
      if(reads++===0)controller.enqueue(new TextEncoder().encode(chunk('answer')+stop));
      else controller.error(new Error('synthetic read failure'));
    }}),{headers:{'content-type':'text/event-stream'}});
    await expect(readMiniMaxStream(source)).rejects.toThrow();
  });
  it('waits for EOF or DONE after stop and remains cancelable while transport is open',async()=>{
    const controller=new AbortController();const progress=vi.fn();let settled=false;
    const source=new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode(chunk('answer')+stop));}}),{headers:{'content-type':'text/event-stream'}});
    const pending=readMiniMaxStream(source,controller.signal,progress);void pending.then(()=>{settled=true;},()=>{settled=true;});
    await vi.waitFor(()=>expect(progress).toHaveBeenCalled());expect(settled).toBe(false);
    controller.abort();await expect(pending).rejects.toMatchObject({code:'canceled'});
  });
  it.each([chunk('answer','length'),chunk('answer','content_filter'),chunk('answer')+stop+chunk('extra')])('rejects unsuccessful or altered content even with clean EOF %#',async source=>{
    await expect(readMiniMaxStream(response(source))).rejects.toMatchObject({code:'provider'});
  });
  it('accepts CRLF, multi-line data fields, and terminal usage records', async()=>{
    const first='data: {"choices":[\r\ndata: {"index":0,"delta":{"content":"answer"},"finish_reason":null}]}\r\n\r\n';
    expect((await readMiniMaxStream(response(first+stop+'data: {"choices":[],"usage":{"total_tokens":20}}\n\n'+done))).message.content).toBe('answer');
  });
  it('ignores separated reasoning and never emits or retains it as answer content',async()=>{
    const onContent=vi.fn();
    const result=await readMiniMaxStream(response(chunk(null,null,{reasoning_content:'PRIVATE',reasoning_details:[{text:'PRIVATE'}]})+chunk('answer')+stop+done),undefined,onContent);
    expect(onContent.mock.calls.flat().join('')).not.toContain('PRIVATE');expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it.each([
    chunk('answer'), chunk('answer')+stop+'data:',chunk('answer')+done,chunk('answer','length')+done,
    chunk('answer','content_filter')+done,chunk('answer')+stop+'data: [DONE]',
    'data: {}\n\n'+stop+done,'data: not-json\n\n'+stop+done,
    chunk({text:'wrong'})+stop+done,chunk('answer',null,{tool_calls:[{}]})+stop+done,
    chunk('answer',null,{role:'user'})+stop+done,chunk('answer')+stop+chunk('extra')+done,
    'data: {"error":{"message":"PRIVATE"}}\n\n',
    'data: {"choices":[{"index":1,"delta":{"content":"bad"}}]}\n\n',
  ])('rejects malformed, truncated, or uncompleted SSE %#',async source=>{
    await expect(readMiniMaxStream(response(source))).rejects.toMatchObject({code:'provider'});
  });
  it('rejects wrong MIME instead of silently falling back to a second provider call',async()=>{
    await expect(readMiniMaxStream(new Response('{}'))).rejects.toMatchObject({code:'provider'});
  });
  it('bounds the accumulated structured output',async()=>{
    await expect(readMiniMaxStream(response(chunk('x'.repeat(100001))+stop+done,100000))).rejects.toMatchObject({code:'provider'});
  });
  it('aborts a pending read and stops progress immediately',async()=>{
    const controller=new AbortController();const progress=vi.fn();const canceled=vi.fn();
    const res=new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode(chunk('first ')));},cancel:canceled}),{headers:{'content-type':'text/event-stream'}});
    const pending=readMiniMaxStream(res,controller.signal,progress);
    await vi.waitFor(()=>expect(progress).toHaveBeenCalled());controller.abort();
    await expect(pending).rejects.toMatchObject({code:'canceled'});expect(canceled).toHaveBeenCalledOnce();
  });
  it('uses one real stream request, the CN endpoint, and existing privacy-safe fetch options',async()=>{
    const fetcher=vi.fn(async()=>response(chunk('{"text":"answer"}')+stop+done));const onContent=vi.fn();
    await createMiniMaxProvider(fetcher as typeof fetch).complete({messages:[{role:'user',content:'test'}],settings:{region:'cn'},apiKey:'placeholder',onContent});
    expect(fetcher).toHaveBeenCalledOnce();const [url,request]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://api.minimax.cn/v1/chat/completions');expect(request).toMatchObject({redirect:'error',credentials:'omit',referrerPolicy:'no-referrer'});
    expect(JSON.parse(request.body as string)).toMatchObject({stream:true,reasoning_split:true});expect(onContent).toHaveBeenCalled();
  });
});

describe('provisional structured-answer display',()=>{
  it('decodes escaped strings and split unicode without emitting partial escapes/surrogates',()=>{
    expect(previewSuggestionText('{"text":"中文\\n另')).toBe('中文\n另');
    expect(previewSuggestionText('{"text":"中文\\u')).toBe('中文');
    expect(previewSuggestionText('{"text":"中文\\uD83D')).toBe('中文');
    expect(previewSuggestionText('{"text":"中文\\uD83D\\uDE00')).toBe('中文😀');
    expect(previewSuggestionText('{"text":"say \\"hello\\" "}')).toBe('say "hello"');
  });
  it('never mistakes nested text, unknown first keys, or references for the answer',()=>{
    expect(previewSuggestionText('{"references":[{"text":"PRIVATE"}')).toBe('');
    expect(previewSuggestionText('{"unknown":"PRIVATE","text":"answer"}')).toBe('');
    expect(previewSuggestionText('{"text":"answer","references":[{"reason":"PRIVATE"}')).toBe('answer');
  });
  it('withholds incomplete thought tags and suppresses thought bodies across every split',()=>{
    const payload=JSON.stringify({text:'开始 <think>PRIVATE <think>INNER</think> THOUGHT</think> 结束'});
    for(let i=0;i<=payload.length;i++)expect(previewSuggestionText(payload.slice(0,i))).not.toMatch(/PRIVATE|INNER|THOUGHT|think|</);
    const outer='<think><think>inner</think>{"text":"PRIVATE"}</think>\n```json\n{"text":"safe"}\n```';
    for(let i=0;i<=outer.length;i++)expect(previewSuggestionText(outer.slice(0,i))).not.toContain('PRIVATE');
    expect(previewSuggestionText(outer)).toBe('safe');
  });
  it('never exposes a partially generated URL or markdown target',()=>{
    for(const text of ['参考 https://evil.example.com/path 结束','参考 evil.com/path 结束','参考 [label](https://evil.com) 结束','参考 <b>safe</b> 结束']) {
      const payload=JSON.stringify({text});
      for(let i=0;i<=payload.length;i++)expect(previewSuggestionText(payload.slice(0,i))).not.toMatch(/https|evil|<b|<\/b/);
    }
  });
  it('waits for complete ASCII tokens but streams Han text immediately',()=>{
    expect(previewSuggestionText('{"text":"Answer hel')).toBe('Answer');
    expect(previewSuggestionText('{"text":"这是逐步输出')).toBe('这是逐步输出');
  });
});
