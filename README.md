# Telnyx STT WebSocket Bridge POC

Cloudflare Worker that accepts an inbound WebSocket from a client and
bridges it to the Telnyx Speech-to-Text streaming WebSocket API,
piping audio one way and transcripts back the other.

## Architecture
```
client ──(WS, audio binary)──> Worker /stream ──(WS, Bearer auth)──> wss://api.telnyx.com/v2/speech-to-text/transcription
       <──(WS, transcript JSON)──                                <──
```

The Worker is a thin pass-through that:
- Forwards client query params to Telnyx (`transcription_engine`,
  `input_format`, `language`, `model`, `interim_results`, `endpointing`,
  `redact`, `keyterm`, `keywords`, `sample_rate`), applying defaults
  from env vars when missing.
- Adds the `Authorization: Bearer <TELNYX_API_KEY>` header on the
  outbound WS handshake so the client never sees the API key.
- Pipes binary frames client→Telnyx and JSON messages Telnyx→client.
- Logs transcripts and errors for observability.
- Sends `{"type":"session.started"}` / `{"type":"session.ended"}` to
  the client to bracket the upstream session.

## Stack
- Cloudflare Workers (TypeScript)
- Telnyx Speech-to-Text streaming WebSocket API

## Endpoints
| Method | Path      | Purpose                                    |
|--------|-----------|--------------------------------------------|
| GET    | `/`       | Health check                               |
| GET    | `/stream` | WebSocket upgrade — bridges to Telnyx STT  |

## Audio format
Telnyx STT WS expects **WAV** or **MP3** binary frames (selected via
`input_format`). The Worker passes binary through unchanged. If your
source is raw μ-law from Telnyx Media Streaming, you'll need to
transcode upstream of this Worker (out of scope here).

## Query params on `/stream`
Forwarded to Telnyx as-is. Required by Telnyx, with defaults:

| Param                   | Default     | Notes                                    |
|-------------------------|-------------|------------------------------------------|
| `transcription_engine`  | `Telnyx`    | Azure, Deepgram, Google, Telnyx, xAI, AssemblyAI |
| `input_format`          | `wav`       | `wav` or `mp3`                           |
| `language`              | `en`        | e.g. `en-US`, `es-ES`                    |
| `interim_results`       | `true`      | boolean                                  |
| `model`                 | —           | engine-specific                          |
| `endpointing`           | —           | silence ms before finalizing             |
| `redact` / `keyterm` / `keywords` | — | engine-specific                          |
| `sample_rate`           | —           | engine-specific                          |

## Upstream message schema
```json
{ "type": "transcript", "transcript": "string", "is_final": true, "confidence": 0.95 }
{ "type": "error", "error": "string" }
```

## Local development
```bash
cd telnyx-stt-bridge-poc
npm install
cp .dev.vars.example .dev.vars   # fill in TELNYX_API_KEY
npm run dev                      # ws://localhost:8787/stream
```

Quick smoke test with `websocat`:
```bash
websocat 'ws://localhost:8787/stream?transcription_engine=Telnyx&input_format=wav&language=en' < sample.wav
```

## Deploy
```bash
npx wrangler secret put TELNYX_API_KEY
npm run deploy
npm run tail                     # live logs
```

## Config
- **Secret:** `TELNYX_API_KEY` (required)
- **Vars:** `STT_ENGINE`, `STT_INPUT_FORMAT`, `STT_LANGUAGE`,
  `STT_INTERIM_RESULTS` (defaults applied when client omits the
  corresponding query param)

## Files
- `src/index.ts` — Worker: `/stream` WS bridge.
- `wrangler.jsonc` — Worker config and non-secret defaults.
- `.dev.vars.example` — template for local secrets.
