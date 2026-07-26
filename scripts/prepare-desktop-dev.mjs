import { fileURLToPath } from "node:url";

const DEFAULT_VERSION_URL = "http://127.0.0.1:16208/api/version";

export async function stopExistingDevelopmentDaemon({
  versionUrl = DEFAULT_VERSION_URL,
  fetchImpl = globalThis.fetch,
  killImpl = (pid) => process.kill(pid, "SIGTERM"),
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = 5000,
  pollIntervalMs = 100,
} = {}) {
  const daemon = await readDaemon(versionUrl, fetchImpl);
  if (!daemon) return { stopped: false, pid: null };

  const pid = Number(daemon.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(
      `Port 16208 is already serving Comote ${daemon.version ?? "(unknown version)"}, but it did not report a valid pid. Quit Comote before running desktop:dev.`,
    );
  }

  try {
    killImpl(pid);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw new Error(
        `Could not stop the existing Comote daemon (pid ${pid}): ${error?.message ?? error}. Quit Comote before running desktop:dev.`,
      );
    }
  }

  const attempts = Math.max(1, Math.ceil(waitMs / pollIntervalMs));
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (!(await isReachable(versionUrl, fetchImpl))) {
      console.log(`Stopped existing Comote development daemon (pid ${pid})`);
      return { stopped: true, pid };
    }
    if (attempt < attempts) await sleepImpl(pollIntervalMs);
  }

  throw new Error(
    `Existing Comote daemon (pid ${pid}) did not release port 16208. Quit Comote before running desktop:dev.`,
  );
}

async function readDaemon(versionUrl, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(versionUrl, { signal: AbortSignal.timeout(1000) });
  } catch {
    return null;
  }
  if (!response?.ok) {
    throw new Error(`Port 16208 is occupied, but ${versionUrl} did not return a successful Comote response.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Port 16208 is occupied, but ${versionUrl} did not return valid JSON.`);
  }
}

async function isReachable(versionUrl, fetchImpl) {
  try {
    await fetchImpl(versionUrl, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await stopExistingDevelopmentDaemon();
}
