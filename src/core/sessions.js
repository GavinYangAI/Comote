function makeId(prefix, nextId) {
  return `${prefix}_${String(nextId).padStart(4, "0")}`;
}

// Extracts the numeric suffix from a "session_NNNN" id, or 0 if the id does not
// match our generated pattern (e.g. external thread ids).
function parseSessionIdNumber(id) {
  const match = /^session_(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export class SessionStore {
  constructor({ sessions = [] } = {}) {
    this.sessionsByProject = new Map();
    this.activeByProject = new Map();
    this.nextId = 1;
    for (const session of sessions) {
      this.upsertExternalSession(session);
      // Seed nextId past any rehydrated session_NNNN id so freshly created
      // sessions never collide with reloaded ones on the synchronous /new path.
      const existingNumber = parseSessionIdNumber(session.id);
      if (existingNumber >= this.nextId) {
        this.nextId = existingNumber + 1;
      }
    }
  }

  createSession({ projectPath, title, firstMessage }) {
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
    this.activeByProject.set(projectPath, session.id);
    return { ...session, messages: [...session.messages] };
  }

  upsertExternalSession({ projectPath, id, title, state = "idle", messages = [] }) {
    if (!projectPath || !id) {
      throw new Error("projectPath and id are required");
    }
    const sessions = this.sessionsByProject.get(projectPath) ?? [];
    const existing = sessions.find((session) => session.id === id);
    if (existing) {
      existing.title = title ?? existing.title;
      existing.state = state ?? existing.state;
      existing.updatedAt = new Date().toISOString();
      this.activeByProject.set(projectPath, existing.id);
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
    this.activeByProject.set(projectPath, session.id);
    return { ...session, messages: [...session.messages] };
  }

  listSessions(projectPath) {
    return (this.sessionsByProject.get(projectPath) ?? []).map((session) => ({
      ...session,
      messages: [...session.messages],
    }));
  }

  useSession(projectPath, sessionIdOrNumber) {
    const sessions = this.sessionsByProject.get(projectPath) ?? [];
    const byNumber = sessions[Number(sessionIdOrNumber) - 1];
    const session = sessions.find((candidate) => candidate.id === sessionIdOrNumber) ?? byNumber;
    if (!session) {
      throw new Error(`unknown session: ${sessionIdOrNumber}`);
    }
    this.activeByProject.set(projectPath, session.id);
    return { ...session, messages: [...session.messages] };
  }

  getActiveSession(projectPath) {
    const activeId = this.activeByProject.get(projectPath);
    if (!activeId) {
      return null;
    }
    const session = (this.sessionsByProject.get(projectPath) ?? []).find(
      (candidate) => candidate.id === activeId,
    );
    return session ? { ...session, messages: [...session.messages] } : null;
  }

  snapshot() {
    return Array.from(this.sessionsByProject.values())
      .flat()
      .map((session) => ({ ...session, messages: [...session.messages] }));
  }
}
