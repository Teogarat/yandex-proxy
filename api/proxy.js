/**
 * Vercel Serverless Proxy (Node.js)
 *
 * Targets:
 *   ?target=iiko        → https://api-ru.iiko.services  (iiko Cloud API)
 *   ?target=yandex      → https://b2b.taxi.yandex.net/api/v1/eats-restapi  (Yandex Eda API)
 *   ?target=yandex_auth → https://iam.taxi.yandex.net  (Yandex OAuth token)
 *
 * URL в консоли (поле VC):
 *   https://yandex-proxy-seven.vercel.app/api/proxy
 */

const https = require("https");
const http  = require("http");

const TARGETS = {
  iiko:        "https://api-{region}.iiko.services",
  yandex:      "https://b2b.taxi.yandex.net/api/v1/eats-restapi",
  yandex_auth: "https://iam.taxi.yandex.net",
};

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Timeout",
    "Access-Control-Expose-Headers":"x-proxy-request-id",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function doRequest(targetUrl, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib    = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = lib.request(options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString("utf8"),
      }));
    });

    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("upstream_timeout")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  const rid = uid();

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader("x-proxy-request-id", rid);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const url    = new URL(req.url, `https://${req.headers.host}`);
  const target = url.searchParams.get("target") || "iiko";
  const path   = (url.searchParams.get("path") || "").replace(/^\/+/, "");
  const region = url.searchParams.get("region") || "ru";

  if (!path) {
    res.setHeader("Content-Type", "application/json");
    return res.status(400).end(JSON.stringify({ error: "Missing 'path' query parameter" }));
  }

  let base = TARGETS[target];
  if (!base) {
    res.setHeader("Content-Type", "application/json");
    return res.status(400).end(JSON.stringify({ error: `Unknown target: ${target}` }));
  }

  // iiko поддерживает регионы
  base = base.replace("{region}", region);

  const targetUrl = `${base}/${path}`;

  // Собираем upstream-заголовки
  const upHeaders = {};
  const auth = req.headers["authorization"];
  if (auth) upHeaders["Authorization"] = auth;

  const timeoutSec = Math.max(1, Math.min(120, parseInt(req.headers["timeout"] || "15", 10)));

  const rawBody = (req.method !== "GET" && req.method !== "HEAD")
    ? await readBody(req)
    : null;

  const ct = req.headers["content-type"] || "application/json";
  if (rawBody) upHeaders["Content-Type"] = ct;

  let upResp;
  try {
    upResp = await doRequest(targetUrl, req.method, upHeaders, rawBody, timeoutSec * 1000);
  } catch (e) {
    const isTimeout = e.message === "upstream_timeout";
    res.setHeader("Content-Type", "application/json");
    return res.status(isTimeout ? 504 : 502).end(
      JSON.stringify({ error: isTimeout ? `Timeout after ${timeoutSec}s` : String(e) })
    );
  }

  const respCt = upResp.headers["content-type"] || "application/json";
  res.setHeader("Content-Type", respCt);
  return res.status(upResp.status).end(upResp.body);
};
