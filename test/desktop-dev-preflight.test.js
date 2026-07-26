import assert from "node:assert/strict";
import test from "node:test";

import { stopExistingDevelopmentDaemon } from "../scripts/prepare-desktop-dev.mjs";

function jsonResponse(body) {
  return { ok: true, async json() { return body; } };
}

test("desktop dev preflight is a no-op when no daemon is listening", async () => {
  let killed = false;
  const result = await stopExistingDevelopmentDaemon({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    killImpl: () => { killed = true; },
  });

  assert.deepEqual(result, { stopped: false, pid: null });
  assert.equal(killed, false);
});

test("desktop dev preflight stops a daemon and waits for its port", async () => {
  let fetchCalls = 0;
  const kills = [];
  const result = await stopExistingDevelopmentDaemon({
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return jsonResponse({ version: "0.7.1", pid: 4242 });
      if (fetchCalls === 2) return jsonResponse({ version: "0.7.1", pid: 4242 });
      throw new Error("ECONNREFUSED");
    },
    killImpl: (...args) => kills.push(args),
    sleepImpl: async () => {},
  });

  assert.deepEqual(kills, [[4242]]);
  assert.deepEqual(result, { stopped: true, pid: 4242 });
});

test("desktop dev preflight refuses to kill a service without a valid pid", async () => {
  await assert.rejects(
    () => stopExistingDevelopmentDaemon({
      fetchImpl: async () => jsonResponse({ version: "0.7.1" }),
    }),
    /did not report a valid pid/,
  );
});
