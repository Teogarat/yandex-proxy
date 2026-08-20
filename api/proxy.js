/**
 * Vercel Serverless Proxy (Node.js)
 *
 * Targets:
 *   ?target=iiko        → https://api-{region}.iiko.services
 *   ?target=yandex      → {X-Yandex-Host}/{path}
 *   ?target=magnit      → {X-Magnit-Host}/{path}
 *
 * Headers:
 *   Yandex:
 *   X-Yandex-Host: https://xxx.iikoweb.ru/api/integrations/yandex-food
 *
 *   Magnit:
 *   X-Magnit-Host: https://xxx.iikoweb.ru/api/integrations/magnit
 *
 * Proxy URL:
 *   https://yandex-proxy-seven.vercel.app/api/proxy
 */

const https = require("https");
const http = require("http");

const IIKO_BASES = {
  ru: "https://api-ru.iiko.services",
  us: "https://api-us.iiko.services",
  eu: "https://api-eu.iiko.services",
  test: "https://api-test.iiko.services",
};

// Не переиспользуем upstream-сокеты.
// Для тяжёлого ответа меню Magnit так надёжнее.
const HTTPS_AGENT = new https.Agent({ keepAlive: false });
const HTTP_AGENT = new http.Agent({ keepAlive: false });

function uid() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "GET, POST, PUT, DELETE, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Timeout, Accept, X-Yandex-Host, X-Magnit-Host",

    "Access-Control-Expose-Headers":
      "x-proxy-request-id, x-proxy-target, x-upstream-time-ms",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", chunk => chunks.push(chunk));

    req.on("end", () => {
      resolve(
        Buffer.concat(chunks).toString("utf8")
      );
    });

    req.on("error", reject);
  });
}

function normalizeBaseUrl(raw, kind) {
  const value = String(raw || "")
    .trim()
    .replace(/\/+$/, "");

  if (!value) {
    throw new Error(`Missing ${kind} host`);
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${kind} host URL`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${kind} host must use https`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      `${kind} host must not contain credentials`
    );
  }

  return parsed.toString().replace(/\/+$/, "");
}

function validateMagnitHost(raw) {
  const base = normalizeBaseUrl(raw, "Magnit");
  const url = new URL(base);

  // Чтобы прокси не превратился в универсальную дырку.
  // Magnit разрешаем только внутри iikoweb.ru.
  if (
    !(
      url.hostname === "iikoweb.ru" ||
      url.hostname.endsWith(".iikoweb.ru")
    )
  ) {
    throw new Error(
      "Magnit host must be inside *.iikoweb.ru"
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");

  if (
    !/\/api\/integrations\/magnit$/i.test(pathname)
  ) {
    throw new Error(
      "Magnit host must end with /api/integrations/magnit"
    );
  }

  return base;
}

function doRequest(
  targetUrl,
  method,
  headers,
  body,
  timeoutMs
) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);

    const isHttps =
      parsed.protocol === "https:";

    const lib =
      isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,

      port:
        parsed.port ||
        (isHttps ? 443 : 80),

      path:
        parsed.pathname +
        parsed.search,

      method,
      headers,

      agent:
        isHttps
          ? HTTPS_AGENT
          : HTTP_AGENT,
    };

    const started = Date.now();

    const upstreamReq =
      lib.request(
        options,
        upstreamRes => {
          const chunks = [];

          upstreamRes.on(
            "data",
            chunk => chunks.push(chunk)
          );

          upstreamRes.on(
            "end",
            () => {
              resolve({
                status:
                  upstreamRes.statusCode,

                headers:
                  upstreamRes.headers,

                body:
                  Buffer.concat(
                    chunks
                  ).toString("utf8"),

                elapsedMs:
                  Date.now() - started,
              });
            }
          );
        }
      );

    upstreamReq.setTimeout(
      timeoutMs,
      () => {
        const err =
          new Error(
            "upstream_timeout"
          );

        err.code =
          "UPSTREAM_TIMEOUT";

        upstreamReq.destroy(err);
      }
    );

    upstreamReq.on(
      "error",
      reject
    );

    if (
      body !== null &&
      body !== undefined
    ) {
      upstreamReq.write(body);
    }

    upstreamReq.end();
  });
}

function isTransientReadError(err) {
  const code =
    String(
      err?.code || ""
    ).toUpperCase();

  const message =
    String(
      err?.message || ""
    ).toUpperCase();

  return (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "EPIPE",
      "EAI_AGAIN",
    ].includes(code) ||

    message.includes(
      "ETIMEDOUT"
    ) ||

    message.includes(
      "ECONNRESET"
    )
  );
}

async function doRequestWithSafeRetry(
  targetUrl,
  method,
  headers,
  body,
  timeoutMs
) {
  try {
    return await doRequest(
      targetUrl,
      method,
      headers,
      body,
      timeoutMs
    );
  } catch (err) {

    /*
     * ВАЖНО:
     * повторяем только GET / HEAD.
     *
     * POST / PUT / DELETE
     * никогда автоматически
     * не повторяем,
     * чтобы не создать
     * два заказа.
     */
    if (
      !["GET", "HEAD"].includes(method) ||
      !isTransientReadError(err)
    ) {
      throw err;
    }

    console.warn(
      `[proxy] transient ${
        err.code || err.message
      }; retrying ${method} once`
    );

    await new Promise(
      resolve =>
        setTimeout(resolve, 250)
    );

    return await doRequest(
      targetUrl,
      method,
      headers,
      body,
      timeoutMs
    );
  }
}

module.exports =
async function handler(req, res) {
  const rid = uid();

  Object.entries(
    corsHeaders()
  ).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.setHeader(
    "x-proxy-request-id",
    rid
  );

  if (req.method === "OPTIONS") {
    return res
      .status(204)
      .end();
  }

  const url =
    new URL(
      req.url,
      `https://${req.headers.host}`
    );

  const target =
    String(
      url.searchParams.get(
        "target"
      ) || "iiko"
    ).toLowerCase();

  const path =
    (
      url.searchParams.get(
        "path"
      ) || ""
    ).replace(/^\/+/, "");

  const region =
    url.searchParams.get(
      "region"
    ) || "ru";

  res.setHeader(
    "x-proxy-target",
    target
  );

  if (!path) {
    res.setHeader(
      "Content-Type",
      "application/json"
    );

    return res
      .status(400)
      .end(
        JSON.stringify({
          error:
            "Missing 'path' query parameter",
        })
      );
  }

  let targetUrl;

  try {

    // ==========================
    // YANDEX
    // ==========================

    if (target === "yandex") {

      const yandexHost =
        normalizeBaseUrl(
          req.headers[
            "x-yandex-host"
          ],
          "Yandex"
        );

      targetUrl =
        `${yandexHost}/${path}`;
    }

    // ==========================
    // MAGNIT
    // ==========================

    else if (
      target === "magnit"
    ) {

      const magnitHost =
        validateMagnitHost(
          req.headers[
            "x-magnit-host"
          ]
        );

      targetUrl =
        `${magnitHost}/${path}`;
    }

    // ==========================
    // IIKO CLOUD
    // ==========================

    else if (
      target === "iiko"
    ) {

      const base =
        IIKO_BASES[region] ||
        IIKO_BASES.ru;

      targetUrl =
        `${base}/${path}`;
    }

    // ==========================
    // UNKNOWN
    // ==========================

    else {

      res.setHeader(
        "Content-Type",
        "application/json"
      );

      return res
        .status(400)
        .end(
          JSON.stringify({
            error:
              `Unknown target '${target}'`,
          })
        );
    }

  } catch (e) {

    res.setHeader(
      "Content-Type",
      "application/json"
    );

    return res
      .status(400)
      .end(
        JSON.stringify({
          error:
            String(
              e.message || e
            ),
        })
      );
  }

  console.log(
    `[proxy] rid=${rid} ` +
    `${req.method} ` +
    `target=${target} ` +
    `→ ${targetUrl}`
  );

  // ==========================
  // UPSTREAM HEADERS
  // ==========================

  const upHeaders = {
    "User-Agent":
      "IIKO-API-Console-Proxy/1.0",
  };

  const auth =
    req.headers[
      "authorization"
    ];

  if (auth) {
    upHeaders[
      "Authorization"
    ] = auth;
  }

  const accept =
    req.headers[
      "accept"
    ];

  if (accept) {
    upHeaders[
      "Accept"
    ] = accept;
  }

  // ==========================
  // TIMEOUT
  // ==========================

  /*
   * Для Magnit
   * по умолчанию 60 секунд.
   *
   * Для iiko / Yandex
   * оставляем 15.
   */

  const parsedTimeout =
    parseInt(
      req.headers[
        "timeout"
      ] ||
      (
        target === "magnit"
          ? "60"
          : "15"
      ),
      10
    );

  const timeoutSec =
    Math.max(
      1,
      Math.min(
        120,

        Number.isFinite(
          parsedTimeout
        )
          ? parsedTimeout
          : 15
      )
    );

  // ==========================
  // BODY
  // ==========================

  let rawBody = null;

  try {

    rawBody =
      req.method !== "GET" &&
      req.method !== "HEAD"

        ? await readBody(req)

        : null;

  } catch (e) {

    res.setHeader(
      "Content-Type",
      "application/json"
    );

    return res
      .status(400)
      .end(
        JSON.stringify({
          error:
            `Cannot read request body: ${String(e)}`,
        })
      );
  }

  const contentType =
    req.headers[
      "content-type"
    ] ||
    "application/json";

  if (rawBody !== null) {

    upHeaders[
      "Content-Type"
    ] = contentType;

    upHeaders[
      "Content-Length"
    ] =
      Buffer.byteLength(
        rawBody,
        "utf8"
      );
  }

  // ==========================
  // SEND REQUEST
  // ==========================

  let upResp;

  try {

    upResp =
      await doRequestWithSafeRetry(
        targetUrl,

        String(
          req.method || "GET"
        ).toUpperCase(),

        upHeaders,

        rawBody,

        timeoutSec * 1000
      );

  } catch (e) {

    const isTimeout =
      e?.message ===
        "upstream_timeout" ||

      e?.code ===
        "UPSTREAM_TIMEOUT";

    const errorCode =
      e?.code || null;

    console.error(
      `[proxy] rid=${rid} ` +
      `failed ` +
      `target=${target} ` +
      `code=${errorCode || "-"} ` +
      `error=${String(e)}`
    );

    res.setHeader(
      "Content-Type",
      "application/json"
    );

    return res
      .status(
        isTimeout
          ? 504
          : 502
      )
      .end(
        JSON.stringify({
          error:
            isTimeout
              ? `Timeout after ${timeoutSec}s`
              : String(e),

          code:
            errorCode,

          target,

          rid,
        })
      );
  }

  // ==========================
  // RESPONSE
  // ==========================

  res.setHeader(
    "x-upstream-time-ms",
    String(
      upResp.elapsedMs
    )
  );

  const respCt =
    upResp.headers[
      "content-type"
    ] ||
    "application/json";

  res.setHeader(
    "Content-Type",
    respCt
  );

  console.log(
    `[proxy] rid=${rid} ` +
    `upstream=${upResp.status} ` +
    `${upResp.elapsedMs}ms ` +
    `bytes=${Buffer.byteLength(
      upResp.body,
      "utf8"
    )}`
  );

  return res
    .status(
      upResp.status
    )
    .end(
      upResp.body
    );
};
