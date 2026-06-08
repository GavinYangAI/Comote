import assert from "node:assert/strict";
import { test } from "node:test";

import { assertSafeBind, isLoopbackHost } from "../src/server/bind-safety.js";

test("loopback with no token is allowed", () => {
  assert.doesNotThrow(() => assertSafeBind({ host: "127.0.0.1", hasToken: false }));
});

test("loopback with token is allowed", () => {
  assert.doesNotThrow(() => assertSafeBind({ host: "127.0.0.1", hasToken: true }));
});

test("0.0.0.0 with no token is unsafe", () => {
  assert.throws(() => assertSafeBind({ host: "0.0.0.0", hasToken: false }), {
    code: "COMOTE_UNSAFE_BIND",
  });
});

test("public IP with no token is unsafe", () => {
  assert.throws(() => assertSafeBind({ host: "203.0.113.7", hasToken: false }), {
    code: "COMOTE_UNSAFE_BIND",
  });
});

test("non-loopback host with token is allowed", () => {
  assert.doesNotThrow(() => assertSafeBind({ host: "0.0.0.0", hasToken: true }));
  assert.doesNotThrow(() => assertSafeBind({ host: "203.0.113.7", hasToken: true }));
});

test("localhost and ::1 are treated as loopback", () => {
  assert.doesNotThrow(() => assertSafeBind({ host: "localhost", hasToken: false }));
  assert.doesNotThrow(() => assertSafeBind({ host: "::1", hasToken: false }));
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});
