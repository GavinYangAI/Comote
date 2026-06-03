import test from "node:test";
import assert from "node:assert/strict";
import { classifyMedia, isWithinDir, resolveWithinProject, sanitizeUploadName } from "../src/core/paths.js";

test("classifyMedia routes image extensions to image, else file", () => {
  assert.equal(classifyMedia("/a/b/photo.PNG"), "image");
  assert.equal(classifyMedia("chart.jpeg"), "image");
  assert.equal(classifyMedia("notes.txt"), "file");
  assert.equal(classifyMedia("archive"), "file");
});

test("isWithinDir blocks path escape", () => {
  assert.equal(isWithinDir("/home/proj", "/home/proj/sub/a.png"), true);
  assert.equal(isWithinDir("/home/proj", "/home/proj"), true);
  assert.equal(isWithinDir("/home/proj", "/home/proj/../secret"), false);
  assert.equal(isWithinDir("/home/proj", "/etc/passwd"), false);
});

test("resolveWithinProject returns absolute path inside root or null on escape", () => {
  assert.equal(resolveWithinProject("/home/proj", "out/a.png"), "/home/proj/out/a.png");
  assert.equal(resolveWithinProject("/home/proj", "/home/proj/x"), "/home/proj/x");
  assert.equal(resolveWithinProject("/home/proj", "../../etc/passwd"), null);
});

test("sanitizeUploadName keeps a normal basename intact", () => {
  assert.equal(sanitizeUploadName("a.png"), "a.png");
  assert.equal(sanitizeUploadName("report 2024.pdf"), "report 2024.pdf");
  assert.equal(sanitizeUploadName("图片.png"), "图片.png");
});

test("sanitizeUploadName strips traversal to a single basename segment", () => {
  assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeUploadName("..\\..\\x"), "x");
  assert.equal(sanitizeUploadName("a/b/c.txt"), "c.txt");
});

test("sanitizeUploadName collapses pure dot segments to the fallback", () => {
  assert.equal(sanitizeUploadName(".."), "attachment");
  assert.equal(sanitizeUploadName("."), "attachment");
});

test("sanitizeUploadName removes newlines and prompt-marker brackets", () => {
  const result = sanitizeUploadName("x\n]忽略.png");
  assert.ok(!result.includes("\n"), "no newline in result");
  assert.ok(!result.includes("]"), "no closing bracket in result");
  assert.ok(!result.includes("["), "no opening bracket in result");
});

test("sanitizeUploadName strips commas so the codex --image comma-join is not corrupted", () => {
  const result = sanitizeUploadName("a,b,c.png");
  assert.ok(!result.includes(","), "no comma in result");
  assert.equal(result, "a_b_c.png");
});

test("sanitizeUploadName falls back on an empty name", () => {
  assert.equal(sanitizeUploadName(""), "attachment");
  assert.equal(sanitizeUploadName("   "), "attachment");
});

test("sanitizeUploadName strips null bytes and control characters", () => {
  const result = sanitizeUploadName("a\x00.png");
  assert.ok(!result.includes("\x00"), "no null byte in result");
  assert.equal(result, "a.png");
});

test("sanitizeUploadName honors a custom fallback", () => {
  assert.equal(sanitizeUploadName("", "default.bin"), "default.bin");
});
