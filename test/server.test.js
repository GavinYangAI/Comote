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
