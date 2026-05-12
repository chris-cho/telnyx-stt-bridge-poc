/**
 * Telnyx STT WebSocket Bridge — Cloudflare Worker
 *
 *   client --(WS)--> Worker /stream --(WS)--> wss://api.telnyx.com/v2/speech-to-text/transcription
 *
 * Two source modes (set with ?source=...):
 *
 *   passthrough (default)
 *     Client sends raw WAV/MP3 binary frames; Worker forwards as-is.
 *
 *   telnyx-media-streaming  (use this with TeXML <Stream>)
 *     Client sends Twilio-compatible JSON envelopes:
 *       { event: "connected" | "start" | "media" | "mark" | "stop", ... }
 *     Worker parses them, μ-law-decodes media.payload, synthesizes a
 *     streaming 16-bit PCM WAV (header on start, samples on media),
 *     and forwards to Telnyx STT. Transcripts are logged via wrangler tail.
 *
 * Query params passed through to Telnyx (with env defaults):
 *   transcription_engine, input_format, language, model, interim_results,
 *   endpointing, redact, keyterm, keywords, sample_rate
 */

export interface Env {
  TELNYX_API_KEY: string;
  STT_ENGINE: string;
  STT_INPUT_FORMAT: string;
  STT_LANGUAGE: string;
  STT_INTERIM_RESULTS: string;
}

// Workers fetch() requires http(s):// for WS upgrade — the runtime swaps to
// wss when the Upgrade header is present.
const TELNYX_STT_WS = "https://api.telnyx.com/v2/speech-to-text/transcription";

type SourceMode = "passthrough" | "telnyx-media-streaming";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "telnyx-stt-bridge-poc" });
    }

    if (url.pathname === "/stream") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      console.log("/stream WS upgrade request", {
        source: url.searchParams.get("source"),
        ua: req.headers.get("user-agent"),
      });
      return handleStream(req, env, url);
    }

    if (url.pathname === "/texml") {
      return handleTexml(req, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// /texml — inbound TeXML webhook.
//
// Redundant path requested for POC testing:
//   1. Return <Response><Pause length="5"/></Response> on the initial hit.
//   2. Asynchronously POST a TeXML Update Call command that replaces the
//      current verb queue with <Start><Stream/></Start><Pause/>, injecting
//      the media stream into our /stream WS endpoint.
//
// In production you'd just return <Start><Stream/></Start> in step 1 — but
// the customer wants to validate the Update Call REST flow.
// ---------------------------------------------------------------------------

async function handleTexml(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Telnyx may call this with GET (params in query string) or POST (form
  // body), depending on TeXML App config — read both.
  const url = new URL(req.url);
  const params = new Map<string, string>();
  url.searchParams.forEach((v, k) => params.set(k, v));
  if (req.method === "POST") {
    try {
      const form = await req.formData();
      form.forEach((v, k) => params.set(k, v.toString()));
    } catch { /* not form-encoded */ }
  }

  const accountSid = params.get("AccountSid");
  const callSid = params.get("CallSid");
  console.log("inbound /texml", {
    method: req.method,
    accountSid,
    callSid,
    from: params.get("From"),
    to: params.get("To"),
  });

  if (accountSid && callSid) {
    const streamUrl = new URL(req.url);
    streamUrl.protocol = "wss:";        // <Stream> requires wss://, not https://
    streamUrl.pathname = "/stream";
    streamUrl.search =
      "?source=telnyx-media-streaming&transcription_engine=Telnyx&language=en";
    console.log("update-call -> stream url:", streamUrl.toString());
    ctx.waitUntil(
      updateCallWithStream(env, accountSid, callSid, streamUrl.toString()),
    );
  } else {
    console.warn("missing AccountSid/CallSid; skipping update-call", { method: req.method });
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Pause length="5"/>\n</Response>`;
  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/xml" },
  });
}

async function updateCallWithStream(
  env: Env,
  accountSid: string,
  callSid: string,
  wssUrl: string,
): Promise<void> {
  // XML-escape `&` so the query-string ampersands don't break the TeXML.
  const wssEscaped = wssUrl.replace(/&/g, "&amp;");
  const statusCb = "https://webhook.site/ce09513e-2156-4326-81e5-e5206cd561d7";
  // Match the customer's TeXML shape: <Start><Stream> with bidirectional
  // RTP attributes and both_tracks. Stream `name` is an opaque tag used
  // on stop/clear; reusing the customer's value.
  const newTexml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Start>` +
    `<Stream name="6a0353be0a4912319e826aaf"` +
    ` url="${wssEscaped}"` +
    ` track="both_tracks"` +
    ` bidirectionalCodec="PCMU"` +
    ` bidirectionalSamplingRate="8000"` +
    ` bidirectionalMode="rtp"` +
    ` statusCallback="${statusCb}"` +
    ` statusCallbackMethod="POST"/>` +
    `</Start>` +
    `</Response>`;
  console.log("update-call new TeXML:\n" + newTexml);

  const body = new URLSearchParams({
    Texml: newTexml,
    StatusCallback: "https://webhook.site/ce09513e-2156-4326-81e5-e5206cd561d7",
    StatusCallbackMethod: "POST",
  }).toString();
  const url =
    `https://api.telnyx.com/v2/texml/Accounts/${accountSid}/Calls/${callSid}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("update-call failed", res.status, txt);
  } else {
    console.log("update-call ok, stream injected for", callSid, "response:", txt.slice(0, 500));
  }
}

async function handleStream(_req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.TELNYX_API_KEY) {
    return new Response("TELNYX_API_KEY not configured", { status: 500 });
  }

  const source: SourceMode =
    url.searchParams.get("source") === "telnyx-media-streaming"
      ? "telnyx-media-streaming"
      : "passthrough";

  const upstreamUrl = buildUpstreamUrl(url.searchParams, env, source);

  console.log("opening upstream WS:", upstreamUrl);
  const upstreamResp = await fetch(upstreamUrl, {
    headers: {
      Upgrade: "websocket",
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
    },
  });
  console.log("upstream handshake:", upstreamResp.status, upstreamResp.statusText);

  const upstream = upstreamResp.webSocket;
  if (!upstream) {
    const body = await upstreamResp.text().catch(() => "");
    console.error("telnyx ws upgrade failed", upstreamResp.status, body);
    return new Response(
      `upstream ws upgrade failed (${upstreamResp.status}): ${body}`,
      { status: 502 },
    );
  }
  upstream.accept();

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  if (source === "telnyx-media-streaming") {
    bridgeMediaStreaming(server, upstream);
  } else {
    bridgePassthrough(server, upstream);
  }

  return new Response(null, { status: 101, webSocket: client });
}

function buildUpstreamUrl(
  clientParams: URLSearchParams,
  env: Env,
  source: SourceMode,
): string {
  const params = new URLSearchParams();

  params.set("transcription_engine", clientParams.get("transcription_engine") ?? env.STT_ENGINE);

  // In media-streaming mode we synthesize a WAV, so force input_format=wav.
  const inputFormat = source === "telnyx-media-streaming"
    ? "wav"
    : (clientParams.get("input_format") ?? env.STT_INPUT_FORMAT);
  params.set("input_format", inputFormat);

  const passthrough = [
    "language",
    "model",
    "interim_results",
    "endpointing",
    "redact",
    "keyterm",
    "keywords",
    "sample_rate",
  ];
  for (const key of passthrough) {
    const v = clientParams.get(key);
    if (v != null) params.set(key, v);
  }

  if (!params.has("language")) params.set("language", env.STT_LANGUAGE);
  if (!params.has("interim_results")) params.set("interim_results", env.STT_INTERIM_RESULTS);

  return `${TELNYX_STT_WS}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Passthrough bridge: client sends WAV/MP3 binary, transcripts go back.
// ---------------------------------------------------------------------------

function bridgePassthrough(client: WebSocket, upstream: WebSocket): void {
  const close = makeCloser(client, upstream);

  try {
    client.send(JSON.stringify({ type: "session.started" }));
  } catch (err) {
    console.error("client send failed", err);
  }

  client.addEventListener("message", (e: MessageEvent) => {
    try {
      upstream.send(e.data as ArrayBuffer | string);
    } catch (err) {
      console.error("upstream send failed", err);
      close(1011, "upstream send failed");
    }
  });
  client.addEventListener("close", (e: CloseEvent) => close(e.code || 1000, e.reason));
  client.addEventListener("error", () => close(1011, "client error"));

  upstream.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string") logTranscript(e.data);
    try {
      client.send(e.data as ArrayBuffer | string);
    } catch (err) {
      console.error("client send failed", err);
      close(1011, "client send failed");
    }
  });
  upstream.addEventListener("close", (e: CloseEvent) => {
    try {
      client.send(JSON.stringify({ type: "session.ended", code: e.code, reason: e.reason }));
    } catch { /* noop */ }
    close(e.code || 1000, e.reason);
  });
  upstream.addEventListener("error", () => close(1011, "upstream error"));
}

// ---------------------------------------------------------------------------
// Telnyx Media Streaming bridge: parse JSON envelopes, μ-law -> PCM16 WAV.
// Telnyx Media Streaming is one-way (it doesn't read responses), so we
// don't echo anything back — transcripts are observed via wrangler tail.
// ---------------------------------------------------------------------------

function bridgeMediaStreaming(client: WebSocket, upstream: WebSocket): void {
  const close = makeCloser(client, upstream);
  let wavHeaderSent = false;
  let firstMessageLogged = false;
  let mediaFrameCount = 0;
  let upstreamMessageCount = 0;

  client.addEventListener("message", (e: MessageEvent) => {
    if (!firstMessageLogged) {
      firstMessageLogged = true;
      const preview = typeof e.data === "string"
        ? e.data.slice(0, 200)
        : `<binary ${(e.data as ArrayBuffer).byteLength} bytes>`;
      console.log("media-streaming first frame:", preview);
    }
    if (typeof e.data !== "string") return;
    let msg: MediaStreamingMessage;
    try {
      msg = JSON.parse(e.data) as MediaStreamingMessage;
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        const fmt = msg.start?.media_format ?? msg.start?.mediaFormat ?? {};
        const sampleRate = Number(fmt.sample_rate ?? fmt.sampleRate ?? 8000);
        const channels = Number(fmt.channels ?? 1);
        console.log("media stream start:", { sampleRate, channels, encoding: fmt.encoding });
        try {
          upstream.send(buildWavHeader(sampleRate, channels, 16));
          wavHeaderSent = true;
          console.log("WAV header sent to upstream (44 bytes)");
        } catch (err) {
          console.error("upstream header send failed", err);
          close(1011, "header send failed");
        }
        return;
      }
      case "media": {
        if (!wavHeaderSent) return;
        const b64 = msg.media?.payload;
        if (!b64) return;
        try {
          const mulaw = base64ToBytes(b64);
          upstream.send(mulawToPcm16(mulaw));
          mediaFrameCount++;
          if (mediaFrameCount === 1 || mediaFrameCount % 100 === 0) {
            console.log("media frames forwarded:", mediaFrameCount);
          }
        } catch (err) {
          console.error("media decode/send failed", err);
          close(1011, "media send failed");
        }
        return;
      }
      case "stop": {
        console.log("media stream stop", { mediaFrameCount, upstreamMessageCount });
        try { upstream.close(1000, "stream stopped"); } catch { /* noop */ }
        return;
      }
      default:
        return;
    }
  });

  client.addEventListener("close", (e: CloseEvent) => {
    console.log("client WS closed", { code: e.code, reason: e.reason, mediaFrameCount });
    close(e.code || 1000, e.reason);
  });
  client.addEventListener("error", () => close(1011, "client error"));

  upstream.addEventListener("message", (e: MessageEvent) => {
    upstreamMessageCount++;
    if (typeof e.data === "string") {
      if (upstreamMessageCount <= 3) {
        console.log("upstream msg #" + upstreamMessageCount + ":", e.data.slice(0, 500));
      }
      logTranscript(e.data);
    } else {
      console.log("upstream binary msg #" + upstreamMessageCount, (e.data as ArrayBuffer).byteLength, "bytes");
    }
  });
  upstream.addEventListener("close", (e: CloseEvent) => {
    console.log("upstream WS closed", {
      code: e.code,
      reason: e.reason,
      mediaFrameCount,
      upstreamMessageCount,
    });
    close(e.code || 1000, e.reason);
  });
  upstream.addEventListener("error", (err: Event) => {
    console.error("upstream WS error", err);
    close(1011, "upstream error");
  });
}

// ---------------------------------------------------------------------------
// μ-law → linear PCM16 (lookup table per ITU-T G.711)
// ---------------------------------------------------------------------------

const MULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    t[i] = sign ? -sample : sample;
  }
  return t;
})();

function mulawToPcm16(mulaw: Uint8Array): Uint8Array {
  const out = new Uint8Array(mulaw.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < mulaw.length; i++) {
    view.setInt16(i * 2, MULAW_TABLE[mulaw[i]], true); // little-endian
  }
  return out;
}

// Streaming WAV header (PCM, sizes set to 0xFFFFFFFF since length is unknown).
function buildWavHeader(sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 0xffffffff, true);   // file size unknown
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);           // fmt chunk size
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, 0xffffffff, true);   // data size unknown
  return new Uint8Array(buf);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeCloser(client: WebSocket, upstream: WebSocket): (code?: number, reason?: string) => void {
  let closed = false;
  return (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    try { client.close(code, reason); } catch { /* noop */ }
    try { upstream.close(code, reason); } catch { /* noop */ }
  };
}

function logTranscript(raw: string): void {
  try {
    const msg = JSON.parse(raw) as {
      type?: string;
      transcript?: string;
      is_final?: boolean;
      confidence?: number;
      error?: string;
    };
    if (msg.type === "transcript") {
      console.log(
        `[${msg.is_final ? "final" : "interim"}]`,
        `(${msg.confidence ?? "?"})`,
        msg.transcript,
      );
    } else if (msg.type === "error") {
      console.error("telnyx stt error:", msg.error);
    }
  } catch {
    /* non-JSON */
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaFormat {
  encoding?: string;
  sample_rate?: number | string;
  sampleRate?: number | string;
  channels?: number | string;
}

interface MediaStreamingMessage {
  event?: string;
  start?: {
    media_format?: MediaFormat;
    mediaFormat?: MediaFormat;
    [k: string]: unknown;
  };
  media?: {
    payload?: string;
    track?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
