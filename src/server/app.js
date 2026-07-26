import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_LOCALES } from "../core/i18n/index.js";
import { detectInstallSource, NPM_UPDATE_COMMAND } from "../core/version-check.js";
import { createComoteState } from "./state.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
// Upper bound on how much desktop thread history the transcript fallback pulls
// in one thread/read pass — enough for any realistic scroll-back, bounded so a
// pathological thread cannot balloon the response pipeline.
const DESKTOP_TRANSCRIPT_FETCH_CAP = 1000;
const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline"]);
const CONNECTOR_PREFERENCES = new Set(["desktop", "cli"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

export function createServer(state = createComoteState(), { apiToken = process.env.COMOTE_LOCAL_API_TOKEN ?? null } = {}) {
  return createHttpServer(async (request, response) => {
    try {
      if (request.url.startsWith("/api/")) {
        if (!isAuthorizedApiRequest(request, apiToken)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        await handleApi(request, response, state);
        return;
      }
      await serveStatic(request, response);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

async function handleApi(request, response, state) {
  const url = new URL(request.url, "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, {
      appName: "Comote",
      bridge: "running",
      channels: state.registry
        ? Object.fromEntries(
            state.registry.listChannels().map((p) => [
              p.meta.id,
              state.channels?.[p.meta.id]?.getStatus?.().state ?? "reserved",
            ]),
          )
        : {
            // Fallback for registry-less mock states (e.g. hand-built test
            // fixtures). Preserves the original hardcoded shape/keys/values.
            wechat: state.channels?.wechat?.getStatus?.().state ?? "reserved",
            feishu: state.channels?.feishu?.getStatus?.().state ?? "reserved",
          },
      connectors: {
        desktop: state.connectors.desktop.getStatus(),
        cli: state.connectors.cli.getStatus(),
      },
      counts: {
        identities: state.authorization.listIdentities().length,
        projects: state.projects.listProjects().length,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    const settings = state.getSettings();
    sendJson(response, 200, {
      locale: settings.locale,
      localeExplicit: settings.localeExplicit ?? false,
      preferredConnector: settings.preferredConnector ?? "desktop",
      supported: SUPPORTED_LOCALES,
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJsonBody(request);
    const hasLocale = Object.hasOwn(body ?? {}, "locale");
    const hasPreferredConnector = Object.hasOwn(body ?? {}, "preferredConnector");
    if (!hasLocale && !hasPreferredConnector) {
      sendJson(response, 400, { error: "no supported settings supplied" });
      return;
    }
    if (hasLocale && !SUPPORTED_LOCALES.includes(body.locale)) {
      sendJson(response, 400, { error: "unsupported locale" });
      return;
    }
    if (hasPreferredConnector && !CONNECTOR_PREFERENCES.has(body.preferredConnector)) {
      sendJson(response, 400, { error: "unsupported connector preference" });
      return;
    }
    if (hasLocale) {
      state.setLocale(body.locale);
    }
    if (hasPreferredConnector) {
      state.setPreferredConnector(body.preferredConnector);
    }
    await state.persist?.();
    sendJson(response, 200, state.getSettings());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/version") {
    sendJson(response, 200, formatVersionResponse(state));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/version/check") {
    if (!state.versionChecker) {
      sendJson(response, 200, { version: state.currentVersion ?? null });
      return;
    }
    await state.versionChecker.checkNow({ force: true });
    sendJson(response, 200, formatVersionResponse(state));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/logs") {
    const limit = Number(url.searchParams.get("limit") || 100);
    const offset = Number(url.searchParams.get("offset") || 0);
    const entries = state.eventLog?.list?.({ limit, offset }) ?? [];
    const total = state.eventLog?.size?.() ?? entries.length;
    sendJson(response, 200, { entries, total, hasMore: offset + entries.length < total });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/identities") {
    sendJson(response, 200, state.authorization.listIdentities());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/identities/candidates") {
    sendJson(response, 200, state.authorization.listDetectedIdentities());
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/identities/")) {
    const [, , , channel, stableId] = url.pathname.split("/");
    const removedChannel = decodeURIComponent(channel);
    const removedId = decodeURIComponent(stableId);
    state.authorization.removeIdentity({ channel: removedChannel, stableId: removedId });
    state.eventLog?.warn("已移除授权用户", { channel: removedChannel, stableId: removedId });
    await state.persist?.();
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/identities/confirm") {
    const body = await readJsonBody(request);
    const identity = state.authorization.confirmIdentity(body);
    state.eventLog?.info("已确认授权用户", {
      channel: identity.channel,
      displayName: identity.displayName,
    });
    await state.persist?.();
    sendJson(response, 201, identity);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    // Always refresh from Codex Desktop so the list is never stale.
    const projectList = await state.discoverProjects();
    sendJson(response, 200, projectList);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/projects/discover") {
    const projectList = await state.discoverProjects();
    sendJson(response, 200, projectList);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const projectPath = url.searchParams.get("projectPath");
    sendJson(response, 200, projectPath ? state.sessions.listSessions(projectPath) : []);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/connectors/codex-desktop/initialize") {
    try {
      const result = await state.connectors.desktop.initialize();
      sendJson(response, 200, result);
    } catch (error) {
      state.eventLog?.error("连接 Codex Desktop 失败", { error: error.message });
      sendJson(response, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/connectors/codex-desktop/auto-connect") {
    try {
      const result = await state.connectors.desktop.initialize();
      state.eventLog?.info("已连接 Codex Desktop");
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      state.eventLog?.error("连接 Codex Desktop 失败", { error: error.message });
      sendJson(response, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/codex/threads") {
    const cwd = url.searchParams.get("cwd");
    // Pagination passthrough: limit (bounded to a sane 1..100) and the opaque
    // cursor from a previous response's nextCursor. The connector's response
    // ({ data, nextCursor, backwardsCursor }) is forwarded as-is so the
    // frontend can chain "load more" requests.
    const rawLimit = Number(url.searchParams.get("limit") || 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 20;
    const cursor = url.searchParams.get("cursor") || null;
    const result = await state.connectors.desktop.listThreads({ cwd, limit, cursor });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/codex/transcript") {
    const threadId = url.searchParams.get("threadId");
    if (threadId) {
      const limit = Number(url.searchParams.get("limit") || 20);
      const offset = Number(url.searchParams.get("offset") || 0);
      const local = state.transcript?.listThread?.(threadId, { limit, offset })
        ?? { threadId, messages: [], total: 0, hasMore: false };
      if ((local.total ?? 0) === 0) {
        // No local record AT ALL — a genuine Codex thread Comote never relayed
        // (the local transcript only holds phone-bridge traffic). Fall back to
        // reading the thread history straight from the connector (thread/read).
        // Gated on total===0, not an empty page: a paginated-past-the-end local
        // request must not silently switch sources mid-scroll. Any failure (not
        // connected, RPC error) degrades to the empty local result instead of a
        // 500. `source` lets the frontend label the origin.
        try {
          // Fetch the whole history once (listRecentMessages walks every turn
          // regardless; the limit only slices) so total/offset/hasMore describe
          // the real thread, mirroring the local transcript's paging contract.
          const recent = await state.connectors?.desktop?.listRecentMessages?.({
            threadId,
            limit: DESKTOP_TRANSCRIPT_FETCH_CAP,
          });
          const all = (recent?.messages ?? [])
            .map((message) => ({
              role: message?.role === "user" ? "user" : "assistant",
              text: message?.text ?? "",
            }))
            .filter((message) => message.text)
            // The local transcript pages newest-first and the frontend
            // reverses for display — match that order.
            .reverse();
          if (all.length > 0) {
            // `total` is the connector's untruncated count — the frontend
            // detects new messages by total deltas, so it must keep growing
            // past the fetch cap. `hasMore` stays window-bounded: pages past
            // the cap don't exist server-side, so paging stops there instead
            // of chasing empty pages toward the real total.
            const total = Number.isFinite(recent?.total) ? recent.total : all.length;
            sendJson(response, 200, {
              threadId,
              messages: all.slice(offset, offset + limit),
              total,
              hasMore: offset + limit < all.length,
              source: "desktop",
            });
            return;
          }
        } catch {
          // Fall through to the local (empty) result below.
        }
      }
      sendJson(response, 200, { ...local, source: "local" });
      return;
    }
    sendJson(response, 200, state.transcript?.list?.() ?? []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/codex/usage") {
    sendJson(response, 200, state.connectors.desktop.getUsage?.() ?? { tokenUsage: null, rateLimits: null });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/approvals") {
    sendJson(response, 200, state.connectors.desktop.listPendingApprovals?.() ?? []);
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
    const approvalId = decodeURIComponent(url.pathname.slice("/api/approvals/".length));
    const body = await readJsonBody(request);
    const decision = body.decision ?? "decline";
    if (!APPROVAL_DECISIONS.has(decision)) {
      sendJson(response, 400, { error: "unsupported approval decision" });
      return;
    }
    const result = await state.connectors.desktop.resolveApproval(approvalId, decision);
    state.eventLog?.info(`审批已${decision === "decline" ? "拒绝" : "批准"}`, { approvalId, decision });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channel/message") {
    const body = await readJsonBody(request);
    const reply = await state.commandRouter.handleMessageAsync(body);
    state.eventLog?.info("已处理通道命令", { channel: body?.identity?.channel ?? "unknown" });
    await state.persist?.();
    sendJson(response, 200, reply);
    return;
  }

  // The channel list (meta + live status) for a generic frontend binding page.
  // Registry-driven, so a newly registered channel auto-appears here. config is
  // the wrapper's PUBLIC config (redacted) — never raw secrets.
  if (request.method === "GET" && url.pathname === "/api/channels") {
    const list = (state.registry?.listChannels?.() ?? []).map((p) => ({
      ...p.meta,
      status: state.channels?.[p.meta.id]?.getStatus?.() ?? { state: "reserved" },
      runtime: state.runtime?.[p.meta.id]?.getStatus?.() ?? { state: "not_configured" },
      config: state.runtime?.[p.meta.id]?.getConfig?.() ?? {},
    }));
    sendJson(response, 200, list);
    return;
  }

  // The outbound replies list (no channel id) is served explicitly — the
  // generic :id/sub matcher below requires a sub-segment so it won't catch it.
  if (request.method === "GET" && url.pathname === "/api/channels/outbound-replies") {
    sendJson(response, 200, state.outboundReplies?.list?.() ?? []);
    return;
  }

  // Generic per-channel dispatch: /api/channels/:id/:sub. The channel set and
  // its capabilities (poll vs push, qr login) come from the registry + plugin
  // meta, so adding a channel = registering a plugin (no edits here). Behavior
  // for every (method, sub) pair below is byte-identical to the old per-channel
  // ladder this replaces.
  const channelRoute = url.pathname.match(/^\/api\/channels\/([^/]+)\/(.+)$/);
  if (channelRoute) {
    const id = decodeURIComponent(channelRoute[1]);
    const sub = channelRoute[2];
    const plugin = state.registry?.getChannel?.(id) ?? null;
    const runtime = state.runtime?.[id] ?? null;
    const adapter = state.channels?.[id] ?? null;
    if (!runtime && !adapter) {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    // Capability gates. When the registry exposes plugin meta we drive off it;
    // otherwise (e.g. hand-built mock state) we duck-type the runtime wrapper,
    // which state.js builds with exactly these methods per meta — so the two
    // forms agree.
    const canPoll = plugin
      ? plugin.meta.inboundMode === "poll"
      : typeof runtime?.pollOnce === "function";
    const canDeliver = plugin
      ? plugin.meta.inboundMode === "push"
      : typeof runtime?.deliverQueued === "function";
    const isPush = plugin
      ? plugin.meta.inboundMode === "push"
      : typeof runtime?.handleInbound === "function";
    const canLogin = plugin
      ? plugin.meta.binding === "qr"
      : typeof runtime?.startLogin === "function";

    if (request.method === "GET" && sub === "status") {
      // /status reads the ADAPTER (not the runtime).
      sendJson(response, 200, adapter.getStatus());
      return;
    }

    if (request.method === "GET" && sub === "config") {
      sendJson(response, 200, runtime?.getConfig?.() ?? {});
      return;
    }

    if (request.method === "PUT" && sub === "config") {
      const body = await readJsonBody(request);
      // configure() returns the public config in both channel wrappers.
      const config = await runtime.configure(body);
      await state.persist?.();
      sendJson(response, 200, config);
      return;
    }

    if (request.method === "GET" && sub === "runtime") {
      sendJson(response, 200, runtime?.getStatus?.() ?? { state: "not_configured" });
      return;
    }

    if (request.method === "POST" && sub === "runtime/start") {
      // feishu.start() is async, wechat's is sync — await is harmless on both.
      sendJson(response, 200, await runtime.start());
      return;
    }

    if (request.method === "POST" && sub === "runtime/stop") {
      sendJson(response, 200, runtime.stop());
      return;
    }

    if (request.method === "POST" && sub === "runtime/poll" && canPoll) {
      const result = await runtime.pollOnce();
      await state.persist?.();
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && sub === "runtime/deliver" && canDeliver) {
      const result = await runtime.deliverQueued();
      await state.persist?.();
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && sub === "login/start" && canLogin) {
      const body = await readJsonBody(request);
      // feishu reads body.domain; wechat.startLogin() ignores its argument, so
      // passing the domain superset is harmless and keeps this channel-agnostic.
      sendJson(response, 200, await runtime.startLogin({ domain: body.domain ?? "feishu" }));
      return;
    }

    if (request.method === "GET" && sub === "login/status" && canLogin) {
      // feishu reads domain/interval/expireIn; wechat reads only loginId. Build
      // the superset of args — extra keys are ignored by wechat.getLoginStatus.
      sendJson(response, 200, await runtime.getLoginStatus({
        loginId: url.searchParams.get("loginId"),
        domain: url.searchParams.get("domain") ?? undefined,
        interval: Number(url.searchParams.get("interval") || 5),
        expireIn: Number(url.searchParams.get("expireIn") || 600),
      }));
      return;
    }

    if (request.method === "POST" && sub === "inbound") {
      const body = await readJsonBody(request);
      // Push channels use the RUNTIME's handleInbound (challenge + dedup) with a
      // fallback to the adapter; poll channels use the adapter directly.
      const target = runtime?.handleInbound ? runtime : adapter;
      const reply = await target.handleInbound(body);
      // Poll channels (wechat) log an inbound notice; push channels (feishu) do
      // not. Preserve the exact existing wechat log string.
      if (!isPush) {
        state.eventLog?.info("收到微信消息");
      }
      await state.persist?.();
      if (reply.kind === "challenge") {
        sendJson(response, 200, { challenge: reply.challenge });
        return;
      }
      sendJson(response, 200, reply);
      return;
    }

    if (request.method === "GET" && sub === "outbound") {
      sendJson(response, 200, state.outboundReplies?.list?.({ channel: id }) ?? []);
      return;
    }

    const ackMatch = request.method === "POST" && sub.match(/^outbound\/(.+)\/ack$/);
    if (ackMatch) {
      const replyId = decodeURIComponent(ackMatch[1]);
      state.outboundReplies.ack(replyId);
      await state.persist?.();
      response.writeHead(204);
      response.end();
      return;
    }

    // Unknown (method, sub) for a known channel → fall through to 404.
    sendJson(response, 404, { error: "not found" });
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
  const stream = createReadStream(filePath);

  // Defer writing the 200 status until the file is actually open so that an
  // ENOENT/EISDIR error fires before any headers have been sent.
  stream.on("open", () => {
    response.writeHead(200, { "content-type": contentType });
    stream.pipe(response);
  });

  stream.on("error", (error) => {
    if (!response.headersSent) {
      if (error.code === "ENOENT" || error.code === "EISDIR") {
        sendJson(response, 404, { error: "not found" });
      } else {
        sendJson(response, 500, { error: error.message });
      }
    } else {
      // Data already flowing — destroy the socket to avoid a half-written response.
      response.destroy(error);
    }
  });
}

function formatVersionResponse(state) {
  const version = state.currentVersion ?? null;
  // The Tauri shell probes this endpoint before reusing a running daemon: it
  // matches `version` to decide reuse, and adopts the daemon by `pid` so it can
  // be stopped on quit (B3b PID adoption). Always expose the daemon's own pid.
  const pid = process.pid;
  if (!state.versionChecker) {
    return {
      version,
      pid,
      latest: null,
      hasUpdate: false,
      releaseUrl: null,
      downloadUrl: null,
      updateCommand: detectInstallSource() === "npm" ? NPM_UPDATE_COMMAND : null,
      platform: process.platform,
      checkedAt: null,
    };
  }
  const result = state.versionChecker.getLastResult();
  return {
    version,
    pid,
    latest: result.latest,
    hasUpdate: Boolean(result.hasUpdate),
    releaseUrl: result.releaseUrl,
    downloadUrl: result.downloadUrl ?? null,
    // On Linux the daemon is installed via npm, so the frontend renders a
    // copy-pasteable command instead of a (nonexistent) download link.
    updateCommand: result.updateCommand ?? null,
    platform: result.platform ?? process.platform,
    releaseNotes: result.releaseNotes,
    checkedAt: result.checkedAt,
    error: result.error,
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isAuthorizedApiRequest(request, apiToken) {
  // When no local API token is configured the daemon relies on its 127.0.0.1
  // bind for isolation. When a token IS set it must be enforced on every
  // method — reads leak project paths and identities just like writes do.
  if (!apiToken) {
    return true;
  }
  const header = request.headers["x-comote-token"];
  const auth = request.headers.authorization;
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : null;
  return constantTimeEquals(header, apiToken) || constantTimeEquals(bearer, apiToken);
}

// Length-safe constant-time string comparison. timingSafeEqual throws on
// unequal-length buffers, so we branch on length first (the token's length is
// not the secret here) and, on the unequal branch, still run a same-length
// timingSafeEqual so the work done doesn't vary; equal-length inputs compare in
// constant time regardless of where the first differing byte is.
function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Still run a comparison against a same-length buffer so the work done does
    // not vary with whether the lengths happened to match.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
