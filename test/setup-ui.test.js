import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("setup flow starts with phone channels instead of asking users to connect Codex", async () => {
  const html = await readFile("public/index.html", "utf8");
  const setupFlow = html.match(/<section id="connectPhone"[\s\S]*?<\/section>/)?.[0] ?? "";

  assert.match(setupFlow, /<h2[^>]*>连接手机<\/h2>/);
  // C4: the two hardcoded feishu/wechat cards were replaced by one empty
  // container that app.js fills from the registry-driven GET /api/channels, so
  // the cards (incl. 微信/飞书 headings, login areas, domain select, bind buttons)
  // are now rendered client-side rather than present in the static HTML.
  assert.match(setupFlow, /<div id="channelCards"><\/div>/);
  assert.doesNotMatch(setupFlow, /<h2[^>]*>连接 Codex Desktop<\/h2>/);
  assert.doesNotMatch(setupFlow, /id="autoConnectDesktop"/);
  assert.doesNotMatch(setupFlow, /id="connectDesktop"/);
  assert.doesNotMatch(setupFlow, /id="startWechat"/);
  assert.doesNotMatch(setupFlow, /id="stopWechat"/);
  assert.doesNotMatch(setupFlow, />开始监听<\/button>/);
  assert.doesNotMatch(setupFlow, />停止<\/button>/);
});
