# Telnyx STT WebSocket Bridge POC

Cloudflare Worker that accepts an inbound WebSocket from a client and
bridges it to the Telnyx Speech-to-Text streaming WebSocket API,
piping audio one way and transcripts back the other.

## Architecture
```
client ──(WS)──> Worker /stream ──(WS, Bearer auth)──> wss://api.telnyx.com/v2/speech-to-text/transcription
       <──(WS)──                                  <──
```

The Worker:
- Adds `Authorization: Bearer <TELNYX_API_KEY>` on the outbound WS
  handshake so the client never sees the API key.
- Forwards client query params (`transcription_engine`, `input_format`,
  `language`, `model`, `interim_results`, `endpointing`, `redact`,
  `keyterm`, `keywords`, `sample_rate`) to Telnyx, with defaults from
  env vars.
- Logs transcripts and errors via `wrangler tail`.

## Source modes (`?source=...`)
Two modes for the inbound side:

### `passthrough` (default)
Client sends raw **WAV or MP3 binary frames**; Worker forwards as-is.
Transcripts are sent back over the same WebSocket as JSON. The Worker
also sends `{"type":"session.started"}` / `{"type":"session.ended"}`
brackets to the client.

### `telnyx-media-streaming` (use with TeXML `<Stream>`)
Client (Telnyx) sends Twilio-compatible JSON envelopes:
```json
{ "event": "start",  "start": { "media_format": { "encoding": "audio/x-mulaw", "sample_rate": 8000, "channels": 1 } } }
{ "event": "media",  "media": { "payload": "<base64 μ-law>" } }
{ "event": "stop" }
```
The Worker:
1. On `start`, sends a streaming 16-bit PCM WAV header to Telnyx STT.
2. On each `media`, base64-decodes the payload, μ-law→PCM16 decodes it,
   and sends raw PCM samples to Telnyx STT.
3. On `stop`, closes the upstream session.
4. Forces `input_format=wav` regardless of client query param.

Media Streaming is one-way — Telnyx does **not** read responses from the
WS endpoint. Transcripts are surfaced via `wrangler tail` only. If you
need them delivered somewhere, add a webhook POST in `logTranscript()`
or fan them out to another WS.

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
`input_format`). In `passthrough` mode the Worker forwards binary
unchanged. In `telnyx-media-streaming` mode it synthesizes a 16-bit
PCM WAV stream from inbound μ-law audio.

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

Quick smoke test with `websocat` (passthrough mode):
```bash
websocat -b 'ws://localhost:8787/stream?transcription_engine=Telnyx&input_format=wav&language=en' < sample.wav
```

## Using with TeXML
Return TeXML from your voice webhook to start a bidirectional stream
into this bridge:
```xml
<Response>
  <Start>
    <Stream url="wss://telnyx-stt-bridge-poc.solutions-2bd.workers.dev/stream?source=telnyx-media-streaming&amp;transcription_engine=Telnyx&amp;language=en" />
  </Start>
  <Pause length="60"/>
</Response>
```
Watch transcripts roll in with `npx wrangler tail --format=pretty`.

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
