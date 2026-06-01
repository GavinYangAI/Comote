import { createReadStream } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { createComoteState } from "./state.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

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
      channels: {
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
    const result = await state.connectors.desktop.listThreads({ cwd });
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
      if (local.total > 0) {
        sendJson(response, 200, local);
        return;
      }
      // Prefer Codex Desktop's real thread transcript; fall back to the local
      // phone-bridge transcript when the desktop call fails or returns nothing.
      const desktop = state.connectors.desktop;
      if (desktop?.getStatus?.()?.state === "connected" && desktop.getThreadTranscript) {
        try {
          const codex = await desktop.getThreadTranscript({ threadId, limit, offset });
          if (codex?.messages?.length) {
            sendJson(response, 200, codex);
            return;
          }
        } catch {
          // fall through to local transcript
        }
      }
      sendJson(response, 200, local);
      return;
    }
    sendJson(response, 200, state.transcript?.list?.() ?? []);
    return;
  }

  // Threads that have local phone-bridge records, each tagged with the channel
  // it's currently bound to (feishu/wechat) — lets the UI flag and filter which
  // Codex threads were touched over which phone channel.
  if (request.method === "GET" && url.pathname === "/api/codex/phone-threads") {
    const threads = state.transcript?.list?.() ?? [];
    const router = state.commandRouter;
    sendJson(
      response,
      200,
      threads.map((thread) => ({
        threadId: thread.threadId,
        channel: router?.getThreadBinding?.(thread.threadId)?.channel ?? null,
      })),
    );
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
    const result = await state.connectors.desktop.resolveApproval(approvalId, decision);
    state.eventLog?.info(`审批已${decision === "accept" ? "批准" : "拒绝"}`, { approvalId });
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

  if (request.method === "GET" && url.pathname === "/api/channels/wechat/status") {
    sendJson(response, 200, state.channels.wechat.getStatus());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/wechat/config") {
    sendJson(response, 200, state.runtime?.wechat?.getConfig?.() ?? {});
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/channels/wechat/config") {
    const body = await readJsonBody(request);
    await state.runtime.wechat.configure(body);
    await state.persist?.();
    sendJson(response, 200, state.runtime.wechat.getConfig());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/wechat/runtime") {
    sendJson(response, 200, state.runtime?.wechat?.getStatus?.() ?? { state: "not_configured" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/wechat/runtime/poll") {
    const result = await state.runtime.wechat.pollOnce();
    await state.persist?.();
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/wechat/runtime/start") {
    sendJson(response, 200, state.runtime.wechat.start());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/wechat/runtime/stop") {
    sendJson(response, 200, state.runtime.wechat.stop());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/wechat/login/start") {
    sendJson(response, 200, await state.runtime.wechat.startLogin());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/wechat/login/status") {
    sendJson(response, 200, await state.runtime.wechat.getLoginStatus({
      loginId: url.searchParams.get("loginId"),
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/feishu/status") {
    sendJson(response, 200, state.channels.feishu.getStatus());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/feishu/config") {
    sendJson(response, 200, state.runtime?.feishu?.getConfig?.() ?? {});
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/channels/feishu/config") {
    const body = await readJsonBody(request);
    const config = await state.runtime.feishu.configure(body);
    await state.persist?.();
    sendJson(response, 200, config);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/feishu/runtime") {
    sendJson(response, 200, state.runtime?.feishu?.getStatus?.() ?? { state: "not_configured" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/feishu/runtime/start") {
    sendJson(response, 200, await state.runtime.feishu.start());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/feishu/runtime/stop") {
    sendJson(response, 200, state.runtime.feishu.stop());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/feishu/runtime/deliver") {
    const result = await state.runtime.feishu.deliverQueued();
    await state.persist?.();
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/feishu/login/start") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await state.runtime.feishu.startLogin({ domain: body.domain ?? "feishu" }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/feishu/login/status") {
    sendJson(response, 200, await state.runtime.feishu.getLoginStatus({
      loginId: url.searchParams.get("loginId"),
      domain: url.searchParams.get("domain") ?? undefined,
      interval: Number(url.searchParams.get("interval") || 5),
      expireIn: Number(url.searchParams.get("expireIn") || 600),
    }));
    return;
  }


  if (request.method === "POST" && url.pathname === "/api/channels/wechat/inbound") {
    const body = await readJsonBody(request);
    const reply = await state.channels.wechat.handleInbound(body);
    state.eventLog?.info("收到微信消息");
    await state.persist?.();
    sendJson(response, 200, reply);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/channels/feishu/inbound") {
    const body = await readJsonBody(request);
    const reply = state.runtime?.feishu?.handleInbound
      ? await state.runtime.feishu.handleInbound(body)
      : await state.channels.feishu.handleInbound(body);
    await state.persist?.();
    if (reply.kind === "challenge") {
      sendJson(response, 200, { challenge: reply.challenge });
      return;
    }
    sendJson(response, 200, reply);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/outbound-replies") {
    sendJson(response, 200, state.outboundReplies?.list?.() ?? []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/channels/wechat/outbound") {
    sendJson(response, 200, state.outboundReplies?.list?.({ channel: "wechat" }) ?? []);
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/channels/wechat/outbound/")) {
    const suffix = url.pathname.slice("/api/channels/wechat/outbound/".length);
    const id = decodeURIComponent(suffix.replace(/\/ack$/, ""));
    state.outboundReplies.ack(id);
    await state.persist?.();
    response.writeHead(204);
    response.end();
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
  if (!state.versionChecker) {
    return {
      version,
      pid: process.pid,
      latest: null,
      hasUpdate: false,
      releaseUrl: null,
      releasesUrl: "https://github.com/GavinYangAI/Comote/releases",
      downloadUrl: null,
      checkedAt: null,
    };
  }
  const result = state.versionChecker.getLastResult();
  return {
    version,
    pid: process.pid,
    latest: result.latest,
    hasUpdate: Boolean(result.hasUpdate),
    releaseUrl: result.releaseUrl,
    releasesUrl: result.releasesUrl,
    downloadUrl: result.downloadUrl,
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
  return header === apiToken || auth === `Bearer ${apiToken}`;
}
