import test from "node:test";
import assert from "node:assert/strict";

import { WeChatIlinkDriver } from "../src/channels/wechat/ilink-driver.js";

test("requires QR login before polling or sending, but not before starting login", async () => {
  const driver = new WeChatIlinkDriver();
  assert.equal(driver.getStatus().baseUrl, "https://ilinkai.weixin.qq.com");
  assert.equal(driver.getStatus().hasToken, false);
  await assert.rejects(() => driver.getUpdates(), /WeChat login is required/);
});

test("polls Tencent iLink-style updates with Comote-owned driver", async () => {
  const requests = [];
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://wechat.example/api/",
    token: "secret",
    accountId: "wx_account_1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        data: {
          updates: [{ from_user_id: "wxid_owner", text: "/status", message_id: "m1" }],
          next_cursor: "cursor_2",
        },
      });
    },
  });

  const result = await driver.getUpdates({ cursor: "cursor_1" });

  assert.equal(result.nextCursor, "cursor_2");
  assert.deepEqual(result.updates, [{ from_user_id: "wxid_owner", text: "/status", message_id: "m1" }]);
  assert.equal(requests[0].url, "https://wechat.example/api/ilink/bot/getupdates");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret");
  assert.equal(requests[0].options.headers["iLink-App-Id"], "bot");
  assert.equal(requests[0].options.headers.AuthorizationType, "ilink_bot_token");
  assert.equal(JSON.parse(requests[0].options.body).get_updates_buf, "cursor_1");
  assert.deepEqual(JSON.parse(requests[0].options.body).base_info, {
    channel_version: "2.4.3",
    bot_agent: "OpenClaw",
  });
});

test("normalizes driver updates for the WeChat adapter", () => {
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://wechat.example/api",
    token: "secret",
  });

  assert.deepEqual(
    driver.normalizeUpdate({
      account_id: "wx_account_1",
      from_user_id: "wxid_owner",
      sender_name: "Alice",
      conversation_id: "dm_wxid_owner",
      message_id: "msg_1",
      content: "/projects",
    }),
    {
      accountId: "wx_account_1",
      peer: {
        id: "wxid_owner",
        name: "Alice",
      },
      conversation: {
        id: "dm_wxid_owner",
        type: "direct",
      },
      message: {
        id: "msg_1",
        text: "/projects",
        attachments: [],
      },
    },
  );
});

test("normalizes OpenClaw Weixin message items and context tokens", () => {
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://wechat.example/api",
    token: "secret",
  });

  assert.deepEqual(
    driver.normalizeUpdate({
      from_user_id: "wxid_owner",
      session_id: "session_1",
      context_token: "ctx_1",
      item_list: [{ type: 1, text_item: { text: "/projects" } }],
    }),
    {
      accountId: "default",
      peer: {
        id: "wxid_owner",
        name: "wxid_owner",
      },
      conversation: {
        id: "dm_wxid_owner",
        type: "direct",
      },
      message: {
        id: "ctx_1",
        text: "/projects",
        attachments: [],
      },
    },
  );
});

test("ignores empty OpenClaw session ids and replies to the sender user id", () => {
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://wechat.example/api",
    token: "secret",
  });

  assert.deepEqual(
    driver.normalizeUpdate({
      account_id: "wx_account_1",
      from_user_id: "wxid_owner",
      session_id: "",
      context_token: "ctx_1",
      item_list: [{ type: 1, text_item: { text: "/projects" } }],
    }),
    {
      accountId: "wx_account_1",
      peer: {
        id: "wxid_owner",
        name: "wxid_owner",
      },
      conversation: {
        id: "dm_wxid_owner",
        type: "direct",
      },
      message: {
        id: "ctx_1",
        text: "/projects",
        attachments: [],
      },
    },
  );
});


test("sends text through Tencent iLink-style sendmessage endpoint", async () => {
  const requests = [];
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://wechat.example/api",
    token: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });

  await driver.sendText({
    accountId: "wx_account_1",
    conversationId: "dm_wxid_owner",
    inReplyTo: "msg_1",
    text: "Comote status",
  });

  assert.equal(requests[0].url, "https://wechat.example/api/ilink/bot/sendmessage");
  const body = JSON.parse(requests[0].options.body);
  assert.match(body.msg.client_id, /^comote-[0-9a-f-]{36}$/);
  delete body.msg.client_id;
  assert.deepEqual(body, {
    msg: {
      from_user_id: "",
      to_user_id: "wxid_owner",
      context_token: "msg_1",
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 1,
          text_item: {
            text: "Comote status",
          },
        },
      ],
    },
    base_info: {
      channel_version: "2.4.3",
      bot_agent: "OpenClaw",
    },
  });
});

test("sendText normalizes newlines to CRLF for WeChat desktop", async () => {
  const calls = [];
  const driver = new WeChatIlinkDriver({
    baseUrl: "http://x",
    token: "t",
    accountId: "a",
    fetchImpl: async (u, o) => {
      calls.push(JSON.parse(o.body));
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await driver.sendText({ conversationId: "c", text: "line1\nline2" });
  const sent = JSON.stringify(calls[0]);
  assert.ok(sent.includes("line1\\r\\nline2"), "lone \\n should become \\r\\n");
});

test("sendText already-CRLF text is left as a single CRLF (no doubling)", async () => {
  const calls = [];
  const driver = new WeChatIlinkDriver({
    baseUrl: "http://x",
    token: "t",
    fetchImpl: async (u, o) => {
      calls.push(JSON.parse(o.body));
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await driver.sendText({ conversationId: "c", text: "line1\r\nline2" });
  assert.equal(calls[0].msg.item_list[0].text_item.text, "line1\r\nline2");
});

test("starts and checks a WeChat QR login session without user-supplied URL or token", async () => {
  const requests = [];
  const driver = new WeChatIlinkDriver({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("/ilink/bot/get_bot_qrcode")) {
        return jsonResponse({ qrcode: "login_1", qrcode_img_content: "https://qr.example/1" });
      }
      return jsonResponse({
        status: "confirmed",
        ilink_bot_id: "wx_account_1",
        bot_token: "bot_token_1",
        baseurl: "https://ilinkai.weixin.qq.com",
        ilink_user_id: "wx_user_1",
      });
    },
  });

  assert.deepEqual(await driver.startLogin(), {
    loginId: "login_1",
    qrUrl: "https://qr.example/1",
    raw: { qrcode: "login_1", qrcode_img_content: "https://qr.example/1" },
  });
  assert.deepEqual(await driver.getLoginStatus({ loginId: "login_1" }), {
    state: "confirmed",
    accountId: "wx_account_1",
    token: "bot_token_1",
    baseUrl: "https://ilinkai.weixin.qq.com",
    userId: "wx_user_1",
    userName: null,
    raw: {
      status: "confirmed",
      ilink_bot_id: "wx_account_1",
      bot_token: "bot_token_1",
      baseurl: "https://ilinkai.weixin.qq.com",
      ilink_user_id: "wx_user_1",
    },
  });
  assert.equal(requests[0].url, "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
  assert.equal(requests[1].url, "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=login_1");
});

test("derives a mobile WeChat QR URL when the API only returns a login id", async () => {
  const driver = new WeChatIlinkDriver({
    fetchImpl: async () => jsonResponse({ qrcode: "login_2", ret: 0 }),
  });

  assert.deepEqual(await driver.startLogin(), {
    loginId: "login_2",
    qrUrl: "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=login_2&bot_type=3",
    raw: { qrcode: "login_2", ret: 0 },
  });
});

test("wechat driver extracts a login nickname when iLink returns one", async () => {
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://ilinkai.weixin.qq.com",
    token: "bot_token",
    accountId: "default",
    fetchImpl: async () =>
      jsonResponse({
        status: "confirmed",
        ilink_bot_id: "bot_1",
        bot_token: "bot_token",
        ilink_user_id: "wx_user_1",
        nickname: "赵六",
      }),
  });

  const status = await driver.getLoginStatus({ loginId: "login_1" });
  assert.equal(status.userName, "赵六");
});

test("wechat driver leaves userName null when iLink omits the nickname", async () => {
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://ilinkai.weixin.qq.com",
    token: "bot_token",
    accountId: "default",
    fetchImpl: async () =>
      jsonResponse({ status: "confirmed", ilink_bot_id: "bot_1", ilink_user_id: "wx_user_1" }),
  });

  const status = await driver.getLoginStatus({ loginId: "login_1" });
  assert.equal(status.userName, null);
});

test("exposes fetchUpdates as a seam that delegates to getUpdates", async () => {
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://wechat.example/api/",
    token: "secret",
    accountId: "wx_account_1",
    fetchImpl: async () =>
      jsonResponse({
        data: {
          updates: [{ from_user_id: "wxid_owner", text: "/status", message_id: "m1" }],
          next_cursor: "cursor_2",
        },
      }),
  });

  assert.equal(typeof driver.fetchUpdates, "function");

  const calls = [];
  const originalGetUpdates = driver.getUpdates.bind(driver);
  driver.getUpdates = (options) => {
    calls.push(options);
    return originalGetUpdates(options);
  };

  const opts = { cursor: "cursor_1" };
  const fetchResult = await driver.fetchUpdates(opts);

  // fetchUpdates must route through getUpdates with the same options...
  assert.equal(calls.length, 1);
  assert.equal(calls[0], opts);
  // ...and return exactly what getUpdates returns for that input.
  const expected = await originalGetUpdates(opts);
  assert.deepEqual(fetchResult, expected);
  assert.equal(fetchResult.nextCursor, "cursor_2");
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
