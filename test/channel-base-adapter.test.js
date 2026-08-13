import test from "node:test";
import assert from "node:assert/strict";
import { BaseChannelAdapter } from "../src/channels/base/adapter.js";
import { t } from "../src/core/i18n/index.js";

// Resolve a reason bucket to its translated string in the active locale so the
// classification tests assert the bucket (not brittle English prose).
const reason = (bucket) => t(`cmd.attachment.reason.${bucket}`);

class StubAdapter extends BaseChannelAdapter {
  normalizeInbound(payload) {
    return {
      messageId: payload.id,
      conversationId: payload.chat,
      conversationType: payload.group ? "group" : "direct",
      identity: { channel: "test", stableId: payload.user, displayName: payload.user },
      text: payload.text ?? "",
      attachments: payload.attachments ?? [],
    };
  }
}

function make(overrides = {}) {
  const enqueued = [];
  const detected = [];
  const adapter = new StubAdapter({
    channelId: "test",
    commandRouter: { handleMessageAsync: async (m) => ({ kind: "text", text: `echo:${m.text}` }) },
    sendReply: async (r) => { enqueued.push(r); return { ok: true }; },
    onDetectedIdentity: (i) => detected.push(i),
    allowGroups: false,
    ...overrides,
  });
  return { adapter, enqueued, detected };
}

test("routes a direct message and enqueues a semantic text reply", async () => {
  const { adapter, enqueued, detected } = make();
  await adapter.handleInbound({ id: "m1", chat: "c1", user: "u1", text: "hi" });
  assert.equal(detected.length, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, "text");
  assert.equal(enqueued[0].text, "echo:hi");
  assert.equal(enqueued[0].conversationId, "c1");
});

test("routes manager commands before project attachment handling", async () => {
  let downloads = 0;
  let projectRoutes = 0;
  const { adapter, enqueued, detected } = make({
    commandRouter: {
      handleManagerMessageAsync: async (message) => (
        message.text.startsWith("/manager") ? { kind: "text", text: "manager:ok" } : null
      ),
      handleMessageAsync: async () => { projectRoutes += 1; return { kind: "text", text: "project" }; },
    },
    downloadAttachment: async () => { downloads += 1; return { relativePath: ".comote/uploads/file.txt" }; },
  });

  await adapter.handleInbound({
    id: "manager-1",
    chat: "c1",
    user: "u1",
    text: "/manager tasks",
    attachments: [{ fileName: "file.txt" }],
  });

  assert.equal(downloads, 0);
  assert.equal(projectRoutes, 0);
  assert.equal(detected.length, 0);
  assert.equal(enqueued[0].text, "manager:ok");
});

test("ignores group messages when allowGroups is false, with ONE direct-only notice per group (B-12a)", async () => {
  const { adapter, enqueued } = make();
  const out = await adapter.handleInbound({ id: "m2", chat: "g1", user: "u1", text: "hi", group: true });
  assert.equal(out.kind, "ignored");
  // First group message: one "direct messages only" notice so the group isn't
  // met with dead silence — but the message itself is still NOT routed.
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].text, t("cmd.group.onlyDirect"));
  assert.equal(enqueued[0].conversationId, "g1");
  // Repeats in the same group stay silent (no spam).
  const again = await adapter.handleInbound({ id: "m2b", chat: "g1", user: "u2", text: "yo", group: true });
  assert.equal(again.kind, "ignored");
  assert.equal(enqueued.length, 1, "no second notice for the same group");
  // A different group gets its own single notice.
  await adapter.handleInbound({ id: "m2c", chat: "g2", user: "u1", text: "hi", group: true });
  assert.equal(enqueued.length, 2);
  assert.equal(enqueued[1].conversationId, "g2");
});

test("group-notice memory is FIFO-capped at 200 groups (B-12a)", async () => {
  const { adapter, enqueued } = make();
  for (let i = 0; i < 201; i += 1) {
    await adapter.handleInbound({ id: `g${i}`, chat: `group-${i}`, user: "u1", text: "hi", group: true });
  }
  assert.equal(enqueued.length, 201, "each new group noticed once");
  // group-0 was evicted (FIFO) → a new message there re-notices once.
  await adapter.handleInbound({ id: "re0", chat: "group-0", user: "u1", text: "hi", group: true });
  assert.equal(enqueued.length, 202, "evicted group is re-noticed");
  // group-200 is still remembered → stays silent.
  await adapter.handleInbound({ id: "re200", chat: "group-200", user: "u1", text: "hi", group: true });
  assert.equal(enqueued.length, 202, "remembered group stays silent");
});

test("a failing notice reply still returns the ignored result (B-12a)", async () => {
  const { adapter } = make({ sendReply: async () => { throw new Error("send failed"); } });
  const out = await adapter.handleInbound({ id: "m2x", chat: "g9", user: "u1", text: "hi", group: true });
  assert.equal(out.kind, "ignored");
});

test("prefixes downloaded attachment paths into the prompt", async () => {
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    downloadAttachment: async ({ attachment }) => ({ relativePath: `.comote/uploads/${attachment.fileName}` }),
  });
  await adapter.handleInbound({ id: "m3", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "a.png" }] });
  assert.match(calls[0], /\[attachment: \.comote\/uploads\/a\.png\]/);
  assert.match(calls[0], /see/);
});

test("noProjectMessage override is used for the attachment NO_PROJECT reply", async () => {
  const sent = [];
  class A extends BaseChannelAdapter {
    normalizeInbound() {
      return { messageId: "m", conversationId: "c", conversationType: "direct",
        identity: { channel: "x", stableId: "s" }, text: "", attachments: [{ id: 1 }] };
    }
  }
  const adapter = new A({
    channelId: "x",
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "" }) },
    sendReply: async (r) => sent.push(r),
    downloadAttachment: async () => { throw new Error("NO_PROJECT"); },
    noProjectMessage: () => "CUSTOM_NO_PROJECT",
  });
  await adapter.handleInbound({});
  assert.equal(sent[0].text, "CUSTOM_NO_PROJECT");
});

test("non-image attachment becomes a read instruction in the prompt", async () => {
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    downloadAttachment: async ({ attachment }) => ({ relativePath: `.comote/uploads/${attachment.fileName}` }),
  });
  await adapter.handleInbound({ id: "m4", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "report.pdf" }] });
  // A non-image file is no longer a bare `[attachment: …]` reference…
  assert.doesNotMatch(calls[0], /\[attachment: \.comote\/uploads\/report\.pdf\]/);
  // …it names the in-project path inside a read instruction, and keeps the user's text.
  assert.match(calls[0], /\.comote\/uploads\/report\.pdf/);
  assert.match(calls[0], /see/);
});

test("a message with both an image and a non-image yields a reference for the image and an instruction for the file", async () => {
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    downloadAttachment: async ({ attachment }) => ({ relativePath: `.comote/uploads/${attachment.fileName}` }),
  });
  await adapter.handleInbound({
    id: "m5", chat: "c1", user: "u1", text: "look at these",
    attachments: [{ fileName: "pic.png" }, { fileName: "notes.pdf" }],
  });
  // Image keeps the bare reference…
  assert.match(calls[0], /\[attachment: \.comote\/uploads\/pic\.png\]/);
  // …the non-image is NOT a bare reference but its path still appears (inside the read instruction)…
  assert.doesNotMatch(calls[0], /\[attachment: \.comote\/uploads\/notes\.pdf\]/);
  assert.match(calls[0], /\.comote\/uploads\/notes\.pdf/);
  // …and the user's own text is preserved.
  assert.match(calls[0], /look at these/);
});

// --- Workflow A: download failures must not be silently swallowed ---

test("a download error is reported back to the user (not silently skipped)", async () => {
  const sent = [];
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => { throw new Error("boom network"); },
  });
  await adapter.handleInbound({ id: "m6", chat: "c1", user: "u1", text: "look", attachments: [{ fileName: "pic.png" }] });
  // The failed file's name must surface in a reply to the user, never silently dropped.
  const failure = sent.find((r) => /pic\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a download-failure reply naming the file");
  assert.equal(failure.conversationId, "c1");
});

test("multiple download failures are merged into a single reply (no spam)", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => { throw new Error("boom"); },
  });
  await adapter.handleInbound({
    id: "m7", chat: "c1", user: "u1", text: "look",
    attachments: [{ fileName: "a.png" }, { fileName: "b.png" }, { fileName: "c.png" }],
  });
  const failures = sent.filter((r) => /a\.png|b\.png|c\.png/.test(r.text ?? ""));
  // One coalesced failure reply, not three.
  assert.equal(failures.length, 1);
  assert.match(failures[0].text, /a\.png/);
  assert.match(failures[0].text, /b\.png/);
  assert.match(failures[0].text, /c\.png/);
});

test("the unsafe-path download error is classified distinctly", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => { throw new Error("UNSAFE_ATTACHMENT_PATH"); },
  });
  await adapter.handleInbound({ id: "m8", chat: "c1", user: "u1", text: "look", attachments: [{ fileName: "evil.png" }] });
  const failure = sent.find((r) => /evil\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply naming the file");
  // The raw sentinel string must never leak verbatim to the user.
  assert.doesNotMatch(failure.text, /UNSAFE_ATTACHMENT_PATH/);
});

test("a pure-image message whose only attachment fails to download does NOT route a turn", async () => {
  const sent = [];
  let routed = false;
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => { routed = true; return { kind: "text", text: "ok" }; } },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => { throw new Error("boom"); },
  });
  const out = await adapter.handleInbound({ id: "m9", chat: "c1", user: "u1", text: "", attachments: [{ fileName: "pic.png" }] });
  // No empty turn submitted.
  assert.equal(routed, false);
  assert.equal(out.kind, "ignored");
  // The user gets an "all failed" notice instead of silence.
  assert.ok(sent.some((r) => (r.text ?? "").length > 0), "expected an all-failed reply");
});

test("a pure-image message that downloads successfully still routes a turn (no false guard)", async () => {
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    downloadAttachment: async ({ attachment }) => ({ relativePath: `.comote/uploads/${attachment.fileName}` }),
  });
  await adapter.handleInbound({ id: "m10", chat: "c1", user: "u1", text: "", attachments: [{ fileName: "pic.png" }] });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\[attachment: \.comote\/uploads\/pic\.png\]/);
});

test("when one of several attachments fails, the rest still route and the failure is reported", async () => {
  const calls = [];
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async ({ attachment }) => {
      if (attachment.fileName === "bad.png") throw new Error("boom");
      return { relativePath: `.comote/uploads/${attachment.fileName}` };
    },
  });
  await adapter.handleInbound({
    id: "m11", chat: "c1", user: "u1", text: "see",
    attachments: [{ fileName: "good.png" }, { fileName: "bad.png" }],
  });
  // The good one still routed…
  assert.equal(calls.length, 1);
  assert.match(calls[0], /good\.png/);
  // …and the bad one was reported.
  assert.ok(sent.some((r) => /bad\.png/.test(r.text ?? "")));
});

test("a channel with no downloadAttachment replies unsupported instead of an empty turn", async () => {
  const sent = [];
  let routed = false;
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => { routed = true; return { kind: "text", text: "ok" }; } },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    // no downloadAttachment wired (mirrors wechat)
  });
  const out = await adapter.handleInbound({ id: "m12", chat: "c1", user: "u1", text: "", attachments: [{ fileName: "pic.png" }] });
  assert.equal(routed, false);
  assert.equal(out.kind, "ignored");
  assert.ok(sent.some((r) => (r.text ?? "").length > 0), "expected an unsupported-channel reply");
});

// --- Finding #9 (abstraction): the "this channel can't take media" decision is
// driven by the EXPLICIT supportsMedia capability (sourced from
// capabilities.media), not inferred from whether a downloadAttachment closure
// happens to be wired. supportsMedia:false short-circuits to the unsupported
// path even if a downloadAttachment is present; supportsMedia:true takes the
// download path. ---

test("supportsMedia:false routes to the unsupported path even with a downloadAttachment wired", async () => {
  const sent = [];
  let downloaded = false;
  const { adapter } = make({
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    supportsMedia: false,
    downloadAttachment: async () => { downloaded = true; return { relativePath: ".comote/uploads/x" }; },
  });
  const out = await adapter.handleInbound({ id: "m9a", chat: "c1", user: "u1", text: "", attachments: [{ fileName: "pic.png" }] });
  assert.equal(downloaded, false, "the explicit capability gates out the download");
  assert.equal(out.kind, "ignored");
  assert.ok(sent.some((r) => (r.text ?? "").length > 0), "expected an unsupported-channel reply");
});

test("supportsMedia:true takes the download path", async () => {
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    supportsMedia: true,
    downloadAttachment: async ({ attachment }) => ({ relativePath: `.comote/uploads/${attachment.fileName}` }),
  });
  await adapter.handleInbound({ id: "m9b", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "a.png" }] });
  assert.match(calls[0], /\[attachment: \.comote\/uploads\/a\.png\]/);
});

// --- Finding #4: an image with a caption must not drop the caption text ---

test("a channel with no downloadAttachment still routes the caption text and warns about the dropped image", async () => {
  const sent = [];
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    // no downloadAttachment wired (mirrors wechat)
  });
  const out = await adapter.handleInbound({
    id: "m16", chat: "c1", user: "u1", text: "修一下截图里的 bug", attachments: [{ fileName: "shot.png" }],
  });
  // The caption text is NOT lost — it still routes to Codex.
  assert.equal(calls.length, 1);
  assert.match(calls[0], /修一下截图里的 bug/);
  // The turn is not "ignored" — the text was actually handled.
  assert.notEqual(out.kind, "ignored");
  // The user is warned the image was dropped but the text was kept.
  assert.ok(sent.some((r) => (r.text ?? "").length > 0), "expected an image-dropped-text-kept reply");
});

test("a channel with no downloadAttachment and a pure image (no caption) still replies pure unsupported", async () => {
  const sent = [];
  let routed = false;
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => { routed = true; return { kind: "text", text: "ok" }; } },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    // no downloadAttachment wired (mirrors wechat)
  });
  const out = await adapter.handleInbound({ id: "m17", chat: "c1", user: "u1", text: "   ", attachments: [{ fileName: "pic.png" }] });
  // Whitespace-only caption counts as no text → no empty turn submitted.
  assert.equal(routed, false);
  assert.equal(out.kind, "ignored");
  assert.ok(sent.some((r) => (r.text ?? "").length > 0), "expected an unsupported-channel reply");
});

// --- Finding #10: anchor each download-error bucket to a real driver error shape ---
// These mirror the actual throw sites so a driver/undici wording or code change
// that silently re-buckets a failure trips a test instead of degrading to "network".

test("a Feishu 413 resource-download failure classifies as too-large", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    // Mirrors feishu/driver.js downloadMessageResource on a non-200 response.
    downloadAttachment: async () => { throw new Error("Feishu resource download failed: 413 Payload Too Large"); },
  });
  await adapter.handleInbound({ id: "f1", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "big.png" }] });
  const failure = sent.find((r) => /big\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply");
  assert.ok(failure.text.includes(reason("tooLarge")));
});

test("a Feishu 404 resource-download failure classifies as a network/download error", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => { throw new Error("Feishu resource download failed: 404 {\"code\":234001}"); },
  });
  await adapter.handleInbound({ id: "f2", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "gone.png" }] });
  const failure = sent.find((r) => /gone\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply");
  assert.ok(failure.text.includes(reason("network")));
});

test("a Telegram 'file is too big' getFile failure classifies as too-large", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    // Mirrors telegram/driver.js _call: Error("Telegram getFile failed: 400 …"), err.code = error_code.
    downloadAttachment: async () => {
      const err = new Error("Telegram getFile failed: 400 Bad Request: file is too big");
      err.code = 400;
      throw err;
    },
  });
  await adapter.handleInbound({ id: "t1", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "huge.mp4" }] });
  const failure = sent.find((r) => /huge\.mp4/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply");
  assert.ok(failure.text.includes(reason("tooLarge")));
});

test("a Telegram '413' file-download failure classifies as too-large", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    // Mirrors telegram/driver.js downloadAttachment on a non-ok file response.
    downloadAttachment: async () => { throw new Error("Telegram file download failed: 413"); },
  });
  await adapter.handleInbound({ id: "t2", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "huge.png" }] });
  const failure = sent.find((r) => /huge\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply");
  assert.ok(failure.text.includes(reason("tooLarge")));
});

test("an undici connect-timeout (UND_ERR_CONNECT_TIMEOUT) classifies as timeout", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => {
      const err = new Error("Connect Timeout Error");
      err.code = "UND_ERR_CONNECT_TIMEOUT";
      throw err;
    },
  });
  await adapter.handleInbound({ id: "t3", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "slow.png" }] });
  const failure = sent.find((r) => /slow\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply");
  assert.ok(failure.text.includes(reason("timeout")));
});

test("a bare ETIMEDOUT socket error classifies as timeout", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => {
      const err = new Error("connect ETIMEDOUT 1.2.3.4:443");
      err.code = "ETIMEDOUT";
      throw err;
    },
  });
  await adapter.handleInbound({ id: "t4", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "slow2.png" }] });
  const failure = sent.find((r) => /slow2\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply");
  assert.ok(failure.text.includes(reason("timeout")));
});

test("a filesystem EACCES write error classifies as unreadable", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => {
      const err = new Error("EACCES: permission denied, open '/x'");
      err.code = "EACCES";
      throw err;
    },
  });
  await adapter.handleInbound({ id: "t5", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "perm.png" }] });
  const failure = sent.find((r) => /perm\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply");
  assert.ok(failure.text.includes(reason("unreadable")));
});

test("an ECONNRESET network error classifies as network/download error", async () => {
  const sent = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    downloadAttachment: async () => {
      const err = new Error("socket hang up");
      err.code = "ECONNRESET";
      throw err;
    },
  });
  await adapter.handleInbound({ id: "t6", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "reset.png" }] });
  const failure = sent.find((r) => /reset\.png/.test(r.text ?? ""));
  assert.ok(failure, "expected a failure reply");
  assert.ok(failure.text.includes(reason("network")));
});

test("handleInboundFailure replies to a direct message with a generic error", async () => {
  const sent = [];
  const { adapter } = make({ sendReply: async (r) => { sent.push(r); return { ok: true }; } });
  await adapter.handleInboundFailure({ id: "m13", chat: "c1", user: "u1", text: "hi" }, new Error("kaboom"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, "c1");
  assert.ok((sent[0].text ?? "").length > 0);
});

test("handleInboundFailure stays silent for group messages", async () => {
  const sent = [];
  const { adapter } = make({ sendReply: async (r) => { sent.push(r); return { ok: true }; } });
  await adapter.handleInboundFailure({ id: "m14", chat: "g1", user: "u1", text: "hi", group: true }, new Error("kaboom"));
  assert.equal(sent.length, 0);
});

test("handleInboundFailure never throws even if normalize/sendReply blow up", async () => {
  const { adapter } = make({ sendReply: async () => { throw new Error("send broke"); } });
  await assert.doesNotReject(() => adapter.handleInboundFailure({ id: "m15", chat: "c1", user: "u1" }, new Error("x")));
});
