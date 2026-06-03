import test from "node:test";
import assert from "node:assert/strict";

import { createComoteState } from "../src/server/state.js";
import wechatPlugin from "../src/channels/wechat/index.js";

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

test("auto-starts WeChat runtime when a saved login token exists", () => {
  const state = createComoteState({
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
