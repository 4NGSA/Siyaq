/**
 * Siyaq Anthropic proxy for Cloudflare Workers (module syntax, no packages).
 *
 * Required Worker secrets:
 *   ANTHROPIC_API_KEY
 *
 * Required Worker variables:
 *   ALLOWED_ORIGINS=https://your-app.example,https://preview.example
 *
 * Recommended Worker variables:
 *   ALLOWED_MODELS=claude-sonnet-4-20250514
 *
 * Optional variables/bindings:
 *   ANTHROPIC_API_VERSION=2023-06-01
 *   UPSTREAM_TIMEOUT_MS=15000
 *   RATE_LIMIT_MAX=20
 *   RATE_LIMIT_WINDOW_SECONDS=60
 *   RATE_LIMIT_KV=<Cloudflare KV namespace binding>
 *   ALLOW_NO_ORIGIN=false
 *
 * The KV limiter is deliberately basic and eventually consistent. It is useful
 * for hackathon abuse resistance, but a Durable Object or Cloudflare WAF rate
 * limiting rule is the stronger production option.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_API_VERSION = "2023-06-01";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 24_000;
const MAX_TOKENS = 1_024;

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const origin = request.headers.get("Origin");
    const allowedOrigins = parseCsv(env.ALLOWED_ORIGINS);
    const originAllowed =
      (origin && allowedOrigins.has(origin)) ||
      (!origin && env.ALLOW_NO_ORIGIN === "true");

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        return errorResponse(403, "Origin not allowed", requestId);
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    if (request.method !== "POST") {
      return errorResponse(
        405,
        "Method not allowed",
        requestId,
        originAllowed ? origin : null,
        { Allow: "POST, OPTIONS" },
      );
    }

    if (!originAllowed) {
      return errorResponse(403, "Origin not allowed", requestId);
    }

    if (!env.ANTHROPIC_API_KEY) {
      console.error(`[${requestId}] Missing ANTHROPIC_API_KEY`);
      return errorResponse(503, "Service unavailable", requestId, origin);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return errorResponse(
        415,
        "Content-Type must be application/json",
        requestId,
        origin,
      );
    }

    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return errorResponse(413, "Request body too large", requestId, origin);
    }

    let rawBody;
    try {
      rawBody = await request.text();
    } catch {
      return errorResponse(400, "Unable to read request body", requestId, origin);
    }

    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, "Request body too large", requestId, origin);
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, "Invalid JSON", requestId, origin);
    }

    const validationError = validatePayload(body, env);
    if (validationError) {
      return errorResponse(400, validationError, requestId, origin);
    }

    const rateLimit = await checkRateLimit(
      request,
      env,
      requestId,
    );
    if (!rateLimit.allowed) {
      return errorResponse(
        429,
        "Too many requests",
        requestId,
        origin,
        { "Retry-After": String(rateLimit.retryAfter) },
      );
    }

    const timeoutMs = clampInteger(env.UPSTREAM_TIMEOUT_MS, 15_000, 1_000, 30_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": env.ANTHROPIC_API_VERSION || DEFAULT_API_VERSION,
        },
        body: JSON.stringify({
          model: body.model,
          max_tokens: body.max_tokens,
          messages: body.messages,
        }),
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const upstreamRequestId = upstream.headers.get("request-id") || "unknown";
        console.error(
          `[${requestId}] Anthropic error status=${upstream.status} ` +
            `upstream_request_id=${upstreamRequestId}`,
        );

        const status = upstream.status === 429 ? 429 : 502;
        const message =
          upstream.status === 429
            ? "AI service rate limit reached"
            : "AI service unavailable";
        return errorResponse(status, message, requestId, origin);
      }

      let responseBody;
      try {
        responseBody = await upstream.json();
      } catch {
        console.error(`[${requestId}] Anthropic returned invalid JSON`);
        return errorResponse(502, "Invalid AI service response", requestId, origin);
      }

      return jsonResponse(responseBody, 200, requestId, origin);
    } catch (error) {
      if (error && error.name === "AbortError") {
        console.error(`[${requestId}] Anthropic request timed out`);
        return errorResponse(504, "AI service timed out", requestId, origin);
      }

      console.error(`[${requestId}] Anthropic request failed`);
      return errorResponse(502, "AI service unavailable", requestId, origin);
    } finally {
      clearTimeout(timeout);
    }
  },
};

function validatePayload(body, env) {
  if (!isPlainObject(body)) {
    return "Request body must be an object";
  }

  const allowedKeys = new Set(["model", "max_tokens", "messages"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return "Request body contains unsupported fields";
  }

  const allowedModels = parseCsv(env.ALLOWED_MODELS || DEFAULT_MODEL);
  if (typeof body.model !== "string" || !allowedModels.has(body.model)) {
    return "Unsupported model";
  }

  if (
    !Number.isInteger(body.max_tokens) ||
    body.max_tokens < 1 ||
    body.max_tokens > MAX_TOKENS
  ) {
    return `max_tokens must be an integer between 1 and ${MAX_TOKENS}`;
  }

  if (
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > MAX_MESSAGES
  ) {
    return `messages must contain between 1 and ${MAX_MESSAGES} items`;
  }

  let totalChars = 0;
  for (const message of body.messages) {
    if (
      !isPlainObject(message) ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length < 1
    ) {
      return "Each message must have a valid role and non-empty string content";
    }

    if (Object.keys(message).some((key) => !["role", "content"].includes(key))) {
      return "A message contains unsupported fields";
    }

    totalChars += message.content.length;
    if (totalChars > MAX_MESSAGE_CHARS) {
      return "Message content is too large";
    }
  }

  return null;
}

async function checkRateLimit(request, env, requestId) {
  if (!env.RATE_LIMIT_KV) {
    return { allowed: true, retryAfter: 0 };
  }

  const maxRequests = clampInteger(env.RATE_LIMIT_MAX, 20, 1, 1_000);
  const windowSeconds = clampInteger(
    env.RATE_LIMIT_WINDOW_SECONDS,
    60,
    60,
    3_600,
  );
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const windowId = Math.floor(nowSeconds / windowSeconds);
  const retryAfter = windowSeconds - (nowSeconds % windowSeconds);
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const clientHash = await sha256(clientIp);
  const key = `rate:${clientHash}:${windowId}`;

  try {
    const current = Number((await env.RATE_LIMIT_KV.get(key)) || 0);
    if (current >= maxRequests) {
      return { allowed: false, retryAfter };
    }

    await env.RATE_LIMIT_KV.put(key, String(current + 1), {
      expirationTtl: windowSeconds + 60,
    });
  } catch {
    // Rate limiting is optional. A KV outage should not take down the proxy.
    console.error(`[${requestId}] KV rate limiter unavailable`);
  }

  return { allowed: true, retryAfter };
}

function parseCsv(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(body, status, requestId, origin, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
    ...extraHeaders,
  };

  if (origin) {
    Object.assign(headers, corsHeaders(origin));
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status, message, requestId, origin, extraHeaders = {}) {
  return jsonResponse(
    { error: message, request_id: requestId },
    status,
    requestId,
    origin,
    extraHeaders,
  );
}
