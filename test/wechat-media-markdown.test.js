import test from "node:test";
import assert from "node:assert/strict";

import { WeChatChannelAdapter } from "../src/channels/wechat/adapter.js";
import { stripMarkdown } from "../src/channels/wechat/markdown.js";

// ── markdown sanitization ──────────────────────────────────────────────────

test("stripMarkdown removes headings, emphasis, inline code, and links", () => {
  assert.equal(stripMarkdown("# Title"), "Title");
  assert.equal(stripMarkdown("**bold** and *italic*"), "bold and italic");
  assert.equal(stripMarkdown("__b__ text"), "b text");
  assert.equal(stripMarkdown("use `npm test` now"), "use npm test now");
  assert.equal(stripMarkdown("see [docs](https://x.com)"), "see docs https://x.com");
});

test("stripMarkdown keeps snake_case identifiers intact", () => {
  assert.equal(stripMarkdown("call foo_bar_baz() please"), "call foo_bar_baz() please");
});

test("stripMarkdown unwraps fenced code blocks", () => {
  assert.equal(stripMarkdown("```js\nconst x = 1;\n```").trim(), "const x = 1;");
});

// ── WeChat media → text fallback ───────────────────────────────────────────

test("a media reply degrades to a descriptive text on WeChat", async () => {
  const sent = [];
  const adapter = new WeChatChannelAdapter({
    commandRouter: {
      handleMessageAsync: async () => ({
        kind: "media",
        text: "",
        media: { kind: "image", path: "/proj/a.png", name: "a.png" },
      }),
    },
    sendReply: async (reply) => {
      sent.push(reply);
      return { ok: true };
    },
  });

  await adapter.handleInbound({
    accountId: "acc",
    peer: { id: "wxid_o", name: "O" },
    conversation: { id: "dm_wxid_o", type: "direct" },
    message: { id: "m1", text: "/img a.png" },
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /已生成图片：a\.png/);
  assert.match(sent[0].text, /\/proj\/a\.png/);
  assert.match(sent[0].text, /微信暂不支持/);
});
