import test from "node:test";
import assert from "node:assert/strict";

import { attachmentPromptLine } from "../src/core/attachment-prompt.js";

test("image attachment keeps a bare path reference (pixels go via multimodal)", () => {
  const line = attachmentPromptLine({ relativePath: ".comote/uploads/a.png", kind: "image" });
  assert.equal(line, "[attachment: .comote/uploads/a.png]");
});

test("non-image attachment becomes an explicit read instruction containing the path", () => {
  const line = attachmentPromptLine({ relativePath: ".comote/uploads/report.pdf", kind: "file" });
  assert.doesNotMatch(line, /^\[attachment:/);
  assert.match(line, /\.comote\/uploads\/report\.pdf/);
});
