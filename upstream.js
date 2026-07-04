// Upstream relay: native https, OpenAI-shaped target.
// callUpstream(oaiBody, { onJson, onSseEvent, onError, onEnd, log })
//   - non-stream: parses upstream JSON, calls onJson(oaiObject)
//   - streaming:  splits SSE, parses each `data:` line, calls onSseEvent(oaiChunk),
//                 honors [DONE], flushes onEnd()
// All paths funnel through /api/chat on the upstream host.

const https = require('https');
const { URL } = require('url');

const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'headers-forecasts-slope-did.trycloudflare.com';
const UPSTREAM_PATH = '/api/chat';
const UPSTREAM_PORT = 443;

function callUpstream(oaiBody, hooks) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(oaiBody);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': oaiBody.stream ? 'text/event-stream' : 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'ollie-proxy/1.0',
    };

    const req = https.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: UPSTREAM_PATH,
        method: 'POST',
        headers,
        // Cloudflare quick tunnels tolerate normal keep-alive; no special TLS needed.
      },
      (res) => {
        if (res.statusCode !== 200) {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            const err = new Error(`upstream ${res.statusCode}: ${buf.slice(0, 500)}`);
            err.status = res.statusCode;
            err.body = buf;
            hooks.onError && hooks.onError(err);
            reject(err);
          });
          return;
        }

        if (!oaiBody.stream) {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
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
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep partial line
          for (const raw of lines) {
            const s = raw.trim();
            if (!s.startsWith('data:')) continue;
            const data = s.slice(5).trim();
            if (data === '[DONE]') {
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
          hooks.onEnd && hooks.onEnd();
          resolve();
        });
        res.on('error', (e) => { hooks.onError && hooks.onError(e); reject(e); });
      }
    );

    req.on('error', (e) => { hooks.onError && hooks.onError(e); reject(e); });
    req.write(payload);
    req.end();
  });
}

module.exports = { callUpstream, UPSTREAM_HOST, UPSTREAM_PATH };
