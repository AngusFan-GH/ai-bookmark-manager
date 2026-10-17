/** Conservative, bounded local heuristics. Never retain or emit page text.
 * These signals request human review and are never deletion evidence.
 */
export function detectContentSignal(body?: string, contentType?: string): 'soft_404' | 'login' | undefined {
  if (!body || (contentType && !/^(text\/(html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(contentType))) return;
  const sample = body.slice(0, 65_536).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const headings = [...sample.matchAll(/<(?:title|h1)\b[^>]*>([\s\S]*?)<\/(?:title|h1)\s*>/gi)]
    .map(match => match[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim());
  // Anchoring avoids flagging articles such as "How to fix a 404 error".
  const missing = /^(?:(?:error\s*)?(?:404|410)(?:\s*[-:|–]\s*|\s+))?(?:page (?:not found|unavailable)|not found|this (?:page|content) (?:is |was )?(?:unavailable|removed)|页面不存在|网页不存在|页面已删除|找不到页面)(?:[.!。！]?)(?:\s*[-|–]\s*[^\n]{0,80})?$/i;
  if (headings.some(heading => missing.test(heading) || /^(?:error\s*)?(404|410)(?:\s*[-|:]\s*(not found|gone))?$/i.test(heading))) return 'soft_404';
  const loginHeading = headings.some(heading => /^(?:sign in|log in|login|登录|登入)(?:\s+(?:to|your)\b.{0,80}|\s*[-|–].{0,80})?$/i.test(heading));
  if (loginHeading && /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(sample)) return 'login';
  return undefined;
}
