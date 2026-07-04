# ollie-chat-railway

Anthropic ↔ OpenAI translating proxy plus a web chat UI, deployable to Railway (or any Node host).

Two surfaces, one process:

- **Public website** — `public/index.html`. A chat UI served at `/`. Talks to the backend's first-party `/api/chat` + `/api/models`. No key needed; visitors just open the site and chat.
- **Translating proxy** — `/v1/messages` (Anthropic contract) and `/v1/chat/completions` (OpenAI contract), plus `/v1/models`. Requires an API key. The proxy translates Anthropic requests to the OpenAI-shaped upstream, and translates responses (streaming + non-streaming) back. Built on the existing `translate.js`, `upstream.js`, `models.js`, `logger.js`.

## API key

Default key: `brotato`. Override with the `API_KEY` env var in production — do **not** ship `brotato` as the real key on a public deploy.

Clients authenticate with either header:
- `Authorization: Bearer brotato`
- `x-api-key: brotato`

## Run locally

```
cd ollie-chat-railway
npm start
# http://localhost:3000   — web chat
```

Zero runtime dependencies — pure Node `http`/`https`, no `npm install` needed.

Environment:
- `PORT` — listen port (default `3000`; Railway sets this for you)
- `API_KEY` — proxy auth key (default `brotato`)
- `UPSTREAM_HOST` — OpenAI-shaped upstream host (see `upstream.js` default)
- `LOG_PATH` — JSONL request log path (default `requests.jsonl`)

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. `railway.json` tells Railway to build with Nixpacks and run `npm start`.
4. Set variables: **Variables → Add** → `API_KEY` = something other than `brotato` if the proxy is exposed publicly.
5. Optionally set `UPSTREAM_HOST` if your upstream differs from the default.
6. Railway assigns a public URL. The web chat is at that root; the proxy is at `<url>/v1/messages` and `/v1/chat/completions`.

## API examples

Anthropic contract (streaming):
```
curl -N https://<your-app>.up.railway.app/v1/messages \
  -H "x-api-key: brotato" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

OpenAI contract:
```
curl https://<your-app>.up.railway.app/v1/chat/completions \
  -H "Authorization: Bearer brotato" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
```

## Files

- `server.js` — HTTP entrypoint: static UI, `/api/chat`, `/api/models`, `/v1/*` proxy with auth
- `translate.js` — Anthropic↔OpenAI request/response/stream translation (existing)
- `upstream.js` — native https relay to the OpenAI-shaped upstream (existing)
- `models.js` — model roster + list responses (existing)
- `logger.js` — append-only JSONL request log (existing)
- `public/index.html` — web chat UI
- `railway.json` — Railway build/deploy config
