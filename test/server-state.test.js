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

  await tick();
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
