/**
 * Vercel Serverless Proxy (Node.js)
 *
 * Targets:
 *   ?target=iiko        → https://api-{region}.iiko.services  (iiko Cloud API)
 *   ?target=yandex      → {webhookUrl}/...  (Yandex Eda — твой iiko-сервер)
 *
 * Для Yandex передавай хост через заголовок X-Yandex-Host:
 *   X-Yandex-Host: https://ip-hozhiev-a-a.iikoweb.ru/api/integrations/yandex-food
 *
 * URL в консоли (поле VC):
 *   https://yandex-proxy-seven.vercel.app/api/proxy
 */

const https = require("https");
const http  = require("http");

const IIKO_BASES = {
  ru:   "https://api-ru.iiko.services",
  us:   "https://api-us.iiko.services",
  eu:   "https://api-eu.iiko.services",
  test: "https://api-test.iiko.services",
};

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Timeout, Accept, X-Yandex-Host",
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
      res.on("end",  () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
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

  if (req.method === "OPTIONS") return res.status(204).end();

  const url    = new URL(req.url, `https://${req.headers.host}`);
  const target = url.searchParams.get("target") || "iiko";
  const path   = (url.searchParams.get("path") || "").replace(/^\/+/, "");
  const region = url.searchParams.get("region") || "ru";

  if (!path) {
    res.setHeader("Content-Type", "application/json");
    return res.status(400).end(JSON.stringify({ error: "Missing 'path' query parameter" }));
  }

  let targetUrl;
  if (target === "yandex") {
    // Хост берётся из заголовка X-Yandex-Host
    const yandexHost = (req.headers["x-yandex-host"] || "").trim().replace(/\/+$/, "");
    if (!yandexHost) {
      res.setHeader("Content-Type", "application/json");
      return res.status(400).end(JSON.stringify({ error: "Missing X-Yandex-Host header" }));
    }
    targetUrl = `${yandexHost}/${path}`;
  } else {
    const base = IIKO_BASES[region] || IIKO_BASES.ru;
    targetUrl  = `${base}/${path}`;
  }

  console.log(`[proxy] ${req.method} target=${target} → ${targetUrl}`);

  const upHeaders = {};
  const auth = req.headers["authorization"];
  if (auth) upHeaders["Authorization"] = auth;
  const accept = req.headers["accept"];
  if (accept) upHeaders["Accept"] = accept;

  const timeoutSec = Math.max(1, Math.min(120, parseInt(req.headers["timeout"] || "15", 10)));
  const rawBody = (req.method !== "GET" && req.method !== "HEAD") ? await readBody(req) : null;
  const ct = req.headers["content-type"] || "application/json";
  if (rawBody) upHeaders["Content-Type"] = ct;

  let upResp;
  try {
    upResp = await doRequest(targetUrl, req.method, upHeaders, rawBody, timeoutSec * 1000);
  } catch (e) {
    const isTimeout = e.message === "upstream_timeout";
    res.setHeader("Content-Type", "application/json");
    return res.status(isTimeout ? 504 : 502).end(JSON.stringify({ error: isTimeout ? `Timeout after ${timeoutSec}s` : String(e) }));
  }

  const respCt = upResp.headers["content-type"] || "application/json";
  res.setHeader("Content-Type", respCt);
  return res.status(upResp.status).end(upResp.body);
};
