import test from "node:test";
import assert from "node:assert/strict";
import { classifyMedia, isWithinDir, resolveWithinProject } from "../src/core/paths.js";

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
