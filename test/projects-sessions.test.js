import test from "node:test";
import assert from "node:assert/strict";

import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";

test("project store lists projects from Codex Desktop", () => {
  const store = new ProjectStore();

  store.replaceProjects([
    { name: "comote", path: "/home/test/projects/comote", source: "codex-desktop", status: "available" },
    { name: "other", path: "/home/test/projects/other", source: "codex-desktop", status: "available" },
  ]);

  assert.deepEqual(store.listProjects(), [
    {
      id: "1",
      name: "comote",
      path: "/home/test/projects/comote",
      source: "codex-desktop",
      status: "available",
    },
    {
      id: "2",
      name: "other",
      path: "/home/test/projects/other",
      source: "codex-desktop",
      status: "available",
    },
  ]);
});

test("project store ids are stable across refreshes for the same paths", () => {
  const store = new ProjectStore();

  store.replaceProjects([
    { name: "alpha", path: "/repo/alpha", source: "codex-desktop", status: "available" },
    { name: "beta", path: "/repo/beta", source: "codex-desktop", status: "available" },
  ]);
  const firstIds = store.listProjects().map((p) => p.id);

  // Simulate a second refresh — same paths, different order.
  store.replaceProjects([
    { name: "beta", path: "/repo/beta", source: "codex-desktop", status: "available" },
    { name: "alpha", path: "/repo/alpha", source: "codex-desktop", status: "available" },
  ]);
  const secondIds = Object.fromEntries(store.listProjects().map((p) => [p.path, p.id]));

  // Paths that existed before must keep their ids.
  assert.equal(secondIds["/repo/alpha"], firstIds[0]);
  assert.equal(secondIds["/repo/beta"], firstIds[1]);
});

test("project store can open a path by number or absolute path", () => {
  const store = new ProjectStore();
  store.replaceProjects([
    { name: "comote", path: "/home/test/projects/comote", source: "codex-desktop", status: "available" },
  ]);

  assert.equal(store.resolveProject("1").path, "/home/test/projects/comote");
  assert.equal(store.resolveProject("/tmp/demo").path, "/tmp/demo");
});

test("project store starts empty before first refresh", () => {
  const store = new ProjectStore();
  assert.deepEqual(store.listProjects(), []);
});

test("session store creates and switches active sessions per project", () => {
  const store = new SessionStore();

  const first = store.createSession({
    projectPath: "/repo",
    title: "Investigate tests",
    firstMessage: "why are tests failing",
  });
  const second = store.createSession({
    projectPath: "/repo",
    title: "Build bridge",
    firstMessage: "implement comote",
  });

  store.useSession("/repo", first.id);

  assert.equal(store.getActiveSession("/repo").id, first.id);
  assert.deepEqual(
    store.listSessions("/repo").map((session) => session.id),
    [first.id, second.id],
  );
});

test("renaming a cached external session preserves the active session", () => {
  const store = new SessionStore();
  store.upsertExternalSession({ projectPath: "/repo", id: "thread_a", title: "thread_a" });
  store.upsertExternalSession({ projectPath: "/repo", id: "thread_b", title: "Active thread" });

  assert.equal(store.updateExternalSessionTitle("thread_a", "  Renamed thread  "), true);
  assert.equal(store.getActiveSession("/repo").id, "thread_b");
  assert.equal(store.listSessions("/repo")[0].title, "Renamed thread");
  assert.equal(store.updateExternalSessionTitle("thread_missing", "Unknown"), false);
  assert.equal(store.updateExternalSessionTitle("thread_a", "   "), false);
});
