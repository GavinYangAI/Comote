import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planChangedFileDelivery } from "../src/core/changed-files-delivery.js";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "comote-cfd-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const filesOf = (...ps) => ps.map((p) => ({ path: p, name: p.split("/").pop() }));

test("empty files → all empty", async () => {
  const r = await planChangedFileDelivery([], { supportsButtons: true });
  assert.deepEqual(r, { inlineReplies: [], buttonFiles: [], attachmentReplies: [] });
});

test("small text inlines; binary becomes a button when supported", async () => {
  await withDir(async (dir) => {
    const md = join(dir, "a.md"); await writeFile(md, "# hi\n");
    const png = join(dir, "b.png"); await writeFile(png, Buffer.from([0x89, 0x50]));
    const r = await planChangedFileDelivery(filesOf(md, png), { supportsButtons: true });
    assert.equal(r.inlineReplies.length, 1);
    assert.equal(r.inlineReplies[0].kind, "text");
    assert.match(r.inlineReplies[0].text, /a\.md/);
    assert.deepEqual(r.buttonFiles.map((f) => f.path), [png]);
    assert.equal(r.attachmentReplies.length, 0);
  });
});

test("small text inlines; binary auto-attaches when buttons unsupported", async () => {
  await withDir(async (dir) => {
    const md = join(dir, "a.md"); await writeFile(md, "# hi\n");
    const png = join(dir, "b.png"); await writeFile(png, Buffer.from([0x89, 0x50]));
    const r = await planChangedFileDelivery(filesOf(md, png), { supportsButtons: false });
    assert.equal(r.inlineReplies.length, 1);
    assert.equal(r.buttonFiles.length, 0);
    assert.equal(r.attachmentReplies.length, 1);
    assert.equal(r.attachmentReplies[0].kind, "media");
    assert.equal(r.attachmentReplies[0].mediaKind, "image");
  });
});

test("over K with buttons → all become buttons (no inline)", async () => {
  await withDir(async (dir) => {
    const ps = [];
    for (let i = 0; i < 5; i++) { const p = join(dir, `f${i}.md`); await writeFile(p, "x"); ps.push(p); }
    const r = await planChangedFileDelivery(filesOf(...ps), { supportsButtons: true, maxButtons: 3 });
    assert.equal(r.inlineReplies.length, 0);
    assert.equal(r.buttonFiles.length, 5);
    assert.equal(r.attachmentReplies.length, 0);
  });
});

test("over K without buttons → single tooMany notice, nothing auto-sent", async () => {
  await withDir(async (dir) => {
    const ps = [];
    for (let i = 0; i < 5; i++) { const p = join(dir, `f${i}.md`); await writeFile(p, "x"); ps.push(p); }
    const r = await planChangedFileDelivery(filesOf(...ps), { supportsButtons: false, maxButtons: 3 });
    assert.equal(r.inlineReplies.length, 1);
    assert.equal(r.inlineReplies[0].kind, "text");
    assert.equal(r.buttonFiles.length, 0);
    assert.equal(r.attachmentReplies.length, 0);
  });
});
