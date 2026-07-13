// B-9 — shared line-boundary chunker (base/chunk.js) used by the wechat and
// dingtalk renderers. Replaces the fixed slice-every-1500 cutter that broke
// sentences, markdown code fences, and emoji surrogate pairs.
import test from "node:test";
import assert from "node:assert/strict";
import { chunkTextByLines } from "../src/channels/base/chunk.js";

test("short text returns a single chunk; empty returns none", () => {
  assert.deepEqual(chunkTextByLines("hello", 100), ["hello"]);
  assert.deepEqual(chunkTextByLines("", 100), []);
  assert.deepEqual(chunkTextByLines(null, 100), []);
});

test("splits at line boundaries, never mid-line when lines fit", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, "0")} xxxxxxxx`);
  const text = lines.join("\n");
  const chunks = chunkTextByLines(text, 100);
  assert.ok(chunks.length > 1, "long text produced multiple chunks");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, "every chunk fits the limit");
    for (const line of chunk.split("\n")) {
      assert.ok(lines.includes(line), `chunk line is a whole input line, got: ${line}`);
    }
  }
  assert.equal(chunks.join("\n"), text, "no content lost");
});

test("a single line longer than the limit is hard-split without losing content", () => {
  const long = "x".repeat(250);
  const chunks = chunkTextByLines(long, 100);
  assert.equal(chunks.join(""), long);
  for (const chunk of chunks) assert.ok(chunk.length <= 100);
});

test("hard split never lands inside an emoji surrogate pair", () => {
  // "🚀" is 2 UTF-16 units; a naive slice at an odd offset cuts the pair.
  const emoji = "🚀".repeat(120); // 240 UTF-16 units
  const chunks = chunkTextByLines(emoji, 99); // odd limit forces the misalignment
  assert.equal(chunks.join(""), emoji, "no content lost");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 99);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), "no lone high surrogate at a chunk end");
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk), "no lone low surrogate at a chunk start");
  }
});

test("fenceAware: a break inside a code fence closes it and reopens on the next chunk", () => {
  const body = Array.from({ length: 30 }, (_, i) => `code line ${i}`).join("\n");
  const text = `intro\n\`\`\`js\n${body}\n\`\`\`\ntail`;
  const chunks = chunkTextByLines(text, 120, { fenceAware: true });
  assert.ok(chunks.length > 1, "the fenced block spans multiple chunks");
  for (const chunk of chunks) {
    const fences = chunk.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
    assert.equal(fences % 2, 0, `every chunk has balanced fences:\n${chunk}`);
    assert.ok(chunk.length <= 120);
  }
  // Reassembling minus the injected markers restores the original content lines.
  const originalLines = text.split("\n");
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      assert.ok(
        originalLines.includes(line) || line === "```",
        `chunk line is original or an injected fence marker: ${line}`,
      );
    }
  }
});

test("fenceAware: without a fence, behaves like the plain line splitter", () => {
  const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
  assert.deepEqual(
    chunkTextByLines(text, 12, { fenceAware: true }),
    chunkTextByLines(text, 12),
  );
});
