// Append-only JSONL request log. One line per request: timestamp, contract,
// model, message count, token usage (when upstream reports it), latency, status.
const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, 'requests.jsonl');

function append(rec) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n', { flag: 'a' });
  } catch (e) {
    // logging must never break the request path
    console.error('[log] write failed:', e.message);
  }
}

function logRequest({ contract, model, msgCount, stream, status, usage, latencyMs, error }) {
  append({
    ts: new Date().toISOString(),
    contract,        // 'openai' | 'anthropic'
    model,
    msg_count: msgCount,
    stream: !!stream,
    status,
    usage: usage || null,
    latency_ms: latencyMs,
    error: error || null,
  });
}

module.exports = { logRequest, LOG_PATH };
