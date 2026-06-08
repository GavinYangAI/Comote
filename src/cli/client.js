// Thin HTTP client over the local daemon's 127.0.0.1 API (src/server/app.js).
//
// The daemon needs NO changes for read/write commands — this is a pure client.
// Base URL is derived from the same HOST/PORT env the daemon reads
// (src/server/index.js:5-6), so a daemon started on a custom PORT is found by
// exporting the same PORT. A --base-url escape hatch overrides discovery.
//
// Auth mirrors isAuthorizedApiRequest (app.js:501-514): when a token is
// resolved we send `x-comote-token: <token>` on every request; when none is
// resolved we send no header (the daemon relies on its loopback bind).
//
// The transport is injectable (a fetch-like fn) so the client is unit-testable
// without binding a real port — the dev app holds 16208 and tests must not
// touch it.

import { readFileSync } from "node:fs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 16208;

// Thrown when the daemon socket refuses the connection or times out. The
// dispatcher renders this as a single actionable line and (for the degradable
// commands) falls back to a config-only read of state.json.
export class DaemonUnreachable extends Error {
  constructor(baseUrl, cause) {
    super(`Comote daemon not running on ${baseUrl}. Start it with \`comote\`.`);
    this.name = "DaemonUnreachable";
    this.baseUrl = baseUrl;
    this.code = "DAEMON_UNREACHABLE";
    if (cause) {
      this.cause = cause;
    }
  }
}

// Thrown for HTTP responses the daemon rejected (4xx/5xx). Carries the status
// and parsed body so callers can surface the API's own error text verbatim.
export class ApiError extends Error {
  constructor(status, body, url) {
    const detail =
      body && typeof body === "object" && typeof body.error === "string"
        ? body.error
        : typeof body === "string" && body
          ? body
          : `HTTP ${status}`;
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function resolveBaseUrl({ baseUrl, env = process.env } = {}) {
  if (baseUrl) {
    return baseUrl.replace(/\/+$/, "");
  }
  const host = env.HOST || DEFAULT_HOST;
  const port = Number(env.PORT) || DEFAULT_PORT;
  return `http://${host}:${port}`;
}

function resolveToken({ token, tokenFile, env = process.env } = {}) {
  // Resolution order: explicit token > token file > env. A file lets scripts
  // keep the secret off argv/shell history.
  if (typeof token === "string" && token.length > 0) {
    return token;
  }
  if (typeof tokenFile === "string" && tokenFile.length > 0) {
    return readFileSync(tokenFile, "utf8").trim();
  }
  const fromEnv = env.COMOTE_LOCAL_API_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return null;
}

// Connection-level failures we treat as "daemon not reachable" rather than a
// thrown runtime error, so the CLI can degrade or print the start hint.
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isUnreachable(error) {
  if (!error) {
    return false;
  }
  if (UNREACHABLE_CODES.has(error.code)) {
    return true;
  }
  if (error.cause && UNREACHABLE_CODES.has(error.cause.code)) {
    return true;
  }
  // Undici surfaces connect-refused as a generic TypeError("fetch failed")
  // with the real reason on .cause.
  const causeCode = error.cause?.code;
  return typeof causeCode === "string" && UNREACHABLE_CODES.has(causeCode);
}

export function createClient(options = {}) {
  // `fetchImpl` is injectable for tests; defaults to the global fetch.
  const fetchImpl = options.fetch || globalThis.fetch;
  const env = options.env || process.env;
  const baseUrl = resolveBaseUrl({ baseUrl: options.baseUrl, env });
  const token = resolveToken({
    token: options.token,
    tokenFile: options.tokenFile,
    env,
  });

  async function request(method, path, body) {
    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {};
    if (token) {
      headers["x-comote-token"] = token;
    }
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url, { method, headers, body: payload });
    } catch (error) {
      if (isUnreachable(error)) {
        throw new DaemonUnreachable(baseUrl, error);
      }
      throw error;
    }

    const status = response.status;
    const text = await readBody(response);
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (status === 204 || status === 205) {
      return null;
    }
    if (status >= 200 && status < 300) {
      return parsed;
    }
    throw new ApiError(status, parsed, url);
  }

  return {
    baseUrl,
    hasToken: Boolean(token),
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    del: (path) => request("DELETE", path),
    request,
  };
}

async function readBody(response) {
  // Support both the global fetch Response (.text()) and minimal test doubles
  // that expose a plain `body` string.
  if (typeof response.text === "function") {
    return response.text();
  }
  if (typeof response.body === "string") {
    return response.body;
  }
  return "";
}

export const __test__ = { resolveBaseUrl, resolveToken, isUnreachable };
