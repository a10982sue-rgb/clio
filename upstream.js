// Upstream relay: native https, OpenAI-shaped target.
// callUpstream(oaiBody, { onJson, onSseEvent, onError, onEnd, log })
//   - non-stream: parses upstream JSON, calls onJson(oaiObject)
//   - streaming:  splits SSE, parses each `data:` line, calls onSseEvent(oaiChunk),
//                 honors [DONE], flushes onEnd()
// All paths funnel through /api/chat on the upstream host.
//
// Overload hardening:
//   - shared keep-alive Agent so connections are reused (no fresh TLS per request)
//   - connect + response headers + idle read timeouts, so a stuck upstream can't
//     hold a client connection open forever
//   - bounded concurrency: at most MAX_CONCURRENT requests in flight to the
//     upstream at once; excess are queued and fail fast if the queue overflows,
//     rather than flooding the upstream and causing 502 cascades
//   - one retry on a fresh connection for transient connect/socket errors

const https = require('https');
const { URL } = require('url');

const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'headers-forecasts-slope-did.trycloudflare.com';
const UPSTREAM_PATH = '/api/chat';
const UPSTREAM_PORT = 443;

// Timeouts (ms). Connect/headers is tight so a dead upstream fails fast; the
// read timeout is per-gap-between-chunks, not total — a long stream with
// regular chunks stays alive.
const CONNECT_TIMEOUT_MS = parseInt(process.env.UPSTREAM_CONNECT_TIMEOUT_MS || '8000', 10);
const HEADERS_TIMEOUT_MS = parseInt(process.env.UPSTREAM_HEADERS_TIMEOUT_MS || '20000', 10);
const READ_TIMEOUT_MS = parseInt(process.env.UPSTREAM_READ_TIMEOUT_MS || '60000', 10);

const MAX_CONCURRENT = parseInt(process.env.UPSTREAM_MAX_CONCURRENT || '64', 10);
const MAX_QUEUE = parseInt(process.env.UPSTREAM_MAX_QUEUE || '128', 10);

// Shared keep-alive agent: reuses TLS connections across requests instead of
// opening (and tearing down) a new one each time. Big win under load.
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_CONCURRENT,
  maxFreeSockets: 16,
  timeout: READ_TIMEOUT_MS,
});

// Simple bounded concurrency gate. Pushes a job onto a queue; runs when a slot
// is free. Rejects fast if the queue is full so the caller gets a 502-ish error
// immediately instead of piling on.
let inFlight = 0;
const queue = [];
function acquire() {
  return new Promise((resolve, reject) => {
    if (inFlight < MAX_CONCURRENT) { inFlight++; resolve(); return; }
    if (queue.length >= MAX_QUEUE) { reject(new Error('upstream busy — try again shortly')); return; }
    queue.push(resolve);
  });
}
function release() {
  inFlight--;
  if (queue.length && inFlight < MAX_CONCURRENT) {
    inFlight++;
    const next = queue.shift();
    next();
  }
}

// Apply connect/headers timeouts to an in-flight request. The response object
// isn't available until the callback fires, so we only wire request/socket
// events here; read-gap timing is armed separately once we have `res`.
// Returns { clearAll, attachResponse }.
function armTimeouts(req) {
  let connectTimer = setTimeout(() => { req.destroy(new Error('upstream connect timeout')); }, CONNECT_TIMEOUT_MS);
  let headersTimer;
  let readTimer;

  const clearAll = () => {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
    if (readTimer) { clearTimeout(readTimer); readTimer = null; }
  };

  req.on('socket', (sock) => {
    sock.once('connect', () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      headersTimer = setTimeout(() => { req.destroy(new Error('upstream headers timeout')); }, HEADERS_TIMEOUT_MS);
    });
    sock.once('secureConnect', () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      headersTimer = setTimeout(() => { req.destroy(new Error('upstream headers timeout')); }, HEADERS_TIMEOUT_MS);
    });
  });

  // armRead sets a per-gap timeout; each data chunk resets it. Called by the
  // stream handler once `res` exists.
  const armRead = () => {
    if (readTimer) clearTimeout(readTimer);
    readTimer = setTimeout(() => { req.destroy(new Error('upstream read timeout')); }, READ_TIMEOUT_MS);
  };

  return { clearAll, armRead };
}

function doRequest(oaiBody, hooks, attempt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(oaiBody);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': oaiBody.stream ? 'text/event-stream' : 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'ollie-proxy/1.0',
      'Connection': 'keep-alive',
    };

    const req = https.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: UPSTREAM_PATH,
        method: 'POST',
        headers,
        agent,
      },
      (res) => {
        if (res.statusCode !== 200) {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            const err = new Error(`upstream ${res.statusCode}: ${buf.slice(0, 500)}`);
            err.status = res.statusCode;
            err.transient = res.statusCode >= 500 || res.statusCode === 429;
            timeouts.clearAll();
            hooks.onError && hooks.onError(err);
            reject(err);
          });
          return;
        }

        // Non-stream: collect, parse, done.
        if (!oaiBody.stream) {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            timeouts.clearAll();
            try {
              const obj = JSON.parse(buf);
              hooks.onJson && hooks.onJson(obj);
              resolve(obj);
            } catch (e) {
              hooks.onError && hooks.onError(e);
              reject(e);
            }
          });
          return;
        }

        // Streaming: line-buffer SSE, emit parsed chunks.
        let buffer = '';
        res.on('data', (chunk) => {
          timeouts.armRead(); // reset per-gap read timeout
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep partial line
          for (const raw of lines) {
            const s = raw.trim();
            if (!s.startsWith('data:')) continue;
            const data = s.slice(5).trim();
            if (data === '[DONE]') {
              timeouts.clearAll();
              hooks.onEnd && hooks.onEnd();
              resolve();
              return;
            }
            try {
              const obj = JSON.parse(data);
              hooks.onSseEvent && hooks.onSseEvent(obj);
            } catch {
              // non-JSON keepalive frame; ignore
            }
          }
        });
        res.on('end', () => {
          // flush any trailing buffered line
          if (buffer.trim().startsWith('data:')) {
            const data = buffer.trim().slice(5).trim();
            if (data && data !== '[DONE]') {
              try { hooks.onSseEvent && hooks.onSseEvent(JSON.parse(data)); } catch {}
            }
          }
          timeouts.clearAll();
          hooks.onEnd && hooks.onEnd();
          resolve();
        });
        res.on('error', (e) => { timeouts.clearAll(); hooks.onError && hooks.onError(e); reject(e); });
      }
    );

    // Attach timeouts BEFORE the error handler, but the rejecting error handler
    // FIRST so a connect failure can never become an unhandled 'error' event.
    let settled = false;
    const fail = (e) => {
      if (settled) return; settled = true;
      timeouts.clearAll();
      // One retry on a fresh connection for transient socket/connect errors.
      if (attempt < 1 && isTransient(e)) {
        setImmediate(() => doRequest(oaiBody, hooks, attempt + 1).then(resolve, reject));
      } else {
        hooks.onError && hooks.onError(e);
        reject(e);
      }
    };
    const timeouts = armTimeouts(req);
    req.on('error', fail);

    req.write(payload);
    req.end();
  });
}

function isTransient(e) {
  if (!e) return false;
  const m = (e.message || '').toLowerCase();
  return /econnreset|econnrefused|esockettimedout|etimedout|socket hang up|connect timeout|read timeout/.test(m);
}

function callUpstream(oaiBody, hooks) {
  return acquire().then(
    () => doRequest(oaiBody, hooks, 0).finally(release),
    (err) => { hooks.onError && hooks.onError(err); throw err; }
  );
}

module.exports = { callUpstream, UPSTREAM_HOST, UPSTREAM_PATH };
