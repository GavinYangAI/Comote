import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonFileStore } from "../src/core/persistence.js";
import { SessionStore } from "../src/core/sessions.js";

async function tmpFile(name = "state.json") {
  const dir = await mkdtemp(join(tmpdir(), "comote-hardening-"));
  return { dir, filePath: join(dir, "nested", name) };
}

// [H2] Concurrent fire-and-forget saves must not collide on the tmp path
// (rename ENOENT / torn writes) and must converge on the latest snapshot.
test("[H2] concurrent saves serialize without collision and keep last snapshot", async () => {
  const { filePath } = await tmpFile();
  const store = new JsonFileStore({ filePath });

  // Fire many overlapping saves with distinct payloads.
  const saves = [];
  for (let i = 0; i < 50; i++) {
    saves.push(store.save({ counter: i }));
  }
  await Promise.all(saves);

  // The file must be valid JSON (no torn write) and hold the final snapshot.
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(parsed.counter, 49);
});

test("[H2] no leftover .tmp files after concurrent saves", async () => {
  const { dir, filePath } = await tmpFile();
  const store = new JsonFileStore({ filePath });
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.save({ n: i })));

  const stateDir = join(dir, "nested");
  const entries = await readdir(stateDir);
  const leftovers = entries.filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `unexpected tmp leftovers: ${leftovers.join(", ")}`);
});

test("[H2] save coalesces pending writes to reduce write amplification", async () => {
  const { filePath } = await tmpFile();
  const store = new JsonFileStore({ filePath });

  // The first save() occupies the in-flight slot; the rest land in a single
  // coalesced pending slot, so they share one promise.
  store.save({ v: 0 });
  const p1 = store.save({ v: 1 });
  const p2 = store.save({ v: 2 });
  const p3 = store.save({ v: 3 });
  assert.equal(p1, p2, "coalesced saves should share one promise");
  assert.equal(p2, p3, "coalesced saves should share one promise");

  await Promise.all([p1, p2, p3]);
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(parsed.v, 3, "latest coalesced snapshot wins");
});

test("[H2] a rejected write does not wedge the queue", async () => {
  const { filePath } = await tmpFile();
  const store = new JsonFileStore({ filePath });

  // Force the first write to fail (circular -> JSON.stringify throws).
  const circular = {};
  circular.self = circular;
  await assert.rejects(store.save(circular));

  // Subsequent saves still run.
  await store.save({ ok: true });
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(parsed, { ok: true });
});

test("[H2] load round-trips a saved snapshot and returns {} when missing", async () => {
  const { filePath } = await tmpFile();
  const store = new JsonFileStore({ filePath });

  assert.deepEqual(await store.load(), {}, "missing file loads as empty object");

  await store.save({ settings: { a: 1 }, sessions: [] });
  assert.deepEqual(await store.load(), { settings: { a: 1 }, sessions: [] });
});

// [M3] Secret-bearing state file and its directory must be owner-only.
test("[M3] state file is written with 0600 and dir with 0700", async () => {
  const { filePath } = await tmpFile();
  const store = new JsonFileStore({ filePath });
  await store.save({ channelConfigs: { dingtalk: { appSecret: "secret" } } });

  const fileStat = await stat(filePath);
  assert.equal(fileStat.mode & 0o777, 0o600, "state.json must be owner read/write only");

  const dirStat = await stat(join(filePath, ".."));
  assert.equal(dirStat.mode & 0o777, 0o700, "state dir must be owner-only");
});

test("[M3] mode stays 0600 across overwrites", async () => {
  const { filePath } = await tmpFile();
  const store = new JsonFileStore({ filePath });
  await store.save({ v: 1 });
  await store.save({ v: 2 });
  const fileStat = await stat(filePath);
  assert.equal(fileStat.mode & 0o777, 0o600);
});

// [LOW-nextid] nextId must be seeded past rehydrated session_NNNN ids.
test("[LOW-nextid] reload seeds nextId past existing session ids", () => {
  const store = new SessionStore({
    sessions: [
      { projectPath: "/p", id: "session_0003", title: "three" },
      { projectPath: "/p", id: "session_0007", title: "seven" },
    ],
  });

  const created = store.createSession({ projectPath: "/p", title: "new" });
  assert.equal(created.id, "session_0008", "new id must not collide with rehydrated ids");
});

test("[LOW-nextid] external (non-session) ids do not perturb nextId", () => {
  const store = new SessionStore({
    sessions: [{ projectPath: "/p", id: "thread_abc", title: "external" }],
  });
  const created = store.createSession({ projectPath: "/p", title: "new" });
  assert.equal(created.id, "session_0001");
});

test("[LOW-nextid] no collision between created and rehydrated ids", () => {
  const store = new SessionStore({
    sessions: [{ projectPath: "/p", id: "session_0001", title: "rehydrated" }],
  });
  const created = store.createSession({ projectPath: "/p", title: "new" });
  assert.notEqual(created.id, "session_0001");
  const all = store.listSessions("/p").map((s) => s.id);
  assert.equal(new Set(all).size, all.length, "ids must be unique");
});
