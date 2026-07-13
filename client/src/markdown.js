/**
 * Minimal, safe markdown for chat. Escape-first, then a small set of
 * transforms: ```blocks```, `inline`, **bold**, *italic*, ~~strike~~,
 * > quotes, autolinked URLs, @mentions. No images, no raw HTML — ever.
 */

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/**
 * @param {string} text raw message content
 * @param {string[]} names known display names (for @mention highlighting)
 * @param {string} myName current user's name (mentions of it get .mention-me)
 */
export function renderMarkdown(text, names = [], myName = '') {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let s = escapeHtml(text);

  // Fenced code blocks first — nothing inside them gets styled.
  s = s.replace(/```(?:[a-zA-Z0-9+-]*)\n?([\s\S]*?)```/g,
    (_, code) => keep(`<pre class="codeblock"><code>${code.replace(/\n$/, '')}</code></pre>`));

  // Inline code.
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="inline-code">${code}</code>`));

  // Links (on escaped text; &amp; inside href decodes correctly).
  s = s.replace(URL_RE, (url) => {
    const trimmed = url.replace(/[).,;!?]+$/, '');
    const tail = url.slice(trimmed.length);
    return keep(
      `<a href="${trimmed}" target="_blank" rel="noreferrer noopener">${trimmed}</a>`) + tail;
  });

  // Emphasis.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // Mentions — longest names first so "Sam" doesn't eat "Sammy".
  const sorted = [...new Set(names.filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const esc = escapeHtml(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const me = myName && name.toLowerCase() === myName.toLowerCase();
    s = s.replace(new RegExp(`@(${esc})(?![\\w])`, 'gi'),
      (_, n) => keep(`<span class="mention${me ? ' mention-me' : ''}">@${n}</span>`));
  }

  // Block quotes (line-based), then newlines.
  s = s.split('\n').map((line) =>
    line.startsWith('&gt; ')
      ? `<span class="quote">${line.slice(5)}</span>`
      : line
  ).join('\n');
  s = s.replace(/\n/g, '<br>');

  // Restore stashed chunks.
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return s;
}

/** True when `content` mentions `myName` (used for ping decisions). */
export function mentionsMe(content, myName) {
  if (!myName) return false;
  const esc = myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${esc}(?![\\w])`, 'i').test(content);
}

export const timeShort = (ts) => {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
};
