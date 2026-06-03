import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VersionChecker, compareSemver, selectDownloadUrl } from "../src/core/version-check.js";

function makeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.length > 0 ? queue.shift() : queue[queue.length - 1] ?? null;
    if (!next) {
      throw new Error("no mocked response");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("compareSemver orders semantic versions numerically", () => {
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.ok(compareSemver("1.0.1", "1.0.0") > 0);
  assert.ok(compareSemver("0.9.9", "1.0.0") < 0);
  assert.ok(compareSemver("1.10.0", "1.9.0") > 0);
  assert.ok(compareSemver("v0.3.0", "0.2.0") > 0); // v-prefixed input is tolerated by parseInt
});

test("checkNow flags an update when GitHub returns a newer release", async () => {
  const fetchImpl = makeFetch(
    jsonResponse({
      tag_name: "v0.3.0",
      html_url: "https://github.com/GavinYangAI/Comote/releases/tag/v0.3.0",
      assets: [
        {
          name: "Comote-0.3.0.dmg",
          browser_download_url: "https://github.com/GavinYangAI/Comote/releases/download/v0.3.0/Comote-0.3.0.dmg",
        },
      ],
      body: "new things",
    }),
  );
  const checker = new VersionChecker({
    currentVersion: "0.2.0",
    fetchImpl,
    now: () => 1000,
    platform: "darwin",
    arch: "arm64",
  });

  const result = await checker.checkNow();

  assert.equal(result.current, "0.2.0");
  assert.equal(result.latest, "0.3.0");
  assert.equal(result.hasUpdate, true);
  assert.equal(result.releaseUrl, "https://github.com/GavinYangAI/Comote/releases/tag/v0.3.0");
  assert.equal(result.releasesUrl, "https://github.com/GavinYangAI/Comote/releases");
  assert.equal(result.downloadUrl, "https://github.com/GavinYangAI/Comote/releases/download/v0.3.0/Comote-0.3.0.dmg");
  assert.equal(result.checkedAt, 1000);
  assert.equal(result.error, null);
});

test("checkNow calls the current Comote repository release API", async () => {
  const fetchImpl = makeFetch(jsonResponse({ tag_name: "v0.2.0", html_url: "x" }));
  const checker = new VersionChecker({ currentVersion: "0.2.0", fetchImpl, now: () => 1 });

  await checker.checkNow();

  assert.equal(fetchImpl.calls[0].url, "https://api.github.com/repos/GavinYangAI/Comote/releases/latest");
});

test("selectDownloadUrl picks the platform asset before falling back to the release page", () => {
  const assets = [
    {
      name: "Comote-0.3.0-setup.exe",
      browser_download_url: "https://github.com/GavinYangAI/Comote/releases/download/v0.3.0/Comote-0.3.0-setup.exe",
    },
    {
      name: "Comote-0.3.0.dmg",
      browser_download_url: "https://github.com/GavinYangAI/Comote/releases/download/v0.3.0/Comote-0.3.0.dmg",
    },
  ];

  assert.equal(
    selectDownloadUrl(assets, { platform: "darwin", arch: "arm64", fallbackUrl: "release-page" }),
    "https://github.com/GavinYangAI/Comote/releases/download/v0.3.0/Comote-0.3.0.dmg",
  );
  assert.equal(selectDownloadUrl([], { fallbackUrl: "release-page" }), "release-page");
});

test("checkNow reports no update when local matches the latest release", async () => {
  const fetchImpl = makeFetch(jsonResponse({ tag_name: "v0.2.0", html_url: "x" }));
  const checker = new VersionChecker({ currentVersion: "0.2.0", fetchImpl, now: () => 1 });
  const result = await checker.checkNow();
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latest, "0.2.0");
});

test("checkNow tolerates a missing release (404) without raising error", async () => {
  const fetchImpl = makeFetch(jsonResponse({ message: "Not Found" }, { status: 404 }));
  const checker = new VersionChecker({ currentVersion: "0.2.0", fetchImpl, now: () => 42 });
  const result = await checker.checkNow();
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latest, null);
  assert.equal(result.error, null);
  assert.equal(result.checkedAt, 42);
});

test("checkNow surfaces network errors without crashing", async () => {
  const fetchImpl = makeFetch(new Error("offline"));
  const checker = new VersionChecker({ currentVersion: "0.2.0", fetchImpl, now: () => 99 });
  const result = await checker.checkNow();
  assert.match(result.error, /offline/);
  assert.equal(result.hasUpdate, false);
});

test("checkNow honors the in-memory cache TTL and only fetches once", async () => {
  let n = 1000;
  const fetchImpl = makeFetch(jsonResponse({ tag_name: "v0.3.0", html_url: "x" }));
  const checker = new VersionChecker({ currentVersion: "0.2.0", fetchImpl, now: () => n });

  await checker.checkNow();
  n += 60 * 1000; // 1 minute later
  await checker.checkNow();

  assert.equal(fetchImpl.calls.length, 1);
});

test("checkNow with force=true bypasses the cache", async () => {
  const fetchImpl = makeFetch([
    jsonResponse({ tag_name: "v0.3.0", html_url: "x" }),
    jsonResponse({ tag_name: "v0.4.0", html_url: "y" }),
  ]);
  const checker = new VersionChecker({ currentVersion: "0.2.0", fetchImpl, now: () => 1 });

  await checker.checkNow();
  const second = await checker.checkNow({ force: true });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(second.latest, "0.4.0");
});

test("checkNow persists and restores its result via cacheFilePath", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-version-cache-"));
  const cacheFilePath = join(dir, "version-cache.json");
  try {
    const fetchImpl = makeFetch(jsonResponse({ tag_name: "v0.3.0", html_url: "x" }));
    const checker = new VersionChecker({
      currentVersion: "0.2.0",
      fetchImpl,
      cacheFilePath,
      now: () => 1000,
    });
    await checker.checkNow();

    const persisted = JSON.parse(await readFile(cacheFilePath, "utf8"));
    assert.equal(persisted.latest, "0.3.0");

    // A fresh checker loads the previous result from disk.
    const reload = new VersionChecker({
      currentVersion: "0.2.0",
      fetchImpl: makeFetch(jsonResponse({ tag_name: "v0.9.0", html_url: "z" })),
      cacheFilePath,
      now: () => 2000,
    });
    await reload.loadCache();
    assert.equal(reload.getLastResult().latest, "0.3.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCache ignores cache from a different installed version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-version-cache-"));
  const cacheFilePath = join(dir, "version-cache.json");
  try {
    const stale = new VersionChecker({
      currentVersion: "0.1.0",
      fetchImpl: makeFetch(jsonResponse({ tag_name: "v0.1.5", html_url: "x" })),
      cacheFilePath,
      now: () => 1000,
    });
    await stale.checkNow();

    const fresh = new VersionChecker({
      currentVersion: "0.2.0",
      fetchImpl: makeFetch(jsonResponse({ tag_name: "v0.3.0", html_url: "y" })),
      cacheFilePath,
      now: () => 2000,
    });
    await fresh.loadCache();
    // Cache was from 0.1.0, not applicable; current state is empty.
    assert.equal(fresh.getLastResult().latest, null);
    assert.equal(fresh.getLastResult().checkedAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
