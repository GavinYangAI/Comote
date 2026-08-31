import test from "node:test";
import assert from "node:assert/strict";

import { createComoteState } from "../src/server/state.js";
import wechatPlugin from "../src/channels/wechat/index.js";
import { DingTalkDriver } from "../src/channels/dingtalk/driver.js";
import { FeishuDriver } from "../src/channels/feishu/driver.js";

test("restart keeps project chat and global manager on independent Feishu apps", async () => {
  let saved = null;
  const state = createComoteState({
    autoStartFeishuRuntime: false,
    stateStore: {
      async save(snapshot) { saved = snapshot; },
      async flush() {},
    },
    persisted: {
      channelConfigs: {
        feishu: {
          enabled: true,
          appId: "cli_project_chat",
          appSecret: "secret_project_chat",
          domain: "feishu",
        },
        "feishu-global-manager": {
          enabled: true,
          appId: "cli_global_manager",
          appSecret: "secret_global_manager",
          domain: "feishu",
        },
      },
      globalManager: {
        enabled: true,
        channelId: "feishu-global-manager",
        appId: "cli_global_manager",
        managerOpenId: "ou_global_manager",
      },
    },
  });

  assert.equal(state.runtime.feishu.getConfig().appId, "cli_project_chat");
  assert.equal(
    state.runtime["feishu-global-manager"].getConfig().appId,
    "cli_global_manager",
  );
  assert.notEqual(state.runtime.feishu, state.runtime["feishu-global-manager"]);
  assert.equal(state.globalManager.publicSnapshot().configuredAppId, "cli_global_manager");
  assert.equal(state.globalManager.publicSnapshot().channelId, "feishu-global-manager");
  await state.persist();
  assert.equal(saved.channelConfigs.feishu.appId, "cli_project_chat");
  assert.equal(saved.channelConfigs["feishu-global-manager"].appId, "cli_global_manager");
  await state.shutdown();
});

test("global-manager QR login replaces only the manager Feishu app", async (t) => {
  const originalStartEventStream = FeishuDriver.prototype.startEventStream;
  FeishuDriver.prototype.startEventStream = async () => ({ ok: true });
  t.after(() => {
    FeishuDriver.prototype.startEventStream = originalStartEventStream;
  });

  const state = createComoteState({
    autoStartFeishuRuntime: false,
    persisted: {
      channelConfigs: {
        feishu: {
          enabled: true,
          appId: "cli_project_chat",
          appSecret: "secret_project_chat",
          domain: "feishu",
        },
        "feishu-global-manager": {
          enabled: true,
          appId: "cli_manager_old",
          appSecret: "secret_manager_old",
          domain: "feishu",
        },
      },
    },
    feishuLoginDriverFactory: () => ({
      startLogin: async () => ({ loginId: "manager_login", domain: "feishu" }),
      getLoginStatus: async () => ({
        state: "confirmed",
        appId: "cli_manager_new",
        appSecret: "secret_manager_new",
        domain: "feishu",
      }),
    }),
  });

  const managerRuntime = state.runtime["feishu-global-manager"];
  await managerRuntime.startLogin({ domain: "feishu" });
  const result = await managerRuntime.getLoginStatus({ loginId: "manager_login" });

  assert.equal(result.state, "confirmed");
  assert.equal(result.requiresManagerBind, true);
  assert.equal(managerRuntime.getConfig().appId, "cli_manager_new");
  assert.equal(state.runtime.feishu.getConfig().appId, "cli_project_chat");
  await state.shutdown();
});

test("project and global-manager Feishu event streams reply through only their own apps", async () => {
  const handlers = {};
  const sent = { feishu: [], "feishu-global-manager": [] };
  const makeDriver = (channel) => ({
    verifyEvent: () => true,
    getStatus: () => ({ state: "configured" }),
    startEventStream: async (nextHandlers) => {
      handlers[channel] = nextHandlers;
      return { ok: true };
    },
    stopEventStream() {},
    async sendCard(args) {
      sent[channel].push(args);
      return { messageId: `${channel}-message-${sent[channel].length}` };
    },
  });
  const projectIdentity = {
    channel: "feishu",
    stableId: "ou_project_user",
    displayName: "Project user",
  };
  const state = createComoteState({
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
    autoStartDingTalkRuntime: false,
    autoStartTelegramRuntime: false,
    autoStartTaskMonitor: false,
    persisted: {
      identities: [projectIdentity],
      channelConfigs: {
        feishu: {
          enabled: true,
          appId: "cli_project_chat",
          appSecret: "secret_project_chat",
        },
        "feishu-global-manager": {
          enabled: true,
          appId: "cli_global_manager",
          appSecret: "secret_global_manager",
        },
      },
    },
    scanLocalProjects: () => [
      { name: "Comote", path: "D:\\work\\Comote", source: "local-scan", status: "available" },
    ],
  });

  state.runtime.feishu.__setTestDriver(makeDriver("feishu"));
  state.runtime["feishu-global-manager"].__setTestDriver(makeDriver("feishu-global-manager"));
  await state.runtime.feishu.start();
  await state.runtime["feishu-global-manager"].start();

  await handlers.feishu.onEvent({
    header: { event_id: "project-event-1" },
    event: {
      sender: { sender_id: { open_id: projectIdentity.stableId } },
      message: {
        message_id: "project-message-1",
        chat_id: "project-chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/projects" }),
      },
    },
  });

  assert.equal(sent.feishu.length, 1, "the project app must answer /projects");
  assert.equal(sent.feishu[0].receiveId, "project-chat");
  assert.match(JSON.stringify(sent.feishu[0].card), /Comote/);
  assert.equal(sent["feishu-global-manager"].length, 0, "the manager app must not steal project replies");

  await handlers.feishu.onAction({
    event: {
      operator: { open_id: projectIdentity.stableId },
      action: { value: { kind: "global_manager_bind" } },
    },
  });
  assert.equal(state.globalManager.publicSnapshot().status, "unbound", "a project-app card action cannot bind global management");

  await handlers["feishu-global-manager"].onEvent({
    header: { event_id: "manager-event-1" },
    event: {
      sender: { sender_id: { open_id: "ou_manager_user" } },
      message: {
        message_id: "manager-message-1",
        chat_id: "manager-chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "你好" }),
      },
    },
  });

  assert.equal(sent.feishu.length, 1, "the project app must not send manager replies");
  assert.equal(sent["feishu-global-manager"].length, 1, "the manager app must send its bind card");
  assert.equal(sent["feishu-global-manager"][0].receiveId, "manager-chat");
  assert.match(JSON.stringify(sent["feishu-global-manager"][0].card), /global_manager_bind/);

  const bindResult = await handlers["feishu-global-manager"].onAction({
    event: {
      operator: { open_id: "ou_manager_user" },
      open_chat_id: "manager-chat",
      open_message_id: "manager-message-1",
      action: { value: { kind: "global_manager_bind" } },
    },
  });
  assert.equal(bindResult.toast.type, "success");
  assert.equal(state.globalManager.publicSnapshot().status, "ready");
  assert.equal(state.globalManager.publicSnapshot().manager.stableId, "ou_manager_user");
  assert.equal(sent.feishu.length, 1, "binding must not use the project app");
  assert.equal(sent["feishu-global-manager"].length, 2, "binding sends the manager dashboard through the manager app");
  assert.deepEqual(
    state.authorization.listDetectedIdentities().map((identity) => identity.channel),
    [],
    "manager identities must stay out of project authorization",
  );
  await state.shutdown();
});

test("rejects a Feishu login id that was not started by the current process", async () => {
  let statusCalls = 0;
  const state = createComoteState({
    autoStartFeishuRuntime: false,
    feishuLoginDriverFactory: () => ({
      startLogin: async () => ({ loginId: "current_login", domain: "feishu" }),
      getLoginStatus: async () => {
        statusCalls += 1;
        return {
          state: "confirmed",
          appId: "cli_stale",
          appSecret: "secret_stale",
          userId: "ou_stale",
          domain: "feishu",
        };
      },
    }),
  });

  const result = await state.runtime.feishu.getLoginStatus({ loginId: "stale_login" });

  assert.equal(result.state, "expired");
  assert.equal(statusCalls, 0);
  assert.equal(state.runtime.feishu.getConfig().linkedUserId, null);
  await state.shutdown();
});

test("a confirmed Feishu login id can update binding only once", async (t) => {
  const originalResolveUserName = FeishuDriver.prototype.resolveUserName;
  const originalStartEventStream = FeishuDriver.prototype.startEventStream;
  FeishuDriver.prototype.resolveUserName = async () => "Current user";
  FeishuDriver.prototype.startEventStream = async () => ({ ok: true });
  t.after(() => {
    FeishuDriver.prototype.resolveUserName = originalResolveUserName;
    FeishuDriver.prototype.startEventStream = originalStartEventStream;
  });

  let statusCalls = 0;
  const loginDriver = {
    startLogin: async () => ({ loginId: "current_login", domain: "feishu" }),
    getLoginStatus: async () => {
      statusCalls += 1;
      return {
        state: "confirmed",
        appId: "cli_current",
        appSecret: "secret_current",
        userId: "ou_current",
        domain: "feishu",
      };
    },
  };
  const state = createComoteState({
    autoStartFeishuRuntime: false,
    feishuLoginDriverFactory: () => loginDriver,
  });

  await state.runtime.feishu.startLogin({ domain: "feishu" });
  const confirmed = await state.runtime.feishu.getLoginStatus({ loginId: "current_login" });
  const repeated = await state.runtime.feishu.getLoginStatus({ loginId: "current_login" });

  assert.equal(confirmed.state, "confirmed");
  assert.equal(repeated.state, "expired");
  assert.equal(statusCalls, 1);
  assert.equal(state.runtime.feishu.getConfig().linkedUserId, null);
  assert.equal(state.runtime.feishu.getConfig().linkedUserAppId, null);
  await state.shutdown();
});

test("starting a new Feishu login invalidates an older in-flight result", async (t) => {
  const originalResolveUserName = FeishuDriver.prototype.resolveUserName;
  const originalStartEventStream = FeishuDriver.prototype.startEventStream;
  FeishuDriver.prototype.resolveUserName = async () => "New user";
  FeishuDriver.prototype.startEventStream = async () => ({ ok: true });
  t.after(() => {
    FeishuDriver.prototype.resolveUserName = originalResolveUserName;
    FeishuDriver.prototype.startEventStream = originalStartEventStream;
  });

  let loginCounter = 0;
  let releaseOldStatus;
  const oldStatusGate = new Promise((resolve) => { releaseOldStatus = resolve; });
  const state = createComoteState({
    autoStartFeishuRuntime: false,
    feishuLoginDriverFactory: () => ({
      startLogin: async () => {
        loginCounter += 1;
        return { loginId: `login_${loginCounter}`, domain: "feishu" };
      },
      getLoginStatus: async ({ loginId }) => {
        if (loginId === "login_1") {
          await oldStatusGate;
          return {
            state: "confirmed",
            appId: "cli_old",
            appSecret: "secret_old",
            userId: "ou_old",
            domain: "feishu",
          };
        }
        return {
          state: "confirmed",
          appId: "cli_new",
          appSecret: "secret_new",
          userId: "ou_new",
          domain: "feishu",
        };
      },
    }),
  });

  await state.runtime.feishu.startLogin({ domain: "feishu" });
  const oldStatus = state.runtime.feishu.getLoginStatus({ loginId: "login_1" });
  await state.runtime.feishu.startLogin({ domain: "feishu" });
  releaseOldStatus();

  assert.equal((await oldStatus).state, "expired");
  assert.equal(state.runtime.feishu.getConfig().linkedUserId, null);
  assert.equal((await state.runtime.feishu.getLoginStatus({ loginId: "login_2" })).state, "confirmed");
  assert.equal(state.runtime.feishu.getConfig().linkedUserId, null);
  assert.equal(state.runtime.feishu.getConfig().linkedUserAppId, null);
  await state.shutdown();
});

test("changing Feishu app credentials clears the previous app-scoped user binding", async () => {
  const state = createComoteState({
    autoStartFeishuRuntime: false,
    persisted: {
      channelConfigs: {
        feishu: {
          enabled: true,
          appId: "cli_old",
          appSecret: "secret_old",
          linkedUserId: "ou_old",
          linkedUserName: "Old user",
          linkedUserAppId: "cli_old",
          linkedUserSource: "inbound",
        },
      },
    },
  });

  const updated = await state.runtime.feishu.configure({
    appId: "cli_new",
    appSecret: "secret_new",
  });

  assert.equal(updated.appId, "cli_new");
  assert.equal(updated.linkedUserId, null);
  assert.equal(updated.linkedUserName, null);
  assert.equal(updated.linkedUserAppId, null);
  await state.shutdown();
});

test("updating non-credential Feishu settings preserves the scoped user binding", async () => {
  const state = createComoteState({
    autoStartFeishuRuntime: false,
    persisted: {
      channelConfigs: {
        feishu: {
          enabled: true,
          appId: "cli_same",
          appSecret: "secret_same",
          linkedUserId: "ou_same",
          linkedUserName: "Same user",
          linkedUserAppId: "cli_same",
          linkedUserSource: "inbound",
        },
      },
    },
  });

  const updated = await state.runtime.feishu.configure({ verificationToken: "verify" });

  assert.equal(updated.linkedUserId, "ou_same");
  assert.equal(updated.linkedUserAppId, "cli_same");
  await state.shutdown();
});

test("stores WeChat login results when token and account id are present", () => {
  assert.equal(
    wechatPlugin.shouldStoreLoginResult({
      state: "success",
      accountId: "wx_account_1",
      token: "bot_token_1",
    }),
    true,
  );
  assert.equal(
    wechatPlugin.shouldStoreLoginResult({
      state: "wait",
      accountId: "wx_account_1",
      token: "bot_token_1",
    }),
    true,
  );
  assert.equal(
    wechatPlugin.shouldStoreLoginResult({
      state: "wait",
      accountId: null,
      token: null,
    }),
    false,
  );
  assert.equal(
    wechatPlugin.shouldStoreLoginResult({
      state: "expired",
      accountId: "wx_account_1",
      token: "bot_token_1",
    }),
    false,
  );
});

test("auto-starts WeChat runtime when a saved login token exists", async () => {
  const state = createComoteState({
    autoStartDelayMs: 0,
    persisted: {
      channelConfigs: {
        wechat: {
          enabled: true,
          baseUrl: "https://wechat.example",
          accountId: "wx_account_1",
          token: "bot_token_1",
          linkedUserId: "wx_user_1",
        },
      },
    },
  });

  await waitFor(() => state.runtime.wechat.getStatus().state === "running");
  assert.equal(state.runtime.wechat.getStatus().state, "running");
  state.runtime.wechat.stop();
});

test("wechat getLoginStatus normalizes + starts runtime on confirm", async () => {
  const state = createComoteState({
    autoStartWeChatRuntime: false,
    persisted: {
      channelConfigs: {
        wechat: { enabled: true, accountId: "default" },
      },
    },
  });
  // Inject a fake wechat driver whose getLoginStatus returns a confirmed raw
  // login result. The real WeChatIlinkDriver requires a network host; this seam
  // lets the closure run its store + configureDriver + persist + start path.
  state.runtime.wechat.__setTestDriver({
    getStatus: () => ({ accountId: "acc1" }),
    getLoginStatus: async () => ({
      token: "t1",
      accountId: "acc1",
      userId: "u1",
      userName: "Neo",
      baseUrl: "https://x",
    }),
    fetchUpdates: async () => ({ updates: [] }),
  });
  const result = await state.runtime.wechat.getLoginStatus({ loginId: "L" });
  assert.equal(result.state, "confirmed"); // normalized field present
  assert.equal(result.token, "t1"); // raw field preserved (back-compat)
  assert.equal(result.account.id, "acc1"); // normalized account
  assert.equal(state.runtime.wechat.getStatus().state, "running"); // backend started it
  state.runtime.wechat.stop(); // clear the poll timer so the test exits cleanly
});

test("can keep WeChat runtime stopped for tests and diagnostics", () => {
  const state = createComoteState({
    autoStartWeChatRuntime: false,
    persisted: {
      channelConfigs: {
        wechat: {
          enabled: true,
          baseUrl: "https://wechat.example",
          accountId: "wx_account_1",
          token: "bot_token_1",
          linkedUserId: "wx_user_1",
        },
      },
    },
  });

  assert.equal(state.runtime.wechat.getStatus().state, "configured");
});

// Finding #9 (abstraction): state.js wires each adapter's media support from the
// plugin's EXPLICIT capabilities.media bit (single source of truth), not from
// whether a downloadAttachment closure was passed. wechat declares media=0, so
// its adapter must take the unsupported-attachment path for a pure image.
test("the wechat adapter is wired with capabilities.media=0 and rejects a pure image", async () => {
  const sent = [];
  const state = createComoteState({
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
    autoStartDingTalkRuntime: false,
    autoStartTelegramRuntime: false,
    persisted: {},
  });
  // The adapter enqueues its reply through the shared outbound queue; intercept
  // it so we can assert the unsupported reply without standing up a runtime.
  const wechatAdapter = state.channels.wechat;
  wechatAdapter.sendReply = async (r) => { sent.push(r); return { ok: true }; };
  const out = await wechatAdapter.handleInbound({
    accountId: "default",
    peer: { id: "u1", name: "U1" },
    message: { id: "m1", text: "", attachments: [{ type: "image", name: "pic.png" }] },
  });
  assert.equal(out.kind, "ignored", "pure image on a media=0 channel is not submitted");
  assert.ok(sent.some((r) => (r.text ?? "").length > 0), "expected an unsupported-channel reply");
});

// Polls until a condition holds. Auto-start and the live-card open are
// fire-and-forget, so a fixed timeout races on slow/CI machines. Waiting on the
// actual post-condition makes the test deterministic.
async function waitFor(predicate, { timeout = 5000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start >= timeout) throw new Error("waitFor: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

test("routeDesktopEvent drives a dingtalk live status card", async (t) => {
  // De-flake: configure() builds a REAL DingTalkDriver and start()s it, whose
  // startEventStream late-imports dingtalk-stream and opens a live socket. Patch
  // it to a clean no-op so configure() touches no network. We then swap in a fake
  // driver (after configure) that records createCard/updateCard.
  const original = DingTalkDriver.prototype.startEventStream;
  DingTalkDriver.prototype.startEventStream = async function startEventStream() {
    return { ok: true };
  };
  t.after(() => {
    DingTalkDriver.prototype.startEventStream = original;
  });

  const events = [];
  const desktop = { onEvent: null, async listProjects() { return []; } };
  const state = createComoteState({ desktop, stateStore: null, persisted: {} });

  // Configure dingtalk with a status template so live cards are enabled. configure()
  // runs the real (patched) driver's start(); the channel is running afterwards.
  await state.runtime.dingtalk.configure({
    enabled: true,
    appKey: "ak",
    appSecret: "as",
    statusTemplateId: "st.schema",
  });

  // Swap in a fake driver that records card calls. configureDriver restarts the
  // (already-running) push runtime through this fake's startEventStream — no socket.
  state.runtime.dingtalk.__setTestDriver({
    startEventStream: async () => ({ ok: true }),
    stopEventStream() {},
    getStatus: () => ({ state: "configured" }),
    async createCard(a) { events.push(["create", a]); return { outTrackId: a.outTrackId }; },
    async updateCard(a) { events.push(["update", a]); },
  });

  // Bind a thread to dingtalk. getThreadBinding(threadId) reads threadBindings, the
  // same map bindThreadForIdentity writes — there is no public bindThread, so seed
  // the binding directly (the read source) to set up the precondition.
  state.commandRouter.threadBindings.set("thread-1", {
    channel: "dingtalk",
    conversationId: "staff-9",
    projectPath: null,
  });

  // turnStarted on a dingtalk-bound thread must open a live status card.
  desktop.onEvent({ type: "turnStarted", threadId: "thread-1" });
  await waitFor(() => events.some((e) => e[0] === "create"));

  assert.ok(
    events.some((e) => e[0] === "create"),
    "a dingtalk status card was created on turnStarted",
  );

  state.runtime.dingtalk.stop();
});

const NO_AUTOSTART = {
  autoStartWeChatRuntime: false,
  autoStartFeishuRuntime: false,
  autoStartDingTalkRuntime: false,
  autoStartTelegramRuntime: false,
};

test("discoverProjects falls back to a local scan when desktop has no projects", async () => {
  const desktop = { onEvent: null, async listProjects() { return []; } };
  const scanned = [
    { name: "repo", path: "/work/repo", source: "local-scan", status: "available" },
  ];
  const state = createComoteState({
    ...NO_AUTOSTART,
    desktop,
    stateStore: null,
    persisted: {},
    scanLocalProjects: () => scanned,
  });

  const list = await state.discoverProjects();

  assert.deepEqual(list.map((p) => p.path), ["/work/repo"]);
});

test("discoverProjects prefers desktop projects over the local scan", async () => {
  const desktop = {
    onEvent: null,
    async listProjects() {
      return [{ name: "d", path: "/d", source: "codex-desktop", status: "available" }];
    },
  };
  const state = createComoteState({
    ...NO_AUTOSTART,
    desktop,
    stateStore: null,
    persisted: {},
    scanLocalProjects: () => [{ name: "s", path: "/s", source: "local-scan", status: "available" }],
  });

  const list = await state.discoverProjects();

  assert.deepEqual(list.map((p) => p.path), ["/d"]);
});

test("discoverProjects clears stale projects when reachable desktop reports none and scan is empty", async () => {
  const desktop = { onEvent: null, async listProjects() { return []; } };
  const state = createComoteState({
    ...NO_AUTOSTART,
    desktop,
    stateStore: null,
    persisted: {},
    scanLocalProjects: () => [],
  });

  // Seed a stale project, then a reachable desktop says there are none.
  state.projects.replaceProjects([
    { name: "stale", path: "/stale", source: "codex-desktop", status: "available" },
  ]);
  const list = await state.discoverProjects();

  assert.deepEqual(list, []);
});

test("discoverProjects keeps the last known list when desktop is offline and scan is empty", async () => {
  const desktop = {
    onEvent: null,
    async listProjects() { throw new Error("offline"); },
  };
  const state = createComoteState({
    ...NO_AUTOSTART,
    desktop,
    stateStore: null,
    persisted: {},
    scanLocalProjects: () => [],
  });

  state.projects.replaceProjects([
    { name: "known", path: "/known", source: "codex-desktop", status: "available" },
  ]);
  const list = await state.discoverProjects();

  assert.deepEqual(list.map((p) => p.path), ["/known"]);
});
