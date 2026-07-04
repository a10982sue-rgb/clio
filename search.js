// DuckDuckGo web search, zero deps. Used to execute server-side web_search
// requests emitted by the model, so the proxy can answer with real citations
// instead of relying on the upstream to have its own search.
//
// Hits the HTML endpoint (no API key), parses result anchors + snippets with
// regex. Returns [{ title, url, snippet }] in rank order. HTML parsing with
// regex is deliberately lossy — we only need title/url/snippet for citations.

const https = require('https');

const DDG_HOST = 'html.duckduckgo.com';
const DDG_PATH = '/html/';

function duckSearch(query, opts) {
  const max = (opts && opts.max) || 6;
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      q: query,
      b: '', // no redirect
      kl: '',
      df: '',
    }).toString() + '&=\n';

    const req = https.request(
      {
        host: DDG_HOST,
        path: DDG_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let buf = ''; res.on('data', (c) => (buf += c));
          res.on('end', () => resolve([]));
          return;
        }
        let html = '';
        res.on('data', (c) => (html += c));
        res.on('end', () => resolve(parseDdgHtml(html, max)));
      }
    );
    req.on('error', () => resolve([]));
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.write(body);
    req.end();
  });
}

// DDG wraps real result URLs in a redirect (/l/?uddg=<encoded>). Pull the
// uddg param out where present; otherwise take the href verbatim.
function unwrapUrl(href) {
  if (!href) return '';
  const m = /uddg=([^&"']+)/.exec(href);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return 'https://' + DDG_HOST + href;
  return href;
}

function unescapeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ''); // strip any inline tags inside title/snippet
}

function parseDdgHtml(html, max) {
  const results = [];
  // Result containers: each result is a <div class="result ..."> ... </div>
  // The result title lives in an <a class="result__a" href="...">Title</a>
  // The snippet in <a class="result__snippet">...</a>
  const blocks = html.split(/<div[^>]*class="[^"]*result\s/);
  for (let i = 1; i < blocks.length && results.length < max; i++) {
    const blk = blocks[i];
    const aMatch = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(blk);
    if (!aMatch) continue;
    const url = unwrapUrl(aMatch[1]);
    const title = unescapeEntities(aMatch[2]).trim();
    if (!title || !url) continue;
    const sMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(blk);
    const snippet = sMatch ? unescapeEntities(sMatch[1]).trim() : '';
    results.push({ title, url, snippet });
  }
  return results;
}

// Build an Anthropic web_search_tool_result block from raw results, so the
// proxy can inject it directly into a response or a follow-up turn.
function resultsToAnthropicBlock(results) {
  return {
    type: 'web_search_tool_result',
    content: (results || []).map((r) => ({
      type: 'text',
      text: r.snippet || r.title,
      title: r.title,
      url: r.url,
    })),
  };
}

// Build plain text suitable for injecting as a system/user message so a model
// without native server-tool support still sees the search results.
function resultsToText(query, results) {
  const lines = (results || []).map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
  );
  return `Web search results for "${query}":\n\n${lines.join('\n\n') || '(no results)'}`;
}

module.exports = {
  duckSearch,
  resultsToAnthropicBlock,
  resultsToText,
  unwrapUrl,
  parseDdgHtml,
};
