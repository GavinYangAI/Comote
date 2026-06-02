import test from "node:test";
import assert from "node:assert/strict";
import { DedupTracker } from "../src/channels/base/dedup.js";

test("add returns true for a new id, false for a repeat", () => {
  const d = new DedupTracker(3);
  assert.equal(d.add("a"), true);
  assert.equal(d.add("a"), false);
  assert.equal(d.has("a"), true);
});

test("null/undefined ids are ignored (never marked seen)", () => {
  const d = new DedupTracker(3);
  assert.equal(d.add(null), false);
  assert.equal(d.add(undefined), false);
  assert.equal(d.has(null), false);
});

test("evicts oldest beyond maxSize (FIFO)", () => {
  const d = new DedupTracker(2);
  d.add("a"); d.add("b"); d.add("c"); // "a" evicted
  assert.equal(d.has("a"), false);
  assert.equal(d.has("b"), true);
  assert.equal(d.has("c"), true);
  assert.equal(d.add("a"), true); // re-adding evicted "a" counts as new again
});
