// HTTP entrypoint for ollie-chat-railway.
// - Serves the web chat UI from public/ (no auth — the public website)
// - Exposes the translating proxy at /v1/* (auth required, key = API_KEY env, default "brotato")
// - Exposes a first-party chat API at /api/chat + /api/models for the UI (no external key)
//
// No chat-content logging. /api/logs returns the metadata-only request log
// (model/status/latency/usage) from logger.js — no prompt or response text.
//
// RPM rate limit on /v1/* and /api/chat, mirroring the Anthropic API: returns
// 429 with retry-after once RATE_LIMIT_RPM requests land in the rolling minute.
//
// Native http only — zero runtime deps, matches the rest of the codebase.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const {
  anthropicToOpenAIRequest,
  openAIToAnthropicResponse,
  createAnthropicStreamEncoder,
  openAIToAnthropicUsage,
} = require('./translate');
const { callUpstream } = require('./upstream');
const { openaiModelsList, anthropicModelsList, MODELS } = require('./models');
const { logRequest, LOG_PATH } = require('./logger');
const { duckSearch, resultsToAnthropicBlock } = require('./search');
const { createLimiter } = require('./ratelimit');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'brotato';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;

// Rate limit (requests per minute, per client IP). Override via env. The
// Anthropic API tier-1 RPM is ~50; default here is conservative.
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '50', 10);
const limiter = createLimiter(60 * 1000, RATE_LIMIT_RPM);

// Client id for rate limiting: first x-forwarded-for hop, else socket IP.
function clientId(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Apply the RPM limit. On rejection, sends a 429 shaped like the Anthropic API
// and returns true so the caller bails.
function rateLimited(req, res, contractShape) {
  const r = limiter.check(clientId(req));
  if (r.allowed) return false;
  if (contractShape === 'anthropic') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(r.retryAfter) });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `rate limit exceeded: ${RATE_LIMIT_RPM} req/min — retry in ${r.retryAfter}s` } }));
  } else if (contractShape === 'openai') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(r.retryAfter) });
    res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: `rate limit exceeded: ${RATE_LIMIT_RPM} req/min — retry in ${r.retryAfter}s` } }));
  } else {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(r.retryAfter) });
    res.end(JSON.stringify({ error: `rate limit exceeded — retry in ${r.retryAfter}s` }));
  }
  return true;
}

// --- helpers ---------------------------------------------------------------

// Rough token estimate for /v1/messages/count_tokens. Agent SDKs (Claude Code,
// Anthropic Agent SDK) call this during planning; a 404 breaks them. We don't
// have a tokenizer, so use the standard ~4 chars/token heuristic with a small
// per-message overhead. The upstream's real tokenizer is what bills, so this
// only needs to be close enough for the SDK's context-budgeting logic.
function estimateTokens(anBody) {
  let chars = 0;
  const addText = (s) => { if (typeof s === 'string') chars += s.length; };
  addText(typeof anBody.system === 'string' ? anBody.system
    : (Array.isArray(anBody.system) ? anBody.system.map(b => b.text || '').join('') : ''));
  for (const m of (anBody.messages || [])) {
    chars += 4; // role + framing overhead
    if (typeof m.content === 'string') addText(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') addText(b.text);
        else if (b.type === 'thinking') addText(b.thinking);
        else if (b.type === 'tool_use') addText(JSON.stringify(b.input ?? {}));
        else if (b.type === 'tool_result') {
          if (typeof b.content === 'string') addText(b.content);
          else if (Array.isArray(b.content)) addText(b.content.map(x => x.text || '').join(''));
        } else addText(JSON.stringify(b));
      }
    }
  }
  for (const t of (anBody.tools || [])) chars += JSON.stringify(t).length;
  return Math.max(1, Math.ceil(chars / 4));
}

// Detect Anthropic server-side web_search tool usage. Anthropic defines it as a
// built-in server tool: { type: 'web_search_20250305', name: 'web_search', ... }
// or a custom tool named 'web_search'. Our OpenAI-shaped upstream can't execute
// server tools, so when the client enables it we run DuckDuckGo ourselves:
// derive a query from the latest user message, search, and inject a
// web_search_tool_result block into the conversation so the model sees real,
// cited results. The server_tool_use/tool-result pair then round-trips cleanly
// through translate.js.
function hasWebSearchTool(anBody) {
  return (anBody.tools || []).some(t => t.type === 'web_search_20250305' || t.name === 'web_search');
}

function extractSearchQuery(anBody) {
  const msgs = anBody.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) {
      const texts = m.content.filter(b => b.type === 'text').map(b => b.text || '');
      if (texts.length) return texts.join(' ').trim();
    }
  }
  return '';
}

// Async pre-flight: if web_search is enabled, run it and mutate anBody to fold
// the results into the conversation as a system-side search-result note. Returns
// the results so the caller can also attach a web_search_tool_result block to
// the assistant response if it wants.
async function prepareWebSearch(anBody) {
  if (!hasWebSearchTool(anBody)) return null;
  const query = extractSearchQuery(anBody);
  if (!query) return null;
  const results = await duckSearch(query, { max: 6 });
  if (!results.length) return null;

  // Inject a user-role turn with the results as a search_result block, and a
  // light system instruction telling the model to cite sources. This keeps the
  // data in-band for any upstream (OpenAI-shaped) that lacks server tools.
  const lines = results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`);
  const resultsText = `Web search results for "${query}":\n\n${lines.join('\n\n')}\n\nCite sources by URL when using these results.`;
  anBody.messages = (anBody.messages || []).concat([
    { role: 'user', content: [{ type: 'text', text: resultsText }] },
  ]);
  if (!anBody.system) anBody.system = '';
  anBody.system = (anBody.system ? anBody.system + '\n\n' : '') +
    'You have web search results inline in the conversation. Use them to answer; cite URLs.';

  return { query, results, block: resultsToAnthropicBlock(results) };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Proxy auth: Authorization: Bearer <key>  OR  x-api-key: <key>
function authed(req) {
  const bear = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(bear);
  const token = (m && m[1]) || req.headers['x-api-key'] || '';
  return safeEqual(token.trim(), API_KEY);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); resolve(''); return; }
      b += c;
    });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

function writeSse(res, obj) {
  res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
}

// Derive the public base URL from the incoming request. Railway terminates TLS and
// proxies through its edge, so the host is the real *.up.railway.app domain. We honor
// x-forwarded-proto/host (set by Railway's proxy) and fall back to the direct Host header.
function publicBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.connection && req.connection.encrypted ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    || req.headers['host'] || 'localhost';
  return `${proto}://${host}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let p = urlPath.split('?')[0];
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, p));
  if (!fp.startsWith(PUBLIC_DIR)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- proxy: Anthropic contract  /v1/messages --------------------------------

async function handleMessages(req, res, body) {
  if (!authed(req)) {
    sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } });
    return;
  }
  let anBody;
  try { anBody = JSON.parse(body); }
  catch { sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid json' } }); return; }

  await prepareWebSearch(anBody);
  const oaiBody = anthropicToOpenAIRequest(anBody);
  const t0 = Date.now();
  const meta = { contract: 'anthropic', model: anBody.model, msgCount: (anBody.messages || []).length, stream: !!anBody.stream };

  if (anBody.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Disable any proxy buffering so SSE frames flush immediately. Without
      // this, Railway's edge can buffer the whole stream and the client times
      // out before the first event — a common "request failed retrying" cause.
      'X-Accel-Buffering': 'no',
    });
    const enc = createAnthropicStreamEncoder(anBody.model);
    let usage = null;
    // Anthropic sends periodic ping events during long generations to keep the
    // connection alive; emit the same so strict clients don't time out while
    // the upstream is still thinking.
    const pingTimer = setInterval(() => {
      if (!res.writableEnded) res.write('event: ping\ndata: {}\n\n');
    }, 5000);
    const stopPing = () => { clearInterval(pingTimer); };
    try {
      await callUpstream(oaiBody, {
        onSseEvent: (chunk) => {
          if (chunk.usage) usage = chunk.usage;
          for (const e of enc.feedChunk(chunk)) writeSse(res, e);
        },
        onEnd: () => {
          stopPing();
          for (const e of enc.flushEnd()) writeSse(res, e);
          res.end();
        },
        onError: (e) => {
          stopPing();
          writeSse(res, { type: 'error', error: { type: 'api_error', message: e.message } });
          res.end();
        },
      });
      logRequest({ ...meta, status: 200, usage, latencyMs: Date.now() - t0 });
    } catch (e) {
      stopPing();
      if (!res.writableEnded) {
        writeSse(res, { type: 'error', error: { type: 'api_error', message: e.message } });
        res.end();
      }
      logRequest({ ...meta, status: e.status || 502, error: e.message, latencyMs: Date.now() - t0 });
    }
  } else {
    try {
      const oai = await callUpstream(oaiBody, {});
      const an = openAIToAnthropicResponse(oai);
      sendJson(res, 200, an);
      logRequest({ ...meta, status: 200, usage: oai.usage, latencyMs: Date.now() - t0 });
    } catch (e) {
      sendJson(res, e.status || 502, { type: 'error', error: { type: 'api_error', message: e.message } });
      logRequest({ ...meta, status: e.status || 502, error: e.message, latencyMs: Date.now() - t0 });
    }
  }
}

// --- proxy: OpenAI contract  /v1/chat/completions --------------------------

async function handleChatCompletions(req, res, body) {
  if (!authed(req)) {
    sendJson(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } });
    return;
  }
  let oaiBody;
  try { oaiBody = JSON.parse(body); }
  catch { sendJson(res, 400, { error: { message: 'invalid json', type: 'invalid_request_error' } }); return; }

  const t0 = Date.now();
  const meta = { contract: 'openai', model: oaiBody.model, msgCount: (oaiBody.messages || []).length, stream: !!oaiBody.stream };

  if (oaiBody.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try {
      await callUpstream(oaiBody, {
        onSseEvent: (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
        onEnd: () => { res.write('data: [DONE]\n\n'); res.end(); },
        onError: (e) => {
          res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
          res.end();
        },
      });
      logRequest({ ...meta, status: 200, latencyMs: Date.now() - t0 });
    } catch (e) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
        res.end();
      }
      logRequest({ ...meta, status: e.status || 502, error: e.message, latencyMs: Date.now() - t0 });
    }
  } else {
    try {
      const oai = await callUpstream(oaiBody, {});
      sendJson(res, 200, oai);
      logRequest({ ...meta, status: 200, usage: oai.usage, latencyMs: Date.now() - t0 });
    } catch (e) {
      sendJson(res, e.status || 502, { error: { message: e.message } });
      logRequest({ ...meta, status: e.status || 502, error: e.message, latencyMs: Date.now() - t0 });
    }
  }
}

// --- first-party chat API for the UI  /api/chat ----------------------------

async function handleApiChat(req, res, body) {
  let inBody;
  try { inBody = JSON.parse(body); }
  catch { sendJson(res, 400, { error: 'invalid json' }); return; }

  const anBody = {
    model: inBody.model || MODELS[0].id,
    messages: inBody.messages || [],
    max_tokens: inBody.max_tokens || 4096,
    stream: !!inBody.stream,
  };
  if (inBody.system) anBody.system = inBody.system;
  if (typeof inBody.temperature === 'number') anBody.temperature = inBody.temperature;

  // Thinking / reasoning effort. UI sends `effort` ('low'|'medium'|'high'|'xhigh'|'none').
  // Map to an Anthropic thinking block so translate.js sets reasoning_effort accordingly.
  // Default 'high' so the chat produces real reasoning, not instant answers.
  const effort = String(inBody.effort || inBody.reasoning_effort || 'high').toLowerCase();
  if (effort === 'none') {
    anBody.thinking = { type: 'disabled' };
  } else {
    const budget = effort === 'xhigh' ? 24000 : effort === 'high' ? 12000 : effort === 'medium' ? 6000 : 2000;
    anBody.thinking = { type: 'enabled', budget_tokens: budget };
  }

  // UI web-search toggle: when on, declare the Anthropic web_search server tool
  // so prepareWebSearch runs DuckDuckGo and injects real, cited results.
  if (inBody.web_search) {
    anBody.tools = (anBody.tools || []).concat([{ type: 'web_search_20250305', name: 'web_search' }]);
  }

  await prepareWebSearch(anBody);
  const oaiBody = anthropicToOpenAIRequest(anBody);

  if (anBody.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try {
      await callUpstream(oaiBody, {
        onSseEvent: (chunk) => {
          const d = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
          const ev = {};
          if (d.reasoning_content) ev.thinking = d.reasoning_content;
          if (d.content) ev.text = d.content;
          if (chunk.usage) ev.usage = openAIToAnthropicUsage(chunk.usage);
          if (Object.keys(ev).length) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        },
        onEnd: () => { res.write('data: [DONE]\n\n'); res.end(); },
        onError: (e) => { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); },
      });
    } catch (e) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        res.end();
      }
    }
  } else {
    try {
      const oai = await callUpstream(oaiBody, {});
      const an = openAIToAnthropicResponse(oai);
      sendJson(res, 200, an);
    } catch (e) {
      sendJson(res, e.status || 502, { error: e.message });
    }
  }
}

// --- router ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (req.method === 'GET' && p === '/api/models') {
      sendJson(res, 200, { models: MODELS });
      return;
    }
    if (req.method === 'GET' && p === '/api/info') {
      sendJson(res, 200, {
        baseUrl: publicBaseUrl(req),
        apiKey: API_KEY,
        proxyPaths: {
          anthropic: '/v1/messages',
          openai: '/v1/chat/completions',
          models: '/v1/models',
        },
      });
      return;
    }
    if (req.method === 'POST' && p === '/api/chat') {
      if (rateLimited(req, res, 'web')) return;
      handleApiChat(req, res, await readBody(req));
      return;
    }
    if (req.method === 'GET' && p === '/api/logs') {
      // Public, metadata-only request log: timestamp, contract, model, status,
      // usage, latency. No prompt or response text is stored or returned.
      const rows = [];
      try {
        if (fs.existsSync(LOG_PATH)) {
          for (const line of fs.readFileSync(LOG_PATH, 'utf8').split('\n')) {
            const s = line.trim(); if (!s) continue;
            try { rows.push(JSON.parse(s)); } catch {}
          }
        }
      } catch {}
      rows.reverse();
      sendJson(res, 200, { requests: rows, rateLimitRpm: RATE_LIMIT_RPM });
      return;
    }
    if (req.method === 'GET' && p === '/v1/models') {
      if (!authed(req)) { sendJson(res, 401, { error: { message: 'unauthorized' } }); return; }
      const isAnthropic = !!req.headers['anthropic-version'];
      sendJson(res, 200, isAnthropic ? anthropicModelsList() : openaiModelsList());
      return;
    }
    if (req.method === 'POST' && p === '/v1/messages') {
      if (rateLimited(req, res, 'anthropic')) return;
      handleMessages(req, res, await readBody(req));
      return;
    }
    if (req.method === 'POST' && p === '/v1/messages/count_tokens') {
      // Agent SDKs (Claude Code, Anthropic Agent SDK) call this for context
      // budgeting. No tokenizer available, so estimate. Auth matches the proxy.
      if (!authed(req)) { sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } }); return; }
      let anBody; try { anBody = JSON.parse(await readBody(req)); }
      catch { sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid json' } }); return; }
      sendJson(res, 200, { input_tokens: estimateTokens(anBody) });
      return;
    }
    if (req.method === 'POST' && p === '/v1/chat/completions') {
      if (rateLimited(req, res, 'openai')) return;
      handleChatCompletions(req, res, await readBody(req));
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res, p);
      return;
    }
    sendJson(res, 404, { error: { message: 'not found' } });
  } catch (e) {
    if (!res.writableEnded) sendJson(res, 500, { error: { message: e.message } });
  }
});

server.listen(PORT, () => {
  console.log(`ollie-chat-railway listening on :${PORT}  (API_KEY=${API_KEY === 'brotato' ? 'brotato (default)' : 'set'})`);
});
