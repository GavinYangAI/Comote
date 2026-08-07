import { basename, isAbsolute, win32 } from "node:path";

function normalizePath(path) {
  return path.replace(/[\\/]+$/, "") || "/";
}

function isAbsolutePath(value) {
  return typeof value === "string" && (isAbsolute(value) || win32.isAbsolute(value));
}

function pathName(path) {
  return win32.isAbsolute(path) ? win32.basename(path) : basename(path);
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
    for (const project of list) {
      const path = normalizePath(project.path);
      let id = this._pathToId.get(path);
      if (id === undefined) {
        id = String(this._nextId++);
        this._pathToId.set(path, id);
      }
      next.push({
        id,
        name: project.name ?? pathName(path) ?? path,
        path,
        source: project.source ?? "codex-desktop",
        status: project.status ?? "available",
      });
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
        name: pathName(path) || path,
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
