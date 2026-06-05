import test from "node:test";
import assert from "node:assert/strict";

import { createComoteState } from "../src/server/state.js";
import wechatPlugin from "../src/channels/wechat/index.js";
import { DingTalkDriver } from "../src/channels/dingtalk/driver.js";

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
