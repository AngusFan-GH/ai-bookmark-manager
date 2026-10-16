import {describe,it,expect} from 'vitest';
import {safeForAssistant,excludedFolderSet,assertSafePromptUrls} from '../../src/infrastructure/messaging/workspace-privacy';
describe('outbound assistant privacy filter',()=>{
 it.each(['http://localhost/','http://10.1.2.3/','https://user:password@example.com/','https://example.com/?token=secret','https://example.com/?api_key=secret','https://example.com/?X-Amz-Signature=secret','https://example.com/#access_token=secret','javascript:alert(1)'])('excludes %s',url=>expect(safeForAssistant(url)).toBe(false));
 it('preserves normal semantic parameters without normalizing original URLs',()=>expect(safeForAssistant('https://example.com/docs?lang=zh&Page=2#intro')).toBe(true));
 it('excludes descendants without looping on corrupt cycles',()=>expect([...excludedFolderSet([{id:'a',parentId:'b'},{id:'b',parentId:'a'},{id:'c',parentId:'b'}],['a'])].sort()).toEqual(['a','b','c']));
 it('rejects obvious sensitive links directly typed into prompts',()=>{expect(()=>assertSafePromptUrls('看 https://example.com/?token=x')).toThrow('疑似带凭据');expect(()=>assertSafePromptUrls('比较 https://example.com/help')).not.toThrow();});
});

import {historySafeForAssistant} from '../../src/infrastructure/messaging/workspace-privacy';
describe('historical outbound privacy',()=>{
 const payload=()=>[{role:'user',content:JSON.stringify({request:'find',bookmarks:[{bookmarkId:'b',url:'https://example.com/'}],existingFolders:[{id:'f'}]})},{role:'assistant',content:'previous answer'}];
 it('allows unchanged verified history',()=>expect(historySafeForAssistant(payload(),[{id:'b',url:'https://example.com/'}],[{id:'f'}])).toBe(true));
 it('blocks uncited previous candidates moved into excluded folder',()=>expect(historySafeForAssistant(payload(),[],[{id:'f'}])).toBe(false));
 it('blocks excluded historical folder names',()=>expect(historySafeForAssistant(payload(),[{id:'b',url:'https://example.com/'}],[])).toBe(false));
 it('blocks changed URLs and malformed legacy history',()=>{expect(historySafeForAssistant(payload(),[{id:'b',url:'https://example.com/new'}],[{id:'f'}])).toBe(false);expect(historySafeForAssistant([{role:'user',content:'old prompt'}],[],[])).toBe(false);});
 it('blocks legacy uncited URLs with credentials',()=>{const p=payload();p[0].content=p[0].content.replace('https://example.com/','https://example.com/?token=x');expect(historySafeForAssistant(p,[{id:'b',url:'https://example.com/?token=x'}],[{id:'f'}])).toBe(false);});
});
