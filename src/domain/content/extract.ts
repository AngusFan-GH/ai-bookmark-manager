import { Parser } from 'htmlparser2';

export const MAX_CONTENT_TEXT = 12_000;
const OMIT = new Set(['title', 'script', 'style', 'noscript', 'template', 'form', 'nav', 'footer', 'header', 'aside', 'iframe', 'object', 'svg', 'canvas']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'li', 'br', 'h1', 'h2', 'h3', 'h4', 'tr', 'td']);
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Inert tokenizer only: never creates a DOM, executes code, or loads resources. */
export function extractHtmlContent(html: string): { title?: string; text: string; loginRequired: boolean } {
  const stack: Array<{ name: string; omitted: boolean }> = [];
  const chunks: string[] = [];
  const title: string[] = [];
  let loginRequired = false;
  const parser = new Parser({
    onopentag(name, attrs) {
      const parentOmitted = stack.at(-1)?.omitted ?? false;
      const hidden = 'hidden' in attrs || attrs['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style ?? '');
      stack.push({ name, omitted: parentOmitted || OMIT.has(name) || hidden || name === 'head' });
      if (name === 'input' && attrs.type?.toLowerCase() === 'password') loginRequired = true;
      if (BLOCK.has(name)) chunks.push(' ');
    },
    ontext(text) {
      if (stack.some((node) => node.name === 'title')) title.push(text);
      if (!stack.at(-1)?.omitted) chunks.push(text);
    },
    onclosetag(name) {
      stack.pop();
      if (BLOCK.has(name)) chunks.push(' ');
    },
  }, { decodeEntities: true });
  parser.end(html);
  const cleanTitle = normalize(title.join('')).slice(0, 300);
  if (/^(?:sign[ -]?in|log[ -]?in|authentication required|access denied|登录|登入)(?:\b|\s|$)/i.test(cleanTitle)) loginRequired = true;
  return { title: cleanTitle || undefined, text: loginRequired ? '' : normalize(chunks.join('')).slice(0, MAX_CONTENT_TEXT), loginRequired };
}
