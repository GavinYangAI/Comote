import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/desktop-release.yml";

test("desktop release publishes stable tags and main-branch prereleases", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /branches:\s*\n\s*- main/);
  assert.match(workflow, /- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"/);
  assert.match(workflow, /RELEASE_TAG="v\$\{VERSION\}\+build\.\$\{GITHUB_RUN_NUMBER\}"/);
  assert.match(workflow, /PRERELEASE=true/);
  assert.match(workflow, /environment: \$\{\{ github\.ref_type == 'tag' && 'release-signing' \|\| 'prerelease' \}\}/);
  assert.match(workflow, /HAS_CERT: \$\{\{ github\.ref_type == 'tag' && secrets\.APPLE_CERTIFICATE != '' \}\}/);
  assert.match(workflow, /publish-release:[\s\S]*?if: github\.event_name == 'push'/);
  assert.match(workflow, /tag_name: \$\{\{ steps\.release\.outputs\.tag \}\}/);
  assert.match(workflow, /prerelease: \$\{\{ steps\.release\.outputs\.prerelease \}\}/);
});

test("desktop release notes cover every commit since the previous stable tag", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /--exclude '\*\+\*' --exclude '\*-\*'/);
  assert.match(workflow, /CHANGE_RANGE="\$\{PREVIOUS_TAG\}\.\.\$\{GITHUB_SHA\}"/);
  assert.match(workflow, /git log --format='- %s \(`%h`\)' "\$CHANGE_RANGE"/);
  assert.doesNotMatch(workflow, /Build release notes from CHANGELOG/);
});

test("desktop release notes render direct asset links in the downloads table", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /MAC_DMG="Comote-\$\{VERSION\}-arm64\.dmg"/);
  assert.match(workflow, /WINDOWS_SETUP="Comote-Setup-\$\{VERSION\}-x64\.exe"/);
  assert.match(workflow, /Expected release artifact missing: \$ARTIFACT/);
  assert.match(workflow, /RELEASE_DOWNLOAD_BASE="https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\/releases\/download\/\$\{RELEASE_TAG\}"/);
  assert.match(workflow, /\| Platform \/ 平台 \| Architecture \/ 架构 \| Download \/ 下载 \|/);
  assert.match(workflow, /printf '\| macOS \| Apple Silicon \(arm64\) \| \[%s\]\(%s\/%s\) \|\\n' "\$MAC_DMG" "\$RELEASE_DOWNLOAD_BASE" "\$MAC_DMG"/);
  assert.match(workflow, /printf '\| Windows \| x64 \| \[%s\]\(%s\/%s\) \|\\n\\n' "\$WINDOWS_SETUP" "\$RELEASE_DOWNLOAD_BASE" "\$WINDOWS_SETUP"/);
});

test("main-branch prereleases do not publish the npm package", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /publish-npm:[\s\S]*?if: github\.ref_type == 'tag' && github\.repository == 'GavinYangAI\/Comote'/,
  );
});
