import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("setup flow starts with phone channels instead of asking users to connect Codex", async () => {
  const html = await readFile("public/index.html", "utf8");
  const setupFlow = html.match(/<section id="connectPhone"[\s\S]*?<\/section>/)?.[0] ?? "";

  assert.match(setupFlow, /<h2[^>]*>连接手机<\/h2>/);
  assert.match(setupFlow, /<h3[^>]*>微信<\/h3>/);
  assert.match(setupFlow, /<h3[^>]*>飞书<\/h3>/);
  assert.match(setupFlow, /id="wechatLoginResult"/);
  assert.match(setupFlow, /id="startWechatLogin"[\s\S]*?>绑定微信<\/button>/);
  assert.match(setupFlow, /id="feishuLoginResult"/);
  assert.match(setupFlow, /id="feishuConfigForm"/);
  assert.match(setupFlow, /name="domain"/);
  assert.match(setupFlow, /id="startFeishuLogin"[\s\S]*?>绑定飞书<\/button>/);
  assert.doesNotMatch(setupFlow, /<h2[^>]*>连接 Codex Desktop<\/h2>/);
  assert.doesNotMatch(setupFlow, /id="autoConnectDesktop"/);
  assert.doesNotMatch(setupFlow, /id="connectDesktop"/);
  assert.doesNotMatch(setupFlow, /id="startWechat"/);
  assert.doesNotMatch(setupFlow, /id="stopWechat"/);
  assert.doesNotMatch(setupFlow, />开始监听<\/button>/);
  assert.doesNotMatch(setupFlow, />停止<\/button>/);
});
