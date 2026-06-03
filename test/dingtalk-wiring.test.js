// test/dingtalk-wiring.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createComoteState } from "../src/server/state.js";
import { DingTalkDriver } from "../src/channels/dingtalk/driver.js";

// Inject a desktop override + no persistence; we only exercise channel wiring.
// createComoteState({ persisted, stateStore, autoStart*, desktop }) — `desktop`
// maps to its desktopOverride; there is no `cli` param (cli is internal).
function deps() {
  return {
    desktop: { onEvent: null, async listProjects() { return []; } },
    stateStore: null,
    persisted: {},
  };
}

test("registry includes dingtalk and builds its stack + runtime wrapper", async () => {
  const state = createComoteState(deps());
  assert.ok(state.registry.getChannel("dingtalk"), "dingtalk plugin registered");
  assert.ok(state.runtime.dingtalk, "dingtalk runtime wrapper present");
  assert.equal(typeof state.runtime.dingtalk.configure, "function");
  // push channel exposes inbound + deliver seams
  assert.equal(typeof state.runtime.dingtalk.handleInbound, "function");
  assert.equal(typeof state.runtime.dingtalk.deliverQueued, "function");
  // credentials (non-qr) channel does NOT expose login
  assert.equal(state.runtime.dingtalk.startLogin, undefined);
});

test("configuring dingtalk credentials starts the runtime", async (t) => {
  // De-flake: configure() builds a REAL DingTalkDriver and start()s it. The real
  // startEventStream late-imports dingtalk-stream and fires a background
  // client.connect() whose async failure could flip running back to false before
  // the assertion. Patch the driver's startEventStream to a clean no-op resolve so
  // the only thing left is base start()'s synchronous running=true — fully
  // deterministic, no live socket, no flake.
  const original = DingTalkDriver.prototype.startEventStream;
  DingTalkDriver.prototype.startEventStream = async function startEventStream() {
    return { ok: true };
  };
  t.after(() => {
    DingTalkDriver.prototype.startEventStream = original;
  });

  const state = createComoteState(deps());
  await state.runtime.dingtalk.configure({ enabled: true, appKey: "ak", appSecret: "as" });
  // base start() sets running=true synchronously; with a clean startEventStream
  // the channel is deterministically running once configure() resolves.
  const status = state.runtime.dingtalk.getStatus();
  assert.equal(status.state, "running");
});
