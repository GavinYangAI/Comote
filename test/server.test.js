import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server/app.js";
import { createComoteState } from "../src/server/state.js";
import { setLocale as setI18nLocale } from "../src/core/i18n/index.js";

function createFakeState() {
  const identities = [];
  return {
    authorization: {
      listIdentities: () => identities.map((identity) => ({ ...identity })),
      confirmIdentity: (identity) => {
        const confirmed = { ...identity, role: identity.role ?? "operator" };
        identities.push(confirmed);
        return confirmed;
      },
    },
    projects: {
      listProjects: () => [],
    },
    sessions: {
      listSessions: () => [],
    },
    connectors: {
      desktop: {
        connected: false,
        getStatus() {
          return {
            name: "Codex Desktop",
            role: "primary",
            state: this.connected ? "connected" : "not_connected",
            protocol: "app-server",
          };
        },
        async initialize() {
          this.connected = true;
          return {
            userAgent: "codex-app-server-test",
            codexHome: "/home/test/.codex",
            platformFamily: "unix",
            platformOs: "macos",
          };
        },
        async listThreads({ cwd }) {
          return {
            data: [{ id: "thread_1", preview: "Test Thread", cwd }],
            nextCursor: null,
            backwardsCursor: null,
          };
        },
      },
      cli: {
        getStatus: () => ({
          name: "Codex CLI",
          role: "fallback",
          state: "available",
        }),
      },
    },
  };
}

// Creates a state backed by a mock desktop that returns a known project list.
function createStateWithProject(projectPath = process.cwd()) {
  const projectName = projectPath.split("/").filter(Boolean).at(-1) ?? projectPath;
  const desktop = {
    getStatus: () => ({ name: "Codex Desktop", role: "primary", state: "connected", protocol: "app-server" }),
    async listProjects() {
      return [{ name: projectName, path: projectPath, source: "codex-desktop", status: "available" }];
    },
    async listThreads({ cwd }) {
      return { data: [{ id: "thread_1", preview: "Test Thread", cwd }], nextCursor: null, backwardsCursor: null };
    },
  };
  return createComoteState({ desktop, autoStartWeChatRuntime: false, autoStartFeishuRuntime: false });
}

test("status API exposes Comote state", async () => {
  const app = createServer();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/status`);
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(body.appName, "Comote");
  assert.equal(body.connectors.desktop.role, "primary");
});

test("version API reports the running process id and version", async () => {
  const app = createServer();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/version`);
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(body.service, "comote");
  // The Tauri shell parses pid from this response to adopt an already-running
  // daemon (B3b PID adoption), so it must be a positive integer.
  assert.equal(typeof body.pid, "number");
  assert.ok(Number.isInteger(body.pid) && body.pid > 0);
  assert.equal(body.pid, process.pid);
  // version is present (may be null when unknown, but the key must exist).
  assert.ok("version" in body);
  // downloadUrl key must always be present (null when no checker is wired).
  assert.ok("downloadUrl" in body);
  assert.equal(body.downloadUrl, null);
});

test("version API surfaces the checker's downloadUrl", async () => {
  const state = {
    ...createFakeState(),
    currentVersion: "0.2.1",
    versionChecker: {
      getLastResult: () => ({
        latest: "0.3.0",
        hasUpdate: true,
        releaseUrl: "https://github.com/owner/repo/releases/tag/v0.3.0",
        downloadUrl: "https://github.com/owner/repo/releases/download/v0.3.0/comote.dmg",
        releaseNotes: "notes",
        checkedAt: "2026-06-04T00:00:00.000Z",
        error: null,
      }),
    },
  };
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/version`);
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(
    body.downloadUrl,
    "https://github.com/owner/repo/releases/download/v0.3.0/comote.dmg",
  );
});

test("serves svg assets with an image content type", async () => {
  const app = createServer();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/logo.svg`);
  const body = await response.text();
  server.close();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.match(body, /<svg/);
});

test("identity API confirms local authorization", async () => {
  const app = createServer();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/identities/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: "wechat",
      stableId: "wxid_owner",
      displayName: "Alice",
    }),
  });
  const listResponse = await fetch(`http://127.0.0.1:${port}/api/identities`);
  const identities = await listResponse.json();
  server.close();

  assert.equal(response.status, 201);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].stableId, "wxid_owner");
});

test("desktop connector API initializes and lists threads", async () => {
  const app = createServer(createFakeState());
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const initResponse = await fetch(
    `http://127.0.0.1:${port}/api/connectors/codex-desktop/initialize`,
    { method: "POST" },
  );
  const init = await initResponse.json();
  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
  const status = await statusResponse.json();
  const threadsResponse = await fetch(
    `http://127.0.0.1:${port}/api/codex/threads?cwd=${encodeURIComponent("/repo")}`,
  );
  const threads = await threadsResponse.json();
  server.close();

  assert.equal(initResponse.status, 200);
  assert.equal(init.platformOs, "macos");
  assert.equal(status.connectors.desktop.state, "connected");
  assert.deepEqual(threads, {
    data: [{ id: "thread_1", preview: "Test Thread", cwd: "/repo" }],
    nextCursor: null,
    backwardsCursor: null,
  });
});

test("threads API passes limit/cursor through and forwards nextCursor", async () => {
  const state = createFakeState();
  const calls = [];
  state.connectors.desktop.listThreads = async (options) => {
    calls.push(options);
    return {
      data: [{ id: "thread_2", preview: "Older", cwd: options.cwd }],
      nextCursor: "2026-07-13T13:12:06Z",
      backwardsCursor: "2026-07-13T06:22:32.803Z",
    };
  };
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const withCursor = await fetch(
    `http://127.0.0.1:${port}/api/codex/threads?cwd=${encodeURIComponent("/repo")}&limit=2&cursor=${encodeURIComponent("2026-07-13T13:49:16Z")}`,
  );
  const body = await withCursor.json();
  const withoutCursor = await fetch(
    `http://127.0.0.1:${port}/api/codex/threads?cwd=${encodeURIComponent("/repo")}`,
  );
  await withoutCursor.json();
  // Out-of-range limits are clamped, not passed through verbatim.
  await (await fetch(
    `http://127.0.0.1:${port}/api/codex/threads?cwd=${encodeURIComponent("/repo")}&limit=9999`,
  )).json();
  server.close();

  assert.equal(withCursor.status, 200);
  assert.deepEqual(calls[0], { cwd: "/repo", limit: 2, cursor: "2026-07-13T13:49:16Z" });
  // nextCursor/backwardsCursor are forwarded so the frontend can chain pages.
  assert.equal(body.nextCursor, "2026-07-13T13:12:06Z");
  assert.equal(body.backwardsCursor, "2026-07-13T06:22:32.803Z");
  assert.deepEqual(calls[1], { cwd: "/repo", limit: 20, cursor: null });
  assert.deepEqual(calls[2], { cwd: "/repo", limit: 100, cursor: null });
});

test("channel message API routes authorized phone commands", async () => {
  const app = createServer(createStateWithProject());
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const identity = {
    channel: "wechat",
    stableId: "wxid_owner",
    displayName: "Alice",
  };
  await fetch(`http://127.0.0.1:${port}/api/identities/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(identity),
  });
  // Refresh project list from mock desktop before using /open.
  await fetch(`http://127.0.0.1:${port}/api/projects`);
  await fetch(`http://127.0.0.1:${port}/api/channel/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, text: "/open 1" }),
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/channel/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, text: "/status" }),
  });
  const reply = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(reply.kind, "text");
  assert.ok(reply.text.includes(`项目：${process.cwd()}`));
});

test("wechat inbound API routes authorized WeChat payloads through adapter", async () => {
  const app = createServer(createStateWithProject("/home/test/projects/comote-fixture"));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  await fetch(`http://127.0.0.1:${port}/api/identities/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: "wechat",
      stableId: "wx_account_1:wxid_owner",
      displayName: "Alice",
    }),
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: "wx_account_1",
      peer: { id: "wxid_owner", name: "Alice" },
      conversation: { id: "dm_wxid_owner", type: "direct" },
      message: { id: "msg_1", text: "/projects" },
    }),
  });
  const reply = await response.json();
  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
  const status = await statusResponse.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(reply.kind, "text");
  assert.match(reply.text, /1\. comote-fixture/);
  assert.equal(status.channels.wechat, "adapter_ready");
});

test("wechat inbound API records unconfirmed users as local confirmation candidates", async () => {
  const app = createServer();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const inboundResponse = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: "wx_account_1",
      peer: { id: "wxid_unknown", name: "Unknown" },
      conversation: { id: "dm_wxid_unknown", type: "direct" },
      message: { id: "msg_1", text: "/status" },
    }),
  });
  const inbound = await inboundResponse.json();
  const candidatesResponse = await fetch(`http://127.0.0.1:${port}/api/identities/candidates`);
  const candidates = await candidatesResponse.json();
  server.close();

  // First message from an unconfirmed identity returns a one-time guidance notice.
  assert.equal(inbound.kind, "notice");
  assert.deepEqual(candidates, [
    {
      channel: "wechat",
      stableId: "wx_account_1:wxid_unknown",
      displayName: "Unknown",
      role: "operator",
    },
  ]);
});

test("approval APIs expose and resolve pending Codex approvals", async () => {
  const fakeDesktop = {
    approvals: [
      {
        id: "approval_1",
        method: "item/commandExecution/requestApproval",
        params: { command: "npm test", cwd: "/repo" },
      },
    ],
    getStatus: () => ({ name: "Codex Desktop", role: "primary", state: "connected", protocol: "app-server" }),
    listPendingApprovals() {
      return this.approvals;
    },
    async resolveApproval(id, decision) {
      this.approvals = this.approvals.filter((approval) => approval.id !== id);
      return { id, decision };
    },
  };
  const state = createFakeState();
  state.connectors.desktop = fakeDesktop;
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const listResponse = await fetch(`http://127.0.0.1:${port}/api/approvals`);
  const approvals = await listResponse.json();
  const resolveResponse = await fetch(`http://127.0.0.1:${port}/api/approvals/approval_1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "accept" }),
  });
  const resolved = await resolveResponse.json();
  server.close();

  assert.deepEqual(approvals, [
    {
      id: "approval_1",
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test", cwd: "/repo" },
    },
  ]);
  assert.deepEqual(resolved, { id: "approval_1", decision: "accept" });
});

test("approval API accepts session decisions and rejects unsupported values", async () => {
  const decisions = [];
  const state = createFakeState();
  state.connectors.desktop = {
    ...state.connectors.desktop,
    async resolveApproval(id, decision) {
      decisions.push([id, decision]);
      return { id, decision };
    },
  };
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const accepted = await fetch(`http://127.0.0.1:${port}/api/approvals/a1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "acceptForSession" }),
  });
  const rejected = await fetch(`http://127.0.0.1:${port}/api/approvals/a2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "anything" }),
  });
  server.close();

  assert.equal(accepted.status, 200);
  assert.equal(rejected.status, 400);
  assert.deepEqual(decisions, [["a1", "acceptForSession"]]);
});

test("readJsonBody rejects oversized request bodies with a non-500 error response", async () => {
  const app = createServer();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  // 1 MiB + 1 byte should exceed the cap and produce an error.
  const oversized = Buffer.alloc(1024 * 1024 + 1, "x");
  const response = await fetch(`http://127.0.0.1:${port}/api/channel/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversized,
  });
  server.close();

  // The top-level try/catch in createServer maps thrown errors to 500 JSON
  // responses — "non-500" is not the goal; the goal is a clean JSON response
  // rather than a torn connection.
  assert.ok(
    response.status >= 400 && response.status < 600,
    `expected 4xx or 5xx, got ${response.status}`,
  );
  const body = await response.json();
  assert.ok(body.error, "expected an error field in the JSON response");
  assert.match(body.error, /too large/i);
});

test("serveStatic returns 404 for a missing static file", async () => {
  const app = createServer();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/this-file-does-not-exist.js`);
  server.close();

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error, "not found");
});

test("GET /api/settings returns locale and supported list", async () => {
  const state = createComoteState({
    persisted: { settings: { locale: "en" } },
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
  });
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/settings`);
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(body.locale, "en");
  assert.equal(body.localeExplicit, true, "a persisted locale is an explicit choice");
  assert.equal(body.preferredConnector, "desktop");
  assert.ok(body.supported.includes("ja"));

  // i18n locale is a module-level global; reset so other test files aren't polluted.
  setI18nLocale("zh");
});

test("GET /api/settings reports localeExplicit=false on first launch (no persisted locale)", async () => {
  const state = createComoteState({
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
  });
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const body = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
  server.close();

  assert.equal(body.localeExplicit, false, "first launch is not an explicit choice → frontend follows the OS language");
  setI18nLocale("zh");
});

test("PUT /api/settings sets a valid locale and rejects an invalid one", async () => {
  const state = createComoteState({
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
  });
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const validResponse = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale: "fr" }),
  });
  const valid = await validResponse.json();

  const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale: "xx" }),
  });
  server.close();

  assert.equal(validResponse.status, 200);
  assert.equal(valid.locale, "fr");
  assert.equal(state.getSettings().locale, "fr");
  assert.equal(invalidResponse.status, 400);

  // i18n locale is a module-level global; reset so other test files aren't polluted.
  setI18nLocale("zh");
});

test("PUT /api/settings persists a valid connector preference and rejects an invalid one", async () => {
  let snapshot = null;
  const state = createComoteState({
    stateStore: { save: async (value) => { snapshot = value; } },
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
    autoStartDingTalkRuntime: false,
    autoStartTelegramRuntime: false,
  });
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const validResponse = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preferredConnector: "cli" }),
  });
  const valid = await validResponse.json();
  const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preferredConnector: "other" }),
  });
  server.close();

  assert.equal(validResponse.status, 200);
  assert.equal(valid.preferredConnector, "cli");
  assert.equal(state.getSettings().preferredConnector, "cli");
  assert.equal(snapshot.settings.preferredConnector, "cli");
  assert.equal(invalidResponse.status, 400);
  assert.equal(state.getSettings().preferredConnector, "cli");
});

test("wechat outbound queue lists replies and supports ack", async () => {
  const app = createServer(createStateWithProject("/home/test/projects/comote-fixture"));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  const identity = { channel: "wechat", stableId: "wx_account_1:wxid_owner", displayName: "Alice" };
  await fetch(`http://127.0.0.1:${port}/api/identities/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(identity),
  });
  await fetch(`http://127.0.0.1:${port}/api/channels/wechat/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: "wx_account_1",
      peer: { id: "wxid_owner", name: "Alice" },
      conversation: { id: "dm_wxid_owner", type: "direct" },
      message: { id: "msg_1", text: "/projects" },
    }),
  });
  const outboundResponse = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/outbound`);
  const outbound = await outboundResponse.json();
  const ackResponse = await fetch(
    `http://127.0.0.1:${port}/api/channels/wechat/outbound/${encodeURIComponent(outbound[0].id)}/ack`,
    { method: "POST" },
  );
  const afterAckResponse = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/outbound`);
  const afterAck = await afterAckResponse.json();
  server.close();

  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].channel, "wechat");
  assert.match(outbound[0].text, /comote-fixture/);
  assert.equal(ackResponse.status, 204);
  assert.deepEqual(afterAck, []);
});

// ---------------------------------------------------------------------------
// E-4: /api/codex/transcript falls back to the connector's thread history
// (thread/read via listRecentMessages) when the local transcript is empty.
// ---------------------------------------------------------------------------

async function fetchTranscript(state, query) {
  const app = createServer(state);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/codex/transcript?${query}`);
  const body = await response.json();
  server.close();
  return { response, body };
}

test("transcript API falls back to the connector's thread history when local is empty", async () => {
  const state = createFakeState();
  const calls = [];
  state.transcript = {
    listThread: (threadId) => ({ threadId, messages: [], total: 0, hasMore: false }),
  };
  state.connectors.desktop.listRecentMessages = async ({ threadId, limit }) => {
    calls.push({ threadId, limit });
    // The connector's real shape: oldest→newest, plus diagnostic underscore
    // fields the API must not leak through.
    return {
      messages: [
        { role: "user", text: "continue from Feishu" },
        { role: "assistant", text: "done" },
      ],
      _rawSample: { id: "turn_1" },
      _turnCount: 1,
    };
  };

  const { response, body } = await fetchTranscript(state, "threadId=thread_9&limit=7");

  assert.equal(response.status, 200);
  // Same shape as the local transcript endpoint (newest-first messages), with
  // source labeling the origin for the frontend.
  assert.deepEqual(body, {
    threadId: "thread_9",
    messages: [
      { role: "assistant", text: "done" },
      { role: "user", text: "continue from Feishu" },
    ],
    total: 2,
    hasMore: false,
    source: "desktop",
  });
  // review-2: the fallback fetches the WHOLE history once (thread/read walks
  // every turn regardless) so total/offset/hasMore describe the real thread.
  assert.deepEqual(calls, [{ threadId: "thread_9", limit: 1000 }]);
});

test("review-2: desktop transcript fallback pages with offset and real total", async () => {
  const state = createFakeState();
  state.transcript = {
    listThread: (threadId, { offset = 0 } = {}) => ({ threadId, messages: [], total: 0, hasMore: false, offset }),
  };
  // 5 messages oldest→newest: m1..m5
  state.connectors.desktop.listRecentMessages = async () => ({
    messages: [1, 2, 3, 4, 5].map((n) => ({ role: "assistant", text: `m${n}` })),
  });

  const first = await fetchTranscript(state, "threadId=t&limit=2&offset=0");
  assert.deepEqual(first.body.messages.map((m) => m.text), ["m5", "m4"], "newest first");
  assert.equal(first.body.total, 5);
  assert.equal(first.body.hasMore, true);

  const second = await fetchTranscript(state, "threadId=t&limit=2&offset=2");
  assert.deepEqual(second.body.messages.map((m) => m.text), ["m3", "m2"]);
  assert.equal(second.body.hasMore, true);

  const last = await fetchTranscript(state, "threadId=t&limit=2&offset=4");
  assert.deepEqual(last.body.messages.map((m) => m.text), ["m1"]);
  assert.equal(last.body.hasMore, false);
});

test("review-3: a thread past the 1000-message window keeps reporting a growing total", async () => {
  const state = createFakeState();
  state.transcript = {
    listThread: (threadId) => ({ threadId, messages: [], total: 0, hasMore: false }),
  };
  // The real connector slices its window to the requested limit but reports the
  // UNTRUNCATED total — mirror that: 1002 messages, window carries newest 1000.
  let threadSize = 1002;
  state.connectors.desktop.listRecentMessages = async ({ limit }) => {
    const all = Array.from({ length: threadSize }, (_, i) => ({ role: "assistant", text: `m${i + 1}` }));
    return { messages: all.slice(-limit), total: threadSize };
  };

  const first = await fetchTranscript(state, "threadId=t&limit=20&offset=0");
  assert.equal(first.body.total, 1002, "total is untruncated past the window cap");
  assert.equal(first.body.messages[0].text, "m1002", "newest message first");

  // Two more messages arrive: the frontend detects them by the total delta.
  threadSize = 1004;
  const second = await fetchTranscript(state, "threadId=t&limit=20&offset=0");
  assert.equal(second.body.total, 1004, "total keeps growing after saturation");
  assert.equal(second.body.messages[0].text, "m1004");

  // Paging stays bounded by the window: the last in-window page reports no more.
  const tail = await fetchTranscript(state, "threadId=t&limit=20&offset=980");
  assert.equal(tail.body.messages.length, 20);
  assert.equal(tail.body.hasMore, false, "hasMore is window-bounded, not total-bounded");
});

test("review-2: a paged-past-the-end LOCAL transcript never switches source mid-scroll", async () => {
  const state = createFakeState();
  let desktopCalled = false;
  state.transcript = {
    // total > 0 but the requested page is empty (offset beyond end).
    listThread: (threadId) => ({ threadId, messages: [], total: 3, hasMore: false }),
  };
  state.connectors.desktop.listRecentMessages = async () => {
    desktopCalled = true;
    return { messages: [{ role: "assistant", text: "desktop" }] };
  };

  const { body } = await fetchTranscript(state, "threadId=t&limit=20&offset=40");
  assert.equal(desktopCalled, false, "local total>0 must stay local");
  assert.equal(body.source, "local");
});

test("transcript API serves the local transcript when it has messages", async () => {
  const state = createFakeState();
  let desktopCalled = false;
  state.transcript = {
    listThread: (threadId) => ({
      threadId,
      messages: [{ role: "user", text: "hi", at: "2026-07-13T00:00:00.000Z" }],
      total: 1,
      hasMore: false,
    }),
  };
  state.connectors.desktop.listRecentMessages = async () => {
    desktopCalled = true;
    return { messages: [] };
  };

  const { response, body } = await fetchTranscript(state, "threadId=thread_9");

  assert.equal(response.status, 200);
  assert.equal(body.source, "local");
  assert.equal(body.messages.length, 1);
  assert.equal(desktopCalled, false, "no connector round-trip when local has the record");
});

test("transcript API degrades to the empty local result when the connector read fails", async () => {
  const state = createFakeState();
  state.connectors.desktop.listRecentMessages = async () => {
    throw new Error("Codex app-server 请求超时：thread/read");
  };

  const { response, body } = await fetchTranscript(state, "threadId=thread_9");

  // Not connected / RPC failure must never become a 500 — the panel shows the
  // (empty) local record instead.
  assert.equal(response.status, 200);
  assert.deepEqual(body, { threadId: "thread_9", messages: [], total: 0, hasMore: false, source: "local" });
});

test("transcript API returns empty local result when the connector has no record either", async () => {
  const state = createFakeState();
  state.connectors.desktop.listRecentMessages = async () => ({ messages: [], _rawSample: null, _turnCount: 0 });

  const { response, body } = await fetchTranscript(state, "threadId=thread_9");

  assert.equal(response.status, 200);
  assert.deepEqual(body, { threadId: "thread_9", messages: [], total: 0, hasMore: false, source: "local" });
});
