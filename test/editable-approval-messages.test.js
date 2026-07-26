import assert from "node:assert/strict";
import test from "node:test";

import { EditableApprovalMessages } from "../src/channels/base/editable-approval-messages.js";

test("editable approval messages update the remembered original once", async () => {
  const updates = [];
  const tracker = new EditableApprovalMessages({
    update: async (message, resolution) => updates.push({ message, resolution }),
  });
  tracker.remember("a1", { messageId: "m1", approval: { method: "exec" } });

  assert.equal(await tracker.resolve({ code: "a1", decision: "acceptForSession" }), true);
  assert.equal(await tracker.resolve({ code: "a1", decision: "acceptForSession", fallback: { messageId: "m1" } }), true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].resolution.decision, "acceptForSession");
  assert.equal(updates[0].resolution.approval.method, "exec");
});

test("editable approval messages can use a callback message as a restart fallback", async () => {
  const updates = [];
  const tracker = new EditableApprovalMessages({ update: async (message) => updates.push(message) });
  assert.equal(await tracker.resolve({ code: "a2", decision: "decline", fallback: { messageId: "m2" } }), true);
  assert.deepEqual(updates, [{ messageId: "m2" }]);
});

test("a failed update restores the message so the outbound queue can retry", async () => {
  let attempts = 0;
  const tracker = new EditableApprovalMessages({
    update: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
    },
  });
  tracker.remember("a3", { messageId: "m3" });
  await assert.rejects(() => tracker.resolve({ code: "a3", decision: "accept" }), /temporary failure/);
  assert.equal(await tracker.resolve({ code: "a3", decision: "accept" }), true);
  assert.equal(attempts, 2);
});
