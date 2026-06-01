import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FeishuDriver, buildEventHandlers } from "../src/channels/feishu/driver.js";

test("feishu driver verifies webhook tokens and sends text replies", async () => {
  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    verificationToken: "verify_me",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tenant_token" });
      }
      return jsonResponse({ code: 0 });
    },
  });

  assert.equal(driver.verifyEvent({ token: "verify_me" }), true);
  await driver.sendText({ receiveId: "chat_1", text: "hello" });

  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /im\/v1\/messages/);
  assert.equal(requests[1].options.headers.authorization, "Bearer tenant_token");
});

test("feishu driver starts and polls QR app registration", async () => {
  const requests = [];
  const driver = new FeishuDriver({
    appId: "placeholder",
    appSecret: "placeholder",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = new URLSearchParams(options.body);
      if (body.get("action") === "init") {
        return jsonResponse({ supported_auth_methods: ["client_secret"] });
      }
      if (body.get("action") === "begin") {
        return jsonResponse({
          device_code: "device_1",
          verification_uri_complete: "https://accounts.feishu.cn/scan?device_code=device_1",
          user_code: "ABCD",
          interval: 1,
          expire_in: 600,
        });
      }
      return jsonResponse({
        client_id: "cli_new",
        client_secret: "secret_new",
        user_info: { open_id: "ou_owner", tenant_brand: "feishu" },
      });
    },
  });

  const started = await driver.startLogin({ domain: "feishu" });
  const status = await driver.getLoginStatus({
    loginId: started.loginId,
    domain: started.domain,
  });

  assert.equal(started.loginId, "device_1");
  assert.match(started.qrUrl, /tp=ob_cli_app/);
  assert.equal(status.state, "confirmed");
  assert.equal(status.appId, "cli_new");
  assert.equal(status.appSecret, "secret_new");
  assert.equal(status.userId, "ou_owner");
  assert.equal(requests[2].url, "https://accounts.feishu.cn/oauth/v1/app/registration");
});

test("feishu driver reports a pending state while the user has not scanned yet", async () => {
  const driver = new FeishuDriver({
    appId: "placeholder",
    appSecret: "placeholder",
    fetchImpl: async (url, options) => {
      const body = new URLSearchParams(options.body);
      if (body.get("action") === "poll") {
        // Feishu returns device-flow OAuth errors as HTTP 400 with a JSON body.
        return jsonResponse({ error: "authorization_pending", code: 20094 }, 400);
      }
      return jsonResponse({});
    },
  });

  const status = await driver.getLoginStatus({ loginId: "device_1", domain: "feishu" });

  assert.equal(status.state, "pending");
});

test("feishu driver sends and updates interactive cards", async () => {
  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tenant_token" });
      }
      if (options.method === "PATCH") {
        return jsonResponse({ code: 0 });
      }
      return jsonResponse({ code: 0, data: { message_id: "om_card_1" } });
    },
  });

  const sent = await driver.sendCard({ receiveId: "oc_chat", card: { elements: [] } });
  assert.equal(sent.messageId, "om_card_1");

  const sendReq = requests.find(
    (req) => req.options.method === "POST" && req.url.includes("/im/v1/messages?"),
  );
  assert.equal(JSON.parse(sendReq.options.body).msg_type, "interactive");

  await driver.updateCard({ messageId: "om_card_1", card: { elements: [] } });
  const patchReq = requests.find((req) => req.options.method === "PATCH");
  assert.match(patchReq.url, /im\/v1\/messages\/om_card_1/);
  assert.ok(JSON.parse(patchReq.options.body).content);
});

test("buildEventHandlers wires inbound events and card actions", async () => {
  const seen = [];
  const handlers = buildEventHandlers({
    onEvent: async (data) => seen.push(["event", data]),
    onCardAction: async (data) => {
      seen.push(["card", data]);
      return { toast: { type: "info", content: "ok" } };
    },
  });

  await handlers["im.message.receive_v1"]({ id: 1 });
  const cardResult = await handlers["card.action.trigger"]({ id: 2 });

  assert.deepEqual(seen, [
    ["event", { id: 1 }],
    ["card", { id: 2 }],
  ]);
  assert.deepEqual(cardResult, { toast: { type: "info", content: "ok" } });
});

test("buildEventHandlers tolerates a missing card-action handler", async () => {
  const handlers = buildEventHandlers({ onEvent: async () => {} });
  const result = await handlers["card.action.trigger"]({ id: 3 });
  assert.deepEqual(result, {});
});

test("feishu driver resolves an open_id to a display name and caches it", async () => {
  let contactCalls = 0;
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok" });
      }
      if (url.includes("/contact/v3/users/")) {
        contactCalls += 1;
        return jsonResponse({ code: 0, data: { user: { name: "张三" } } });
      }
      return jsonResponse({});
    },
  });

  assert.equal(await driver.resolveUserName("ou_1"), "张三");
  assert.equal(await driver.resolveUserName("ou_1"), "张三");
  assert.equal(contactCalls, 1, "second lookup should hit the cache");
});

test("feishu driver returns null when the contact lookup is not permitted", async () => {
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok" });
      }
      return jsonResponse({ code: 99991672, msg: "permission denied" }, 403);
    },
  });

  assert.equal(await driver.resolveUserName("ou_1"), null);
});

// ── Issue 2: tenant token caching and nonzero-code errors ──────────────────

test("getTenantAccessToken re-fetches after expiry", async () => {
  let tokenCalls = 0;
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        tokenCalls += 1;
        // Return a normal 2-hour expire so the safety margin math works out
        return jsonResponse({ tenant_access_token: `tok_${tokenCalls}`, expire: 7200 });
      }
      return jsonResponse({ code: 0 });
    },
  });

  const first = await driver.getTenantAccessToken();
  assert.equal(first, "tok_1");
  assert.equal(tokenCalls, 1);

  // Cache should be used when still within the expiry window
  const cached = await driver.getTenantAccessToken();
  assert.equal(cached, "tok_1", "should return cached token");
  assert.equal(tokenCalls, 1);

  // Force expiry by back-dating the expiry timestamp to the past
  driver.tenantAccessTokenExpiry = Date.now() - 1;

  const refreshed = await driver.getTenantAccessToken();
  assert.equal(refreshed, "tok_2", "should re-fetch after expiry");
  assert.equal(tokenCalls, 2);
});

test("sendText throws when the API returns HTTP 200 with nonzero code", async () => {
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok", expire: 7200 });
      }
      // Feishu returns HTTP 200 but code 99991668 = expired token
      return jsonResponse({ code: 99991668, msg: "tenant access token invalid" });
    },
  });

  await driver.getTenantAccessToken(); // prime the cache

  await assert.rejects(
    () => driver.sendText({ receiveId: "chat_1", text: "hello" }),
    (err) => {
      assert.match(err.message, /99991668/);
      return true;
    },
  );

  // Token cache must be cleared after an auth-related failure
  assert.equal(driver.tenantAccessToken, null, "cached token must be cleared on API error");
});

test("sendCard throws when the API returns HTTP 200 with nonzero code and clears the token", async () => {
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok", expire: 7200 });
      }
      return jsonResponse({ code: 10003, msg: "app not found" });
    },
  });

  await assert.rejects(
    () => driver.sendCard({ receiveId: "chat_1", card: { elements: [] } }),
    (err) => {
      assert.match(err.message, /10003/);
      return true;
    },
  );

  assert.equal(driver.tenantAccessToken, null);
});

test("updateCard throws when the API returns HTTP 200 with nonzero code and clears the token", async () => {
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok", expire: 7200 });
      }
      return jsonResponse({ code: 99991668, msg: "token invalid" });
    },
  });

  await assert.rejects(
    () => driver.updateCard({ messageId: "om_1", card: { elements: [] } }),
    (err) => {
      assert.match(err.message, /99991668/);
      return true;
    },
  );

  assert.equal(driver.tenantAccessToken, null);
});

test("concurrent getTenantAccessToken calls only fetch the token once", async () => {
  let tokenFetchCount = 0;
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        tokenFetchCount += 1;
        // Simulate a small async delay to allow both callers to reach the guard
        await new Promise((resolve) => setImmediate(resolve));
        return jsonResponse({ tenant_access_token: "shared_tok", expire: 7200 });
      }
      return jsonResponse({ code: 0 });
    },
  });

  const [tok1, tok2] = await Promise.all([
    driver.getTenantAccessToken(),
    driver.getTenantAccessToken(),
  ]);

  assert.equal(tokenFetchCount, 1, "token endpoint must be fetched exactly once");
  assert.equal(tok1, "shared_tok");
  assert.equal(tok2, "shared_tok");
});

test("getTenantAccessToken rejects all concurrent awaiters on fetch failure", async () => {
  let fetchCount = 0;
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        fetchCount += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { ok: false, status: 500, text: async () => "server error" };
      }
      return jsonResponse({ code: 0 });
    },
  });

  const [result1, result2] = await Promise.allSettled([
    driver.getTenantAccessToken(),
    driver.getTenantAccessToken(),
  ]);

  assert.equal(fetchCount, 1, "token endpoint must only be fetched once even on failure");
  assert.equal(result1.status, "rejected");
  assert.equal(result2.status, "rejected");
  assert.match(result1.reason.message, /Feishu token failed/);
  assert.match(result2.reason.message, /Feishu token failed/);
});

test("feishu driver uploads image and file then returns keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-up-"));
  const imgPath = join(dir, "a.png");
  const filePath = join(dir, "notes.txt");
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(filePath, "hello");

  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok" });
      }
      if (url.endsWith("/im/v1/images")) {
        return jsonResponse({ code: 0, data: { image_key: "img_1" } });
      }
      if (url.endsWith("/im/v1/files")) {
        return jsonResponse({ code: 0, data: { file_key: "file_1" } });
      }
      return jsonResponse({ code: 0 });
    },
  });

  const imageKey = await driver.uploadImage(imgPath);
  const fileKey = await driver.uploadFile(filePath, "notes.txt");

  assert.equal(imageKey, "img_1");
  assert.equal(fileKey, "file_1");
  const imageReq = requests.find((r) => r.url.endsWith("/im/v1/images"));
  assert.ok(imageReq.options.body instanceof FormData);
  assert.equal(imageReq.options.headers.authorization, "Bearer tok");
});

test("uploadFile sends a multipart body with stream type and explicit file name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-up-"));
  const filePath = join(dir, "notes.txt");
  writeFileSync(filePath, "hello");

  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok" });
      }
      if (url.endsWith("/im/v1/files")) {
        return jsonResponse({ code: 0, data: { file_key: "file_1" } });
      }
      return jsonResponse({ code: 0 });
    },
  });

  await driver.uploadFile(filePath, "notes.txt");

  const fileReq = requests.find((r) => r.url.endsWith("/im/v1/files"));
  assert.ok(fileReq.options.body instanceof FormData);
  assert.equal(fileReq.options.headers.authorization, "Bearer tok");
  assert.equal(fileReq.options.body.get("file_type"), "stream");
  assert.equal(fileReq.options.body.get("file_name"), "notes.txt");
});

test("uploadFile defaults file_name to the basename of localPath", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-up-"));
  const filePath = join(dir, "report.csv");
  writeFileSync(filePath, "a,b,c");

  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok" });
      }
      if (url.endsWith("/im/v1/files")) {
        return jsonResponse({ code: 0, data: { file_key: "file_1" } });
      }
      return jsonResponse({ code: 0 });
    },
  });

  await driver.uploadFile(filePath);

  const fileReq = requests.find((r) => r.url.endsWith("/im/v1/files"));
  assert.equal(fileReq.options.body.get("file_name"), "report.csv");
});

test("uploadImage sends image_type=message in the multipart body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-up-"));
  const imgPath = join(dir, "a.png");
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok" });
      }
      if (url.endsWith("/im/v1/images")) {
        return jsonResponse({ code: 0, data: { image_key: "img_1" } });
      }
      return jsonResponse({ code: 0 });
    },
  });

  await driver.uploadImage(imgPath);

  const imageReq = requests.find((r) => r.url.endsWith("/im/v1/images"));
  assert.equal(imageReq.options.body.get("image_type"), "message");
});

test("uploadImage throws and clears the token when the API returns a nonzero code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-up-"));
  const imgPath = join(dir, "a.png");
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok", expire: 7200 });
      }
      return jsonResponse({ code: 230002, msg: "bad" });
    },
  });

  await assert.rejects(() => driver.uploadImage(imgPath), /Feishu API error/);
  assert.equal(driver.tenantAccessToken, null, "cached token must be cleared on API error");
});

test("uploadFile throws when the upload endpoint responds with a non-ok status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-up-"));
  const filePath = join(dir, "notes.txt");
  writeFileSync(filePath, "hello");

  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok" });
      }
      return new Response("boom", { status: 500 });
    },
  });

  await assert.rejects(() => driver.uploadFile(filePath, "x"), /upload failed/);
});

test("feishu driver sends image and file messages", async () => {
  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok" });
      }
      return jsonResponse({ code: 0, data: { message_id: "m1" } });
    },
  });

  await driver.sendImage({ receiveId: "chat_1", imageKey: "img_1" });
  await driver.sendFile({ receiveId: "chat_1", fileKey: "file_1" });

  const imageReq = requests.find((r) => JSON.parse(r.options.body).msg_type === "image");
  const fileReq = requests.find((r) => JSON.parse(r.options.body).msg_type === "file");
  assert.equal(JSON.parse(imageReq.options.body).content, JSON.stringify({ image_key: "img_1" }));
  assert.equal(JSON.parse(fileReq.options.body).content, JSON.stringify({ file_key: "file_1" }));
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
