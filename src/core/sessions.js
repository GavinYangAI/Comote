function makeId(prefix, nextId) {
  return `${prefix}_${String(nextId).padStart(4, "0")}`;
}

// Extracts the numeric suffix from a "session_NNNN" id, or 0 if the id does not
// match our generated pattern (e.g. external thread ids).
function parseSessionIdNumber(id) {
  const match = /^session_(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

// Composite key for the per-identity active-session pointer. NUL cannot
// appear in either an identityKey ("channel:stableId") or a filesystem path,
// so the join is unambiguous.
function identityProjectKey(identityKey, projectPath) {
  return `${identityKey}\u0000${projectPath}`;
}

export class SessionStore {
  // `sessions` accepts either the legacy persisted shape (a flat array of
  // session objects) or the current one ({ sessions, activeByIdentity }).
  // Legacy snapshots restore with an empty per-identity pointer map, so each
  // IM identity simply re-picks a session once after the upgrade.
  constructor({ sessions = [] } = {}) {
    const persisted = Array.isArray(sessions) ? { sessions } : sessions ?? {};
    this.sessionsByProject = new Map();
    // Global pointer: one active session per project, used by identity-less
    // callers (desktop UI / server paths and the restore loop below).
    this.activeByProject = new Map();
    // Per-identity pointer: `${identityKey}\0${projectPath}` -> sessionId.
    // IM commands read/write this so user A's /use can never redirect user B's
    // messages into A's session (B-6).
    this.activeByIdentity = new Map(persisted.activeByIdentity ?? []);
    this.nextId = 1;
    for (const session of persisted.sessions ?? []) {
      this.upsertExternalSession(session);
      // Seed nextId past any rehydrated session_NNNN id so freshly created
      // sessions never collide with reloaded ones on the synchronous /new path.
      const existingNumber = parseSessionIdNumber(session.id);
      if (existingNumber >= this.nextId) {
        this.nextId = existingNumber + 1;
      }
    }
  }

  // Moves the active pointer. The global pointer always follows (it is the
  // "most recent activity" view for identity-less callers); the per-identity
  // pointer additionally records who this session belongs to.
  setActive(projectPath, sessionId, identityKey = null) {
    this.activeByProject.set(projectPath, sessionId);
    if (identityKey) {
      this.activeByIdentity.set(identityProjectKey(identityKey, projectPath), sessionId);
    }
  }

  createSession({ projectPath, title, firstMessage, identityKey = null }) {
    if (!projectPath) {
      throw new Error("projectPath is required");
    }
    const session = {
      id: makeId("session", this.nextId++),
      projectPath,
      title: title || firstMessage || "Untitled session",
      state: "idle",
      messages: firstMessage ? [{ role: "user", text: firstMessage }] : [],
      updatedAt: new Date().toISOString(),
    };

    const sessions = this.sessionsByProject.get(projectPath) ?? [];
    sessions.push(session);
    this.sessionsByProject.set(projectPath, sessions);
    this.setActive(projectPath, session.id, identityKey);
    return { ...session, messages: [...session.messages] };
  }

  upsertExternalSession({ projectPath, id, title, state = "idle", messages = [], identityKey = null }) {
    if (!projectPath || !id) {
      throw new Error("projectPath and id are required");
    }
    const sessions = this.sessionsByProject.get(projectPath) ?? [];
    const existing = sessions.find((session) => session.id === id);
    if (existing) {
      existing.title = title ?? existing.title;
      existing.state = state ?? existing.state;
      existing.updatedAt = new Date().toISOString();
      this.setActive(projectPath, existing.id, identityKey);
      return { ...existing, messages: [...existing.messages] };
    }

    const session = {
      id,
      projectPath,
      title: title || id,
      state,
      messages: [...messages],
      updatedAt: new Date().toISOString(),
      external: true,
    };
    sessions.push(session);
    this.sessionsByProject.set(projectPath, sessions);
    this.setActive(projectPath, session.id, identityKey);
    return { ...session, messages: [...session.messages] };
  }

  updateExternalSessionTitle(id, title) {
    if (!id || typeof title !== "string" || !title.trim()) {
      return false;
    }
    for (const sessions of this.sessionsByProject.values()) {
      const session = sessions.find((candidate) => candidate.id === id);
      if (!session) {
        continue;
      }
      session.title = title.trim();
      session.updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  listSessions(projectPath) {
    return (this.sessionsByProject.get(projectPath) ?? []).map((session) => ({
      ...session,
      messages: [...session.messages],
    }));
  }

  useSession(projectPath, sessionIdOrNumber, identityKey = null) {
    const sessions = this.sessionsByProject.get(projectPath) ?? [];
    const byNumber = sessions[Number(sessionIdOrNumber) - 1];
    const session = sessions.find((candidate) => candidate.id === sessionIdOrNumber) ?? byNumber;
    if (!session) {
      throw new Error(`unknown session: ${sessionIdOrNumber}`);
    }
    this.setActive(projectPath, session.id, identityKey);
    return { ...session, messages: [...session.messages] };
  }

  getActiveSession(projectPath, identityKey = null) {
    // Identity-scoped reads are strict: only the identity's own pointer counts.
    // Falling back to the global pointer here would recreate the cross-user
    // leak (user B silently continuing user A's session) this map exists to fix.
    const activeId = identityKey
      ? this.activeByIdentity.get(identityProjectKey(identityKey, projectPath)) ?? null
      : this.activeByProject.get(projectPath);
    if (!activeId) {
      return null;
    }
    const session = (this.sessionsByProject.get(projectPath) ?? []).find(
      (candidate) => candidate.id === activeId,
    );
    return session ? { ...session, messages: [...session.messages] } : null;
  }

  snapshot() {
    return {
      sessions: Array.from(this.sessionsByProject.values())
        .flat()
        .map((session) => ({ ...session, messages: [...session.messages] })),
      activeByIdentity: [...this.activeByIdentity],
    };
  }
}
