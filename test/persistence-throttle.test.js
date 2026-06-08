import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { JsonFileStore } from "../src/core/persistence.js";

// state.json is rewritten in full on every save, and a streaming Codex turn
// calls save() on nearly every event. Without throttling that dirties GBs/hour
// (macOS flags comote-node as an excessive-disk-write process). These tests pin
// the throttle: rapid saves collapse to one physical write, the newest snapshot
// wins, and flush() forces a pending write out for graceful shutdown.

async function tmpStore(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "comote-throttle-"));
  const filePath = join(dir, "state.json");
  return { dir, filePath, store: new JsonFileStore({ filePath, ...opts }) };
}

test("rapid saves coalesce into a single physical write, newest wins", async () => {
  const { dir, store } = await tmpStore({ minWriteIntervalMs: 1000 });
  let last;
  for (let i = 1; i <= 5; i++) {
    last = store.save({ n: i });
  }
  await last;
  assert.deepEqual(await store.load(), { n: 5 }, "the newest snapshot must win");
  assert.equal(store._writeCounter, 1, "5 rapid saves should produce one physical write");
  await rm(dir, { recursive: true, force: true });
});

test("a save after the throttle window is delayed until flush()", async () => {
  const { dir, store } = await tmpStore({ minWriteIntervalMs: 60_000 });
  await store.save({ n: 1 }); // leading edge: written immediately when idle
  assert.deepEqual(await store.load(), { n: 1 });

  const pending = store.save({ n: 2 }); // throttled ~60s out
  assert.deepEqual(await store.load(), { n: 1 }, "the throttled write must not land yet");

  await store.flush(); // graceful-shutdown path forces it now
  await pending;
  assert.deepEqual(await store.load(), { n: 2 });
  await rm(dir, { recursive: true, force: true });
});

test("an unchanged snapshot is not rewritten to disk", async () => {
  const { dir, store } = await tmpStore({ minWriteIntervalMs: 0 });
  await store.save({ a: 1 });
  assert.equal(store._writeCounter, 1);

  await store.save({ a: 1 }); // identical bytes -> skipped
  assert.equal(store._writeCounter, 1, "an unchanged snapshot must not write again");

  await store.save({ a: 2 }); // changed -> writes
  assert.equal(store._writeCounter, 2);
  assert.deepEqual(await store.load(), { a: 2 });
  await rm(dir, { recursive: true, force: true });
});

test("an idle save still persists promptly (leading edge preserved)", async () => {
  const { dir, store } = await tmpStore({ minWriteIntervalMs: 1000 });
  await store.save({ hello: "world" });
  assert.deepEqual(await store.load(), { hello: "world" });
  assert.equal(store._writeCounter, 1);
  await rm(dir, { recursive: true, force: true });
});
