// HTTP entrypoint for ollie-chat-railway.
// - Serves the web chat UI from public/ (no auth — the public website)
// - Exposes the translating proxy at /v1/* (auth required, key = API_KEY env, default "brotato")
// - Exposes a first-party chat API at /api/chat + /api/models for the UI (no external key)
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
const { logRequest } = require('./logger');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'brotato';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kamilove32';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;

// In-memory chat transcript log. Lives only in RAM — resets on restart. Capped
// so a flood can't grow it without bound; oldest drop off.
const CHAT_LOG_MAX = 1000;
const chatLog = [];
function logChat(rec) {
  chatLog.push(rec);
  if (chatLog.length > CHAT_LOG_MAX) chatLog.shift();
}

// --- helpers

// --- helpers ---------------------------------------------------------------

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

// Admin auth: password lives only on the server (env var / default). The browser
// never receives it; the login endpoint takes a posted password and returns a
// short-lived signed-ish token (HMAC of timestamp over ADMIN_PASSWORD). Token is
// sent back as a header for admin reads. No password ever reaches the HTML.
function adminToken(now) {
  const stamp = Math.floor((now || Date.now()) / 1000 / 300); // 5-min window
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update(String(stamp)).digest('hex');
}
function adminAuthed(req) {
  const bear = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(bear);
  const tok = (m && m[1]) || req.headers['x-admin-token'] || '';
  // accept current window or previous (allows a token minted late in a window)
  const now = Date.now();
  return safeEqual(tok, adminToken(now)) || safeEqual(tok, adminToken(now - 300 * 1000));
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

  const oaiBody = anthropicToOpenAIRequest(anBody);
  const t0 = Date.now();
  const meta = { contract: 'anthropic', model: anBody.model, msgCount: (anBody.messages || []).length, stream: !!anBody.stream };

  if (anBody.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const enc = createAnthropicStreamEncoder(anBody.model);
    let usage = null;
    try {
      await callUpstream(oaiBody, {
        onSseEvent: (chunk) => {
          if (chunk.usage) usage = chunk.usage;
          for (const e of enc.feedChunk(chunk)) writeSse(res, e);
        },
        onEnd: () => {
          for (const e of enc.flushEnd()) writeSse(res, e);
          res.end();
        },
        onError: (e) => {
          writeSse(res, { type: 'error', error: { type: 'api_error', message: e.message } });
          res.end();
        },
      });
      logRequest({ ...meta, status: 200, usage, latencyMs: Date.now() - t0 });
    } catch (e) {
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
    max_tokens: inBody.max_tokens || 2048,
    stream: !!inBody.stream,
  };
  if (inBody.system) anBody.system = inBody.system;
  if (typeof inBody.temperature === 'number') anBody.temperature = inBody.temperature;

  const oaiBody = anthropicToOpenAIRequest(anBody);

  // Admin transcript capture: accumulate the assistant reply + thinking.
  const reply = { text: '', thinking: '' };

  if (anBody.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    try {
      await callUpstream(oaiBody, {
        onSseEvent: (chunk) => {
          const d = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
          const ev = {};
          if (d.reasoning_content) { ev.thinking = d.reasoning_content; reply.thinking += d.reasoning_content; }
          if (d.content) { ev.text = d.content; reply.text += d.content; }
          if (chunk.usage) ev.usage = openAIToAnthropicUsage(chunk.usage);
          if (Object.keys(ev).length) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        },
        onEnd: () => {
          res.write('data: [DONE]\n\n'); res.end();
          logChat({
            ts: new Date().toISOString(), model: anBody.model,
            messages: anBody.messages, reply: reply.text, thinking: reply.thinking,
            stream: true, ok: true,
          });
        },
        onError: (e) => {
          res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end();
          logChat({
            ts: new Date().toISOString(), model: anBody.model,
            messages: anBody.messages, reply: '', thinking: '',
            stream: true, ok: false, error: e.message,
          });
        },
      });
    } catch (e) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        res.end();
      }
      logChat({
        ts: new Date().toISOString(), model: anBody.model,
        messages: anBody.messages, reply: '', thinking: '',
        stream: true, ok: false, error: e.message,
      });
    }
  } else {
    try {
      const oai = await callUpstream(oaiBody, {});
      const an = openAIToAnthropicResponse(oai);
      sendJson(res, 200, an);
      const text = (an.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const think = (an.content || []).filter(b => b.type === 'thinking').map(b => b.thinking).join('');
      logChat({
        ts: new Date().toISOString(), model: anBody.model,
        messages: anBody.messages, reply: text, thinking: think,
        stream: false, ok: true, usage: an.usage,
      });
    } catch (e) {
      sendJson(res, e.status || 502, { error: e.message });
      logChat({
        ts: new Date().toISOString(), model: anBody.model,
        messages: anBody.messages, reply: '', thinking: '',
        stream: false, ok: false, error: e.message,
      });
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
      handleApiChat(req, res, await readBody(req));
      return;
    }
    if (req.method === 'POST' && p === '/api/admin/login') {
      let lb; try { lb = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      if (safeEqual(String(lb.password || ''), ADMIN_PASSWORD)) {
        sendJson(res, 200, { token: adminToken(Date.now()) });
      } else {
        sendJson(res, 401, { error: 'wrong password' });
      }
      return;
    }
    if (req.method === 'GET' && p === '/api/admin/logs') {
      if (!adminAuthed(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      // newest first; include both chat transcripts and proxy request log if present
      const requestLog = [];
      try {
        const lp = require('./logger').LOG_PATH;
        if (fs.existsSync(lp)) {
          for (const line of fs.readFileSync(lp, 'utf8').split('\n')) {
            const s = line.trim(); if (!s) continue;
            try { requestLog.push(JSON.parse(s)); } catch {}
          }
        }
      } catch {}
      sendJson(res, 200, { chats: chatLog.slice().reverse(), requests: requestLog.reverse() });
      return;
    }
    if (req.method === 'GET' && p === '/v1/models') {
      if (!authed(req)) { sendJson(res, 401, { error: { message: 'unauthorized' } }); return; }
      const isAnthropic = !!req.headers['anthropic-version'];
      sendJson(res, 200, isAnthropic ? anthropicModelsList() : openaiModelsList());
      return;
    }
    if (req.method === 'POST' && p === '/v1/messages') {
      handleMessages(req, res, await readBody(req));
      return;
    }
    if (req.method === 'POST' && p === '/v1/chat/completions') {
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
