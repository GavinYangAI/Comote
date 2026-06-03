import { test } from "node:test";
import assert from "node:assert/strict";
import { DingTalkDriver, buildStreamHandlers } from "../src/channels/dingtalk/driver.js";

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [pattern, responder] of routes) {
      if (url.includes(pattern)) {
        const { status = 200, json } = await responder(url, opts);
        return {
          ok: status >= 200 && status < 300,
          status,
          async json() { return json; },
          async text() { return JSON.stringify(json); },
        };
      }
    }
    throw new Error(`no fake route for ${url}`);
  };
  return { fetch, calls };
}

test("getAccessToken posts appKey/appSecret and caches until expiry", async () => {
  let tokenCalls = 0;
  const { fetch } = fakeFetch([
    ["oauth2/accessToken", async () => { tokenCalls += 1; return { json: { accessToken: "tok-1", expireIn: 7200 } }; }],
  ]);
  const d = new DingTalkDriver({ appKey: "ak", appSecret: "as", fetchImpl: fetch });
  assert.equal(await d.getAccessToken(), "tok-1");
  assert.equal(await d.getAccessToken(), "tok-1");
  assert.equal(tokenCalls, 1); // cached
});

test("sendText calls oToMessages/batchSend with robotCode=AppKey + sampleText", async () => {
  const { fetch, calls } = fakeFetch([
    ["oauth2/accessToken", async () => ({ json: { accessToken: "tok", expireIn: 7200 } })],
    ["oToMessages/batchSend", async () => ({ json: { processQueryKey: "pq" } })],
  ]);
  const d = new DingTalkDriver({ appKey: "ak", appSecret: "as", fetchImpl: fetch });
  await d.sendText({ receiveId: "staff-9", text: "hi" });
  const send = calls.find((c) => c.url.includes("oToMessages/batchSend"));
  assert.equal(send.opts.headers["x-acs-dingtalk-access-token"], "tok");
  const body = JSON.parse(send.opts.body);
  assert.equal(body.robotCode, "ak");
  assert.deepEqual(body.userIds, ["staff-9"]);
  assert.equal(body.msgKey, "sampleText");
  assert.deepEqual(JSON.parse(body.msgParam), { content: "hi" });
});

test("sendMarkdown uses sampleMarkdown with title+text", async () => {
  const { fetch, calls } = fakeFetch([
    ["oauth2/accessToken", async () => ({ json: { accessToken: "tok", expireIn: 7200 } })],
    ["oToMessages/batchSend", async () => ({ json: { processQueryKey: "pq" } })],
  ]);
  const d = new DingTalkDriver({ appKey: "ak", appSecret: "as", fetchImpl: fetch });
  await d.sendMarkdown({ receiveId: "staff-9", title: "T", text: "**b**" });
  const send = calls.find((c) => c.url.includes("oToMessages/batchSend"));
  const body = JSON.parse(send.opts.body);
  assert.equal(body.msgKey, "sampleMarkdown");
  assert.deepEqual(JSON.parse(body.msgParam), { title: "T", text: "**b**" });
});

test("createCard posts createAndDeliver with template id + IM_ROBOT openSpaceId", async () => {
  const { fetch, calls } = fakeFetch([
    ["oauth2/accessToken", async () => ({ json: { accessToken: "tok", expireIn: 7200 } })],
    ["card/instances/createAndDeliver", async () => ({ json: { success: true, result: { outTrackId: "ot-1" } } })],
  ]);
  const d = new DingTalkDriver({ appKey: "ak", appSecret: "as", fetchImpl: fetch });
  const res = await d.createCard({
    cardTemplateId: "tpl.schema",
    outTrackId: "ot-1",
    receiveId: "staff-9",
    cardParamMap: { title: "x" },
  });
  assert.equal(res.outTrackId, "ot-1");
  const send = calls.find((c) => c.url.includes("createAndDeliver"));
  const body = JSON.parse(send.opts.body);
  assert.equal(body.cardTemplateId, "tpl.schema");
  assert.equal(body.callbackType, "STREAM");
  assert.equal(body.openSpaceId, "dtv1.card//IM_ROBOT.staff-9");
  assert.deepEqual(body.cardData.cardParamMap, { title: "x" });
});

test("updateCard PUTs card/instances with updateCardDataByKey", async () => {
  const { fetch, calls } = fakeFetch([
    ["oauth2/accessToken", async () => ({ json: { accessToken: "tok", expireIn: 7200 } })],
    ["card/instances", async () => ({ json: { success: true } })],
  ]);
  const d = new DingTalkDriver({ appKey: "ak", appSecret: "as", fetchImpl: fetch });
  await d.updateCard({ outTrackId: "ot-1", cardParamMap: { title: "y" } });
  const put = calls.find((c) => c.url.includes("card/instances") && c.opts.method === "PUT");
  assert.ok(put, "a PUT to card/instances was made");
  const body = JSON.parse(put.opts.body);
  assert.equal(body.outTrackId, "ot-1");
  assert.equal(body.cardUpdateOptions.updateCardDataByKey, true);
});

test("downloadMessageResource resolves downloadCode then GETs the url to a file", async () => {
  const { fetch, calls } = fakeFetch([
    ["oauth2/accessToken", async () => ({ json: { accessToken: "tok", expireIn: 7200 } })],
    ["messageFiles/download", async () => ({ json: { downloadUrl: "https://dl.example/x" } })],
    ["dl.example", async () => ({ json: {} })], // body bytes read via arrayBuffer below; see note
  ]);
  // arrayBuffer support on the fake GET:
  const origFetch = fetch;
  const wrapped = async (url, opts) => {
    const r = await origFetch(url, opts);
    r.arrayBuffer = async () => new TextEncoder().encode("FILEBYTES").buffer;
    return r;
  };
  const d = new DingTalkDriver({ appKey: "ak", appSecret: "as", fetchImpl: wrapped });
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "dt-"));
  const dest = join(dir, "got.bin");
  const out = await d.downloadMessageResource({ downloadCode: "dc-1", destPath: dest });
  assert.equal(out, dest);
  const { readFile } = await import("node:fs/promises");
  assert.equal((await readFile(dest, "utf8")), "FILEBYTES");
  const dl = calls.find((c) => c.url.includes("messageFiles/download"));
  assert.equal(JSON.parse(dl.opts.body).robotCode, "ak");
});

test("buildStreamHandlers routes TOPIC_ROBOT→onEvent and TOPIC_CARD→onAction with ACK", async () => {
  const events = [];
  const actions = [];
  const acks = [];
  const ack = (mid, payload) => acks.push({ mid, payload });
  const handlers = buildStreamHandlers({
    onEvent: async (p) => events.push(p),
    onAction: async (p) => { actions.push(p); return { cardData: { cardParamMap: { ok: "1" } } }; },
    ack,
    EventAck: { SUCCESS: "SUCCESS" },
  });
  await handlers.robot({ headers: { messageId: "m1" }, data: JSON.stringify({ msgtype: "text", text: { content: "hi" } }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].text.content, "hi");
  assert.deepEqual(acks[0], { mid: "m1", payload: "SUCCESS" });
  await handlers.card({ headers: { messageId: "m2" }, data: JSON.stringify({ outTrackId: "ot", content: "{}" }) });
  assert.equal(actions.length, 1);
  assert.equal(acks[1].mid, "m2");
  assert.deepEqual(acks[1].payload, { cardData: { cardParamMap: { ok: "1" } } });
});
