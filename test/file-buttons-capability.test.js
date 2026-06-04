import test from "node:test";
import assert from "node:assert/strict";
import feishu from "../src/channels/feishu/index.js";
import telegram from "../src/channels/telegram/index.js";
import dingtalk from "../src/channels/dingtalk/index.js";
import wechat from "../src/channels/wechat/index.js";

test("fileButtons capability: feishu=1, dingtalk/wechat=0, telegram present (flips in Task 5)", () => {
  assert.equal(feishu.meta.capabilities.fileButtons, 1);
  assert.equal(dingtalk.meta.capabilities.fileButtons, 0);
  assert.equal(wechat.meta.capabilities.fileButtons, 0);
  assert.ok([0, 1].includes(telegram.meta.capabilities.fileButtons));
});
