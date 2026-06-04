import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFileDeliveries, MAX_INLINE_LINES } from "../src/core/file-delivery.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "comote-fd-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("text file is inlined as a single text reply, fenced", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "report.md");
    await writeFile(p, "# Title\nhello world\n");
    const replies = await buildFileDeliveries({ path: p, fileName: "report.md" });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].kind, "text");
    assert.match(replies[0].text, /report\.md/);
    assert.match(replies[0].text, /hello world/);
    assert.match(replies[0].text, /```/);
  });
});

test("long text file is truncated and gets a file attachment appended", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "big.txt");
    const body = Array.from({ length: MAX_INLINE_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    await writeFile(p, body);
    const replies = await buildFileDeliveries({ path: p, fileName: "big.txt" });
    assert.equal(replies.length, 2);
    assert.equal(replies[0].kind, "text");
    assert.match(replies[0].text, /line 0/);
    assert.doesNotMatch(replies[0].text, /line 349/);
    assert.deepEqual(replies[1], { kind: "media", mediaKind: "file", path: p, fileName: "big.txt" });
  });
});

test("image file becomes an image media reply", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "chart.png");
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const replies = await buildFileDeliveries({ path: p, fileName: "chart.png" });
    assert.deepEqual(replies, [{ kind: "media", mediaKind: "image", path: p, fileName: "chart.png" }]);
  });
});

test("binary file becomes a file media reply", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "bundle.zip");
    await writeFile(p, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const replies = await buildFileDeliveries({ path: p, fileName: "bundle.zip" });
    assert.deepEqual(replies, [{ kind: "media", mediaKind: "file", path: p, fileName: "bundle.zip" }]);
  });
});

test("missing file yields a single degraded text reply", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "gone.md");
    const replies = await buildFileDeliveries({ path: p, fileName: "gone.md" });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].kind, "text");
    assert.ok(typeof replies[0].text === "string" && replies[0].text.length > 0);
  });
});
