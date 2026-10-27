function normalizePath(path) {
  return path.replace(/\/+$/, "") || "/";
}

function isAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/");
}

export class ProjectStore {
  constructor({ projects = [] } = {}) {
    // Stable id map: path -> id, so the same path always gets the same number
    // across refreshes (critical for /open <number> stability).
    this._pathToId = new Map();
    this._nextId = 1;
    this.projects = [];
    this._replace(projects);
  }

  // Replace the full project list with a fresh set from Codex Desktop.
  // Paths that were seen before keep their existing id; new paths get the
  // next sequential id.
  replaceProjects(list) {
    this._replace(list);
  }

  _replace(list) {
    const next = [];
    const byPath = new Map();
    for (const project of list) {
      const path = normalizePath(project.path);
      // Several Codex Desktop projects can share one root; the store is keyed
      // by path, so they collapse into one entry carrying all their names.
      const existing = byPath.get(path);
      if (existing) {
        if (project.name && !existing.name.split(" / ").includes(project.name)) {
          existing.name = `${existing.name} / ${project.name}`;
        }
        continue;
      }
      let id = this._pathToId.get(path);
      if (id === undefined) {
        id = String(this._nextId++);
        this._pathToId.set(path, id);
      }
      const entry = {
        id,
        name: project.name ?? path.split("/").filter(Boolean).at(-1) ?? path,
        path,
        source: project.source ?? "codex-desktop",
        status: project.status ?? "available",
      };
      byPath.set(path, entry);
      next.push(entry);
    }
    this.projects = next;
  }

  listProjects() {
    return this.projects.map((project) => ({ ...project }));
  }

  resolveProject(selector) {
    if (isAbsolutePath(selector)) {
      const path = normalizePath(selector);
      return {
        id: "path",
        name: path.split("/").filter(Boolean).at(-1) ?? path,
        path,
        source: "direct",
        status: "available",
      };
    }

    const project = this.listProjects().find((candidate) => candidate.id === selector);
    if (!project) {
      throw new Error(`找不到项目：${selector}`);
    }
    return project;
  }
}
