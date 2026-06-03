import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { JsonFileStore } from "../src/core/persistence.js";

test("json file store persists and reloads Comote state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-store-"));
  const store = new JsonFileStore({ filePath: join(dir, "state.json") });

  await store.save({
    identities: [{ channel: "wechat", stableId: "wx:owner", displayName: "Alice" }],
  });

  assert.deepEqual(await store.load(), {
    identities: [{ channel: "wechat", stableId: "wx:owner", displayName: "Alice" }],
  });
  assert.match(await readFile(join(dir, "state.json"), "utf8"), /"identities"/);

  await rm(dir, { recursive: true, force: true });
});

test("json file store loads PowerShell UTF-8 BOM state files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-store-bom-"));
  const store = new JsonFileStore({ filePath: join(dir, "state.json") });
  try {
    await writeFile(join(dir, "state.json"), "\uFEFF{\"identities\":[]}", "utf8");

    assert.deepEqual(await store.load(), { identities: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
