import test from "node:test";
import assert from "node:assert/strict";

import { createComoteState, shouldStoreWeChatLoginResult } from "../src/server/state.js";

test("stores WeChat login results when token and account id are present", () => {
  assert.equal(
    shouldStoreWeChatLoginResult({
      state: "success",
      accountId: "wx_account_1",
      token: "bot_token_1",
    }),
    true,
  );
  assert.equal(
    shouldStoreWeChatLoginResult({
      state: "wait",
      accountId: "wx_account_1",
      token: "bot_token_1",
    }),
    true,
  );
  assert.equal(
    shouldStoreWeChatLoginResult({
      state: "wait",
      accountId: null,
      token: null,
    }),
    false,
  );
  assert.equal(
    shouldStoreWeChatLoginResult({
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

test("Feishu QR binding records the scanned user as a local confirmation candidate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        client_id: "cli_feishu_1",
        client_secret: "sec_feishu_1",
        user_info: { open_id: "ou_feishu_owner" },
      }),
  });
  const state = createComoteState({ autoStartFeishuRuntime: false });
  try {
    await state.runtime.feishu.getLoginStatus({ loginId: "login_1", interval: 1, expireIn: 1 });

    assert.deepEqual(state.authorization.listDetectedIdentities(), [
      {
        channel: "feishu",
        stableId: "ou_feishu_owner",
        displayName: "ou_feishu_owner",
        role: "operator",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await state.runtime.feishu.stop();
  }
});

test("Feishu runtime status reconciles a stale driver with the saved app config", () => {
  const state = createComoteState({
    autoStartFeishuRuntime: false,
    persisted: {
      channelConfigs: {
        feishu: {
          enabled: true,
          appId: "cli_current",
          appSecret: "sec_current",
          domain: "feishu",
        },
      },
    },
  });
  state.runtime.feishu.__setTestDriver({
    getStatus: () => ({
      state: "configured",
      appId: "cli_stale",
      domain: "feishu",
    }),
    stopEventStream: () => {},
  });

  const status = state.runtime.feishu.getStatus();

  assert.equal(status.driver.appId, "cli_current");
  assert.equal(status.driver.domain, "feishu");
});
