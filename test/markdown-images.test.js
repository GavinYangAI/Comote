import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { neutralizeMarkdownImages, planLocalMarkdownImages } from "../src/core/markdown-images.js";

test("neutralizeMarkdownImages removes Feishu image markdown syntax", () => {
  const text = "完成\n\n![预览](D:\\work\\preview.png)";
  const result = neutralizeMarkdownImages(text);
  assert.equal(result, "完成\n\n🖼️ 预览");
  assert.ok(!result.includes("!["));
});

test("planLocalMarkdownImages extracts existing project images and deduplicates them", () => {
  const root = mkdtempSync(join(tmpdir(), "comote-md-images-"));
  const image = join(root, "result preview.png");
  writeFileSync(image, "png");
  const text = `结果\n![第一张](<${image}>)\n![重复](<${image}>)`;
  const result = planLocalMarkdownImages(text, { projectRoot: root });
  assert.deepEqual(result.images, [image]);
  assert.ok(!result.text.includes("!["));
  assert.match(result.text, /第一张（图片将单独发送）/);
});

test("planLocalMarkdownImages refuses images outside the active project", () => {
  const root = mkdtempSync(join(tmpdir(), "comote-md-root-"));
  const outside = mkdtempSync(join(tmpdir(), "comote-md-outside-"));
  const image = join(outside, "secret.png");
  writeFileSync(image, "png");
  const result = planLocalMarkdownImages(`![私有图片](<${image}>)`, { projectRoot: root });
  assert.deepEqual(result.images, []);
  assert.match(result.text, /本地图片未自动发送/);
});

test("planLocalMarkdownImages ignores non-image files", () => {
  const root = mkdtempSync(join(tmpdir(), "comote-md-non-image-"));
  mkdirSync(join(root, "nested"));
  const file = join(root, "nested", "notes.txt");
  writeFileSync(file, "not an image");
  const result = planLocalMarkdownImages(`![伪图片](<${file}>)`, { projectRoot: root });
  assert.deepEqual(result.images, []);
  assert.match(result.text, /本地图片未自动发送/);
});
