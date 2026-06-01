import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { saveInboundAttachment, imageExtFromContentType } from "../src/core/attachment-store.js";

const FIXED = new Date("2026-06-01T12:00:00.000Z");

test("saves an inbound image under channel/date/messageId with a full manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-att-"));
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  const result = await saveInboundAttachment({
    attachmentsDir: dir,
    channel: "feishu",
    messageId: "om_123",
    conversationId: "oc_1",
    sender: { stableId: "ou_a", displayName: "Alice" },
    attachment: { kind: "image", feishuKey: "img_v2_k", name: "img_v2_k" },
    buffer,
    contentType: "image/png",
    now: FIXED,
  });

  assert.match(result.path, /[/\\]feishu[/\\]2026-06-01[/\\]om_123[/\\]img_v2_k\.png$/);
  assert.ok(result.path.startsWith("/") || /^[A-Za-z]:\\/.test(result.path), "path is absolute");
  assert.deepEqual(await readFile(result.path), buffer);

  const manifest = JSON.parse(
    await readFile(join(dir, "feishu", "2026-06-01", "om_123", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.length, 1);
  assert.deepEqual(manifest[0], {
    channel: "feishu",
    conversationId: "oc_1",
    messageId: "om_123",
    sender: { stableId: "ou_a", displayName: "Alice" },
    kind: "image",
    name: "img_v2_k",
    mime: "image/png",
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    localPath: result.path,
    mediaKey: "img_v2_k",
    savedAt: "2026-06-01T12:00:00.000Z",
  });

  await rm(dir, { recursive: true, force: true });
});

test("saves an inbound file preserving its original name and media key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-att-"));
  const buffer = Buffer.from("%PDF-1.4 hello");

  const result = await saveInboundAttachment({
    attachmentsDir: dir,
    channel: "feishu",
    messageId: "om_9",
    attachment: { kind: "file", feishuKey: "file_k", name: "report.pdf" },
    buffer,
    contentType: "application/pdf",
    now: FIXED,
  });

  assert.match(result.path, /[/\\]om_9[/\\]report\.pdf$/);
  assert.equal(result.name, "report.pdf");
  const manifest = JSON.parse(
    await readFile(join(dir, "feishu", "2026-06-01", "om_9", "manifest.json"), "utf8"),
  );
  assert.equal(manifest[0].mediaKey, "file_k");
  assert.equal(manifest[0].mime, "application/pdf");
  await rm(dir, { recursive: true, force: true });
});

test("appends a second attachment to the same message's manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-att-"));
  const base = { attachmentsDir: dir, channel: "feishu", messageId: "om_x", contentType: "image/png", now: FIXED };
  await saveInboundAttachment({ ...base, attachment: { kind: "image", feishuKey: "k1", name: "k1" }, buffer: Buffer.from([1]) });
  await saveInboundAttachment({ ...base, attachment: { kind: "image", feishuKey: "k2", name: "k2" }, buffer: Buffer.from([2]) });

  const manifest = JSON.parse(
    await readFile(join(dir, "feishu", "2026-06-01", "om_x", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.length, 2);
  assert.deepEqual(manifest.map((entry) => entry.mediaKey), ["k1", "k2"]);
  await rm(dir, { recursive: true, force: true });
});

test("sanitizes a crafted messageId so it cannot escape the attachments dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-att-"));
  const result = await saveInboundAttachment({
    attachmentsDir: dir,
    channel: "feishu",
    messageId: "../../etc/evil",
    attachment: { kind: "image", feishuKey: "k", name: "k" },
    buffer: Buffer.from([1]),
    contentType: "image/png",
    now: FIXED,
  });

  assert.ok(result.path.includes("/feishu/2026-06-01/"), "stays under channel/date");
  assert.ok(!result.path.includes("/etc/evil"), "path traversal neutralized");
  await rm(dir, { recursive: true, force: true });
});

test("imageExtFromContentType maps common types and defaults to png", () => {
  assert.equal(imageExtFromContentType("image/jpeg"), ".jpg");
  assert.equal(imageExtFromContentType("image/gif; charset=binary"), ".gif");
  assert.equal(imageExtFromContentType(null), ".png");
});
