/**
 * Telnyx STT WebSocket Bridge — Cloudflare Worker
 *
 *   client --(WS)--> Worker /stream --(WS)--> wss://api.telnyx.com/v2/speech-to-text/transcription
 *
 * - Client opens a WebSocket to /stream?engine=...&language=...&model=...
 *   (query params are forwarded as-is to Telnyx, with sensible defaults from env).
 * - The Worker opens an outbound WS to Telnyx STT with Bearer auth and
 *   bidirectionally pipes:
 *     client -> Telnyx : binary audio frames (WAV/MP3 per input_format)
 *     Telnyx -> client : JSON transcript / error messages
 * - The Worker also sends a `{"type":"session.started"}` to the client on
 *   upstream open, and `{"type":"session.ended"}` on close.
 *
 * Audio format note:
 *   Telnyx STT WS expects WAV or MP3 frames. If your source is raw μ-law
 *   from Telnyx Media Streaming, you'd need to transcode (out of scope here).
 */

export interface Env {
  TELNYX_API_KEY: string;
  STT_ENGINE: string;
  STT_INPUT_FORMAT: string;
  STT_LANGUAGE: string;
  STT_INTERIM_RESULTS: string;
}

const TELNYX_STT_WS = "wss://api.telnyx.com/v2/speech-to-text/transcription";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "telnyx-stt-bridge-poc" });
    }

    if (url.pathname === "/stream") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      return handleStream(req, env, url);
    }

    return new Response("not found", { status: 404 });
  },
};

async function handleStream(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.TELNYX_API_KEY) {
    return new Response("TELNYX_API_KEY not configured", { status: 500 });
  }

  const upstreamUrl = buildUpstreamUrl(url.searchParams, env);

  // Open outbound WS to Telnyx with Bearer auth.
  const upstreamResp = await fetch(upstreamUrl, {
    headers: {
      Upgrade: "websocket",
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
    },
  });

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

  // Inbound WS pair.
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  bridge(server, upstream);

  return new Response(null, { status: 101, webSocket: client });
}

function buildUpstreamUrl(clientParams: URLSearchParams, env: Env): string {
  const params = new URLSearchParams();

  // Required by Telnyx; client may override.
  params.set("transcription_engine", clientParams.get("transcription_engine") ?? env.STT_ENGINE);
  params.set("input_format", clientParams.get("input_format") ?? env.STT_INPUT_FORMAT);

  // Optional pass-throughs.
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

  // Defaults for common optionals when not provided.
  if (!params.has("language")) params.set("language", env.STT_LANGUAGE);
  if (!params.has("interim_results")) params.set("interim_results", env.STT_INTERIM_RESULTS);

  return `${TELNYX_STT_WS}?${params.toString()}`;
}

function bridge(client: WebSocket, upstream: WebSocket): void {
  let closed = false;
  const closeBoth = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    try { client.close(code, reason); } catch { /* noop */ }
    try { upstream.close(code, reason); } catch { /* noop */ }
  };

  // Notify client of upstream session lifecycle.
  try {
    client.send(JSON.stringify({ type: "session.started" }));
  } catch (err) {
    console.error("client send failed", err);
  }

  // client -> upstream: forward audio frames (binary) and any control text.
  client.addEventListener("message", (e: MessageEvent) => {
    try {
      upstream.send(e.data as ArrayBuffer | string);
    } catch (err) {
      console.error("upstream send failed", err);
      closeBoth(1011, "upstream send failed");
    }
  });

  client.addEventListener("close", (e: CloseEvent) => {
    console.log("client closed", e.code, e.reason);
    closeBoth(e.code || 1000, e.reason);
  });

  client.addEventListener("error", (err: Event) => {
    console.error("client ws error", err);
    closeBoth(1011, "client error");
  });

  // upstream -> client: forward transcripts / errors. Log final transcripts.
  upstream.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string") {
      logTranscript(e.data);
    }
    try {
      client.send(e.data as ArrayBuffer | string);
    } catch (err) {
      console.error("client send failed", err);
      closeBoth(1011, "client send failed");
    }
  });

  upstream.addEventListener("close", (e: CloseEvent) => {
    console.log("upstream closed", e.code, e.reason);
    try {
      client.send(JSON.stringify({ type: "session.ended", code: e.code, reason: e.reason }));
    } catch { /* noop */ }
    closeBoth(e.code || 1000, e.reason);
  });

  upstream.addEventListener("error", (err: Event) => {
    console.error("upstream ws error", err);
    closeBoth(1011, "upstream error");
  });
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
    // Non-JSON upstream message; ignore.
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
