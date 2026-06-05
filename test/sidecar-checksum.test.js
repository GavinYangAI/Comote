import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { checksumMatches, expectedSha } from "../scripts/build-sidecar.mjs";

const FIXTURE_BODY = "comote sidecar checksum fixture";
const ARCHIVE_NAME = "node-v22.0.0-darwin-arm64.tar.gz";
const REAL_SHA = createHash("sha256").update(FIXTURE_BODY).digest("hex");

// A small fake SHASUMS256.txt body in the real `<sha>  <filename>` (two-space)
// format, with an unrelated entry to make sure name matching is exact.
const SHASUMS = [
  `${REAL_SHA}  ${ARCHIVE_NAME}`,
  `${"a".repeat(64)}  node-v22.0.0-win-x64.zip`,
].join("\n") + "\n";

test("expectedSha returns the digest for the matching archive entry", () => {
  assert.equal(expectedSha(SHASUMS, ARCHIVE_NAME), REAL_SHA);
});

test("expectedSha returns null when the archive has no entry", () => {
  assert.equal(expectedSha(SHASUMS, "node-v99.0.0-linux-x64.tar.gz"), null);
});

test("checksumMatches accepts the correct hash (case-insensitive)", () => {
  assert.equal(checksumMatches(REAL_SHA, SHASUMS, ARCHIVE_NAME), true);
  assert.equal(checksumMatches(REAL_SHA.toUpperCase(), SHASUMS, ARCHIVE_NAME), true);
});

test("checksumMatches rejects a tampered hash", () => {
  const tampered = "0".repeat(64);
  assert.notEqual(tampered, REAL_SHA);
  assert.equal(checksumMatches(tampered, SHASUMS, ARCHIVE_NAME), false);
});

test("checksumMatches rejects when the filename entry is missing", () => {
  assert.equal(checksumMatches(REAL_SHA, SHASUMS, "node-v22.0.0-linux-arm64.tar.gz"), false);
});
