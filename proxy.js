/**
 * Vercel Edge-compatible Proxy
 * Supports:
 *   - iiko Cloud API  → ?region=ru&path=api/1/...
 *   - Yandex Eda API  → ?target=yandex&path=security/oauth/token  (or menu/..., order, etc.)
 *
 * Deploy to Vercel: place in /api/proxy.js
 * Usage in console:
 *   Worker VC field: https://your-project.vercel.app/api/proxy
 */

// iiko regional base URLs
const IIKO_BASES = {
  ru:   "https://api-ru.iiko.services",
  us:   "https://api-us.iiko.services",
  eu:   "https://api-eu.iiko.services",
  test: "https://api-test.iiko.services",
};

// Yandex Eda Vendor API base
const YANDEX_BASE = "https://b2b.taxi.yandex.net/api/v1/eats-restapi";

// Allowed origins (add yours if needed)
const ALLOWED_ORIGINS = [
  "https://yourdomain.com",
  "http://localhost",
  "http://127.0.0.1",
  "null", // file:// in some browsers
];

function corsHeaders(origin) {
  const allowed =
    !origin ||
    ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1"));
  return {
    "Access-Control-Allow-Origin": allowed ? (origin || "*") : "null",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Timeout",
    "Access-Control-Expose-Headers": "x-proxy-request-id, x-request-id",
  };
}

function rid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export default async function handler(req) {
  const requestId = rid();
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin);

  // Handle preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(req.url);
  const target = url.searchParams.get("target") || "iiko"; // "iiko" | "yandex"
  const path   = (url.searchParams.get("path") || "").replace(/^\/+/, "");
  const region = url.searchParams.get("region") || "ru";

  if (!path) {
    return new Response(JSON.stringify({ error: "Missing 'path' parameter" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let targetUrl;
  if (target === "yandex") {
    targetUrl = `${YANDEX_BASE}/${path}`;
  } else {
    const iikoBase = IIKO_BASES[region] || IIKO_BASES.ru;
    targetUrl = `${iikoBase}/${path}`;
  }

  // Build upstream headers — forward Authorization and Content-Type
  const upstreamHeaders = {};
  const authorization = req.headers.get("Authorization") || req.headers.get("authorization");
  if (authorization) upstreamHeaders["Authorization"] = authorization;

  const timeoutSec = Math.max(1, Math.min(120, Number(req.headers.get("Timeout") || req.headers.get("timeout") || 15)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let upstreamResp;
  let body = null;

  try {
    const contentType = req.headers.get("Content-Type") || req.headers.get("content-type") || "";
    upstreamHeaders["Content-Type"] = contentType || "application/json";

    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.text();
    }

    upstreamResp = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: body || undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e?.name === "AbortError";
    return new Response(
      JSON.stringify({ error: isTimeout ? `Timeout after ${timeoutSec}s` : String(e) }),
      {
        status: isTimeout ? 504 : 502,
        headers: { ...cors, "Content-Type": "application/json", "x-proxy-request-id": requestId },
      }
    );
  }
  clearTimeout(timer);

  const respBody = await upstreamResp.text();
  const respHeaders = {
    ...cors,
    "Content-Type": upstreamResp.headers.get("Content-Type") || "application/json",
    "x-proxy-request-id": requestId,
  };

  return new Response(respBody, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}

export const config = {
  runtime: "edge",
};
