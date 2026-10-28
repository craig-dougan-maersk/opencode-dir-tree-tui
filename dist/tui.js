// @bun
// src/tui.tsx
import { createComponent as _$createComponent3 } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { Show as Show3 } from "solid-js";

// src/tree.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { isAbsolute, join as joinPath, posix as posix2, relative } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { Buffer as Buffer2 } from "buffer";

// src/config.ts
import { posix, resolve, win32 } from "path";
var RULE_LIMIT = 65536;
var CONFIG_STORAGE_KEY = "dir-tree.config";
var MOUSE_BUTTONS = ["left", "middle", "right"];
var MOUSE_ACTIONS = [
  { id: "openFile", label: "Open file", target: "file" },
  { id: "copyFilePath", label: "Copy file path", target: "file" },
  { id: "openFolder", label: "Open folder", target: "folder" },
  { id: "copyFolderPath", label: "Copy folder path", target: "folder" },
  { id: "toggleFolder", label: "Expand/collapse folder", target: "folder" }
];
var DEFAULT_MOUSE_BINDINGS = {
  openFile: "right",
  copyFilePath: "middle",
  openFolder: "right",
  copyFolderPath: "middle",
  toggleFolder: "left"
};
var DEFAULT_SETTINGS = { visible: true };
function normalizeKey(path) {
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/i.test(path);
  const normalized = windows ? win32.normalize(path).replaceAll("\\", "/") : posix.normalize(path);
  const key = /^[a-z]:\/$/i.test(normalized) ? normalized : normalized.replace(/\/+$/, "") || "/";
  return windows && process.platform === "win32" ? key.toLowerCase() : key;
}
var projectKey = (root) => normalizeKey(resolve(root));
var rulesText = (lines) => lines.length ? `${lines.join(`
`)}
` : "";
function validateRules(lines) {
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string" || /[\r\n\0]/.test(line))) {
    throw new Error("ignore must be an array of single-line strings (no NUL)");
  }
  if (Buffer.byteLength(rulesText(lines)) > RULE_LIMIT)
    throw new Error("Project ignore rules exceed 64 KiB");
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateConfig(data) {
  if (!isObject(data) || !isObject(data.projects))
    throw new Error("Stored configuration projects must be an object");
  const keys = new Set;
  for (const [key, project] of Object.entries(data.projects)) {
    const normalized = normalizeKey(key);
    if (keys.has(normalized))
      throw new Error(`Duplicate stored project path: ${key}`);
    keys.add(normalized);
    if (!isObject(project))
      throw new Error(`Project ${key} must be an object`);
    if (project.ignore !== undefined)
      validateRules(project.ignore);
    if (project.visible !== undefined && typeof project.visible !== "boolean")
      throw new Error("Project visible must be a boolean");
  }
}
function entry(data, root) {
  const normalized = projectKey(root);
  const key = Object.keys(data.projects).find((key) => normalizeKey(key) === normalized) ?? normalized;
  return { key, project: data.projects[key] };
}
function snapshot(data, root) {
  const { project } = entry(data, root);
  return {
    lines: [...project?.ignore ?? []],
    text: JSON.stringify(data, null, 2),
    configured: project !== undefined,
    settings: { visible: project?.visible ?? true }
  };
}

class ConfigStore {
  data;
  save;
  constructor(storage) {
    const [data, save] = storage.store(CONFIG_STORAGE_KEY, { initial: { projects: {} } });
    this.data = data;
    this.save = save;
  }
  read(root) {
    validateConfig(this.data);
    return snapshot(this.data, root);
  }
  async update(root, change) {
    if (!["add", "remove", "visibility"].includes(change.kind))
      throw new Error("Invalid project configuration change");
    if (change.kind === "add")
      validateRules([change.line]);
    if (change.kind === "visibility" && change.value !== undefined && typeof change.value !== "boolean")
      throw new Error("visible must be a boolean");
    this.read(root);
    let saved;
    await this.save((draft) => {
      validateConfig(draft);
      const current = snapshot(draft, root);
      const { key, project } = entry(draft, root);
      const next = { ...project };
      if (change.kind === "visibility") {
        next.visible = change.value ?? !current.settings.visible;
        if (next.visible === current.settings.visible) {
          saved = { ...current, changed: false };
          return;
        }
      } else {
        next.ignore = [...current.lines];
        if (change.kind === "add") {
          if (!next.ignore.includes(change.line))
            next.ignore.push(change.line);
        } else {
          if (change.expected.length !== current.lines.length || change.expected.some((line, index) => line !== current.lines[index])) {
            throw new Error("Rules changed in another terminal; review the list before deleting");
          }
          if (!Number.isInteger(change.index) || change.index < 0 || change.index >= next.ignore.length)
            throw new Error("No rule selected");
          next.ignore.splice(change.index, 1);
        }
        validateRules(next.ignore);
      }
      const changed = JSON.stringify(next) !== JSON.stringify(project);
      if (changed)
        draft.projects[key] = next;
      saved = { ...snapshot(draft, root), changed };
    });
    return saved;
  }
}

// src/tree.ts
var ROOT = "";
var STORAGE_EXPANDED = "dir-tree.expanded";
var exec = promisify(execFile);
function normalizePath(input) {
  const normalized = (process.platform === "win32" ? input.replaceAll("\\", "/") : input).replace(/\/+$/, "");
  return normalized === "." || normalized === "" ? ROOT : normalized;
}
function sameChildren(a, b) {
  return a !== undefined && a.length === b.length && a.every((node, index) => node === b[index]);
}
function ignoreKey(node) {
  return `${node.isDir ? "directory" : "file"}:${node.absolute}`;
}
function sameStatuses(a, b) {
  return a.size === b.size && [...a].every(([path, status]) => {
    const next = b.get(path);
    return next?.status === status.status && next.code === status.code;
  });
}
function describeError(error) {
  if (error instanceof Error)
    return error.message;
  if (typeof error === "string")
    return error;
  return JSON.stringify(error) ?? String(error);
}
function toNode(raw, directory) {
  const path = normalizePath(raw.path);
  return {
    name: posix2.basename(path),
    path,
    absolute: isAbsolute(path) ? path : normalizePath(joinPath(directory, path)),
    isDir: raw.type === "directory"
  };
}
function compareNodes(a, b) {
  if (a.isDir !== b.isDir)
    return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}
async function git(directory, args, input, env = process.env) {
  const task = exec("git", ["-C", directory, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 1e4,
    maxBuffer: 16 * 1024 * 1024,
    env
  });
  task.child.stdin?.end(input);
  const { stdout } = await task;
  return stdout;
}
function parsePorcelain(out) {
  const rows = [];
  const entries = out.split("\x00");
  for (let i = 0;i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4)
      continue;
    const xy = entry.slice(0, 2);
    if (!/^[ MADRCUTX?!B]{2}$/.test(xy))
      continue;
    if (/[RC]/.test(xy))
      i++;
    const file = entry.slice(3);
    const code = xy[1] === " " ? xy[0] : xy[1];
    const status = xy.includes("U") || xy === "AA" || xy === "DD" ? "conflicting" : xy === "??" ? "untracked" : xy === "!!" ? "ignored" : code === "D" ? "deleted" : code === "A" ? "added" : code === "R" || code === "C" ? "renamed" : "modified";
    rows.push({ path: normalizePath(file), status, code: xy.trim() });
  }
  return rows;
}

class TreeStore {
  context;
  config;
  ignoreText = Buffer2.alloc(0);
  ignoreRoot;
  ignoreLocation;
  ignoreCase = false;
  ignoreVersion = 0;
  ignoreCache = new Map;
  map = new Map;
  rowCache = new Map;
  loading = new Map;
  pendingRefresh = new Set;
  expandedSet = new Set([ROOT]);
  gitStatuses = new Map;
  state;
  updateState;
  refreshTimer;
  refreshTask;
  refreshAgain = false;
  updateExpanded;
  mouse;
  updateMouse;
  activeDirectory;
  generation = 0;
  disposed = false;
  get directory() {
    return this.context.location?.directory;
  }
  constructor(context) {
    this.context = context;
    this.config = new ConfigStore(context.storage);
    const [state, updateState] = context.storage.memory("dir-tree.state", {
      initial: { version: 0, gitVersion: 0, loadError: undefined, settings: { ...DEFAULT_SETTINGS } }
    });
    this.state = state;
    this.updateState = updateState;
    this.updateState((draft) => {
      draft.settings ??= { ...DEFAULT_SETTINGS };
    });
    this.setLoadError(undefined);
    const [mouse, updateMouse] = context.storage.store("dir-tree.mouse", {
      initial: { ...DEFAULT_MOUSE_BINDINGS }
    });
    this.mouse = mouse;
    this.updateMouse = updateMouse;
    const [expanded, updateExpanded] = context.storage.store(STORAGE_EXPANDED, {
      initial: { dirs: [] }
    });
    this.updateExpanded = updateExpanded;
    for (const item of expanded.dirs) {
      if (typeof item === "string")
        this.expandedSet.add(normalizePath(item));
    }
  }
  isExpanded(path) {
    this.state.version;
    return this.expandedSet.has(normalizePath(path));
  }
  loadError() {
    return this.state.loadError;
  }
  isDisposed() {
    return this.disposed;
  }
  setLoadError(error) {
    this.updateState((draft) => {
      draft.loadError = error;
    });
  }
  toggle(path) {
    const key = normalizePath(path);
    if (this.expandedSet.has(key)) {
      this.expandedSet.delete(key);
    } else {
      this.expandedSet.add(key);
      this.requestDirectory(key, this.map.has(key));
      this.scheduleRefresh(0);
    }
    this.persistExpanded(key);
    this.bump();
  }
  gitStatus(node) {
    this.state.gitVersion;
    return this.gitStatuses.get(node.absolute)?.status;
  }
  settings() {
    return this.state.settings;
  }
  mouseBindings() {
    return this.mouse;
  }
  async changeMouseBinding(action, delta) {
    if (!MOUSE_ACTIONS.some(({ id }) => id === action) || delta !== 1 && delta !== -1)
      throw new Error("Invalid mouse binding change");
    const values = action === "toggleFolder" ? MOUSE_BUTTONS : [...MOUSE_BUTTONS, "off"];
    await this.updateMouse((draft) => {
      const index = values.indexOf(draft[action]);
      if (index < 0)
        throw new Error(`Invalid stored mouse binding: ${action}`);
      draft[action] = values[(index + delta + values.length) % values.length];
    });
  }
  applySettings(directory, settings) {
    if (this.disposed || this.directory !== directory)
      return;
    this.updateState((draft) => {
      draft.settings.visible = settings.visible;
    });
  }
  gitStatusCode(node) {
    this.state.gitVersion;
    return this.gitStatuses.get(node.absolute)?.code;
  }
  async fetchGitStatuses() {
    const directory = this.directory;
    if (!directory || this.disposed)
      return;
    const generation = this.generation;
    try {
      const prefix = await git(directory, ["rev-parse", "--show-prefix"]).then((out) => {
        const [prefix = ""] = out.split(/\r?\n/);
        return normalizePath(prefix);
      }, () => {
        return;
      });
      if (generation !== this.generation || this.directory !== directory)
        return;
      if (prefix === undefined)
        return;
      const next = new Map;
      const submodules = [];
      for (const entry of (await git(directory, ["ls-files", "--stage", "--full-name", "-z", "--", "."])).split("\x00")) {
        if (!entry.startsWith("160000 "))
          continue;
        const path = normalizePath(entry.slice(entry.indexOf("\t") + 1));
        const local = prefix === "" ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
        if (local !== undefined)
          submodules.push(local);
      }
      for (const item of parsePorcelain(await git(directory, ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all", "--", "."]))) {
        const path = normalizePath(item.path);
        const local = prefix === "" ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
        if (local !== undefined)
          next.set(normalizePath(joinPath(directory, local)), item);
      }
      const files = this.visibleRows().filter(({ node }) => !node.isDir && !next.has(node.absolute) && !submodules.some((path) => node.path === path || node.path.startsWith(`${path}/`))).map(({ node }) => node.path);
      if (files.length) {
        let ignored = "";
        try {
          ignored = await git(directory, ["check-ignore", "-z", "--stdin"], files.join("\x00") + "\x00");
        } catch (error) {
          if (error.code !== 1)
            throw error;
        }
        for (const path of ignored.split("\x00").filter(Boolean))
          next.set(normalizePath(joinPath(directory, path)), { path, status: "ignored", code: "!!" });
      }
      if (generation !== this.generation || this.directory !== directory)
        return;
      if (!sameStatuses(this.gitStatuses, next)) {
        this.gitStatuses = next;
        this.updateState((draft) => {
          draft.gitVersion++;
        });
      }
    } catch {}
  }
  persistExpanded(key, descendants = false) {
    this.updateExpanded((draft) => {
      if (!Array.isArray(draft.dirs) || draft.dirs.some((dir) => typeof dir !== "string"))
        throw new Error("Invalid stored expanded directories");
      const dirs = new Set(draft.dirs.map(normalizePath));
      if (this.expandedSet.has(key))
        dirs.add(key);
      else
        for (const dir of dirs)
          if (dir === key || descendants && dir.startsWith(`${key}/`))
            dirs.delete(dir);
      draft.dirs = [...dirs];
    }).catch((error) => {
      this.context.ui.toast.show({ variant: "error", title: "Dir Tree", message: `Could not save expanded folders: ${describeError(error)}`, duration: 5000 });
    });
  }
  async filterNodes(dir, nodes) {
    const text = this.ignoreText;
    const ignoreCase = this.ignoreCase;
    const root = this.ignoreRoot;
    if (!text.length || !root || !nodes.length)
      return nodes;
    const cache = this.ignoreCache;
    const signature = JSON.stringify(nodes.map(ignoreKey).sort());
    const cached = cache.get(dir);
    if (cached?.signature === signature)
      return nodes.filter((node) => !cached.hidden.has(ignoreKey(node)));
    const candidates = nodes.map((node) => ({ node, path: normalizePath(relative(root, node.absolute)) })).filter(({ path }) => path && path !== ".." && !path.startsWith("../") && !isAbsolute(path) && !path.includes("\x00"));
    if (!candidates.length)
      return nodes;
    const temporary = joinPath(tmpdir(), "opencode");
    mkdirSync(temporary, { recursive: true });
    const sandbox = mkdtempSync(joinPath(temporary, "dir-tree-ignore-"));
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.toUpperCase().startsWith("GIT_"))
        delete env[key];
    const hidden = new Set;
    try {
      await git(sandbox, ["init", "--bare", "--quiet", "--template=", "repo"], undefined, env);
      const rules = joinPath(sandbox, "rules");
      writeFileSync(rules, new Uint8Array(text.buffer, text.byteOffset, text.byteLength));
      for (const isDir of [false, true]) {
        const group = candidates.filter(({ node }) => node.isDir === isDir);
        if (!group.length)
          continue;
        const worktree = joinPath(sandbox, isDir ? "dirs" : "files");
        mkdirSync(worktree);
        if (isDir)
          for (const { path } of group)
            mkdirSync(joinPath(worktree, path), { recursive: true });
        let output;
        try {
          output = await git(worktree, [
            `--git-dir=${joinPath(sandbox, "repo")}`,
            `--work-tree=${worktree}`,
            "-c",
            `core.excludesFile=${rules}`,
            "-c",
            `core.ignorecase=${ignoreCase}`,
            "check-ignore",
            "--no-index",
            "-z",
            "--stdin"
          ], group.map(({ path }) => path).join("\x00") + "\x00", env);
        } catch (error) {
          if (error.code !== 1)
            throw error;
          output = "";
        }
        const ignored = new Set(output.split("\x00").filter(Boolean));
        for (const { node, path } of group)
          if (ignored.has(path))
            hidden.add(node);
      }
      cache.set(dir, { signature, hidden: new Set([...hidden].map(ignoreKey)) });
      return nodes.filter((node) => !hidden.has(node));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
  async reloadConfig(directory, generation) {
    let root = this.ignoreLocation === directory ? this.ignoreRoot : undefined;
    try {
      const info = await this.context.client.location.get({ location: { directory } });
      if (this.disposed || generation !== this.generation || this.directory !== directory)
        return;
      root = info.project.directory;
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.directory !== directory)
        return;
      if (!root)
        throw new Error(`Could not determine project root: ${describeError(error)}`);
    }
    const config = this.config.read(root);
    let ignoreCase = false;
    if (config.lines.length) {
      try {
        ignoreCase = (await git(root, ["config", "--type=bool", "--get", "core.ignorecase"])).trim() === "true";
      } catch (error) {
        if (error.code !== 1)
          throw error;
      }
    }
    if (this.disposed || generation !== this.generation || this.directory !== directory)
      return;
    const fresh = this.config.read(root);
    const text = Buffer2.from(rulesText(fresh.lines));
    if (!text.length)
      ignoreCase = false;
    this.applySettings(directory, fresh.settings);
    this.ignoreLocation = directory;
    const previous = new Uint8Array(this.ignoreText.buffer, this.ignoreText.byteOffset, this.ignoreText.byteLength);
    if (root === this.ignoreRoot && text.equals(previous) && ignoreCase === this.ignoreCase)
      return;
    this.ignoreRoot = root;
    this.ignoreText = text;
    this.ignoreCase = ignoreCase;
    this.ignoreVersion++;
    this.ignoreCache = new Map;
    this.map.clear();
    this.bump();
  }
  syncDirectory(directory) {
    if (this.activeDirectory === directory)
      return;
    this.activeDirectory = directory;
    this.generation++;
    this.refreshTask = undefined;
    this.refreshAgain = false;
    this.map.clear();
    this.ignoreCache = new Map;
    this.loading.clear();
    this.pendingRefresh.clear();
    this.gitStatuses.clear();
    this.applySettings(directory, DEFAULT_SETTINGS);
    this.setLoadError(undefined);
    this.bump();
    this.updateState((draft) => {
      draft.gitVersion++;
    });
  }
  async requestDirectory(dir, force = false) {
    const key = normalizePath(dir);
    const directory = this.directory;
    if (!directory || this.disposed)
      return;
    this.syncDirectory(directory);
    const inFlight = this.loading.get(key);
    if (inFlight) {
      if (force)
        this.pendingRefresh.add(key);
      await inFlight;
      await this.loading.get(key);
      return;
    }
    if (!force && this.map.has(key))
      return;
    const generation = this.generation;
    const task = Promise.resolve().then(async () => {
      try {
        if (generation !== this.generation || this.directory !== directory || this.disposed)
          return;
        if (key === ROOT || this.ignoreLocation !== directory)
          await this.reloadConfig(directory, generation);
        if (generation !== this.generation || this.directory !== directory || this.disposed)
          return;
        if (!this.settings().visible) {
          this.setLoadError(undefined);
          return;
        }
        const result = await this.context.client.file.list({
          location: { directory },
          path: key === ROOT ? "." : key
        });
        if (generation !== this.generation || this.directory !== directory)
          return;
        if (result.data === undefined)
          throw new Error("response contained no data");
        const previous = new Map((this.map.get(key) ?? []).map((node) => [node.path, node]));
        const ignoreVersion = this.ignoreVersion;
        const nodes = await this.filterNodes(key, result.data.map((entry) => toNode(entry, directory)));
        if (generation !== this.generation || this.directory !== directory || this.disposed)
          return;
        if (ignoreVersion !== this.ignoreVersion) {
          this.pendingRefresh.add(key);
          return;
        }
        const fresh = nodes.sort(compareNodes).map((node) => {
          const old = previous.get(node.path);
          return old?.isDir === node.isDir ? old : node;
        });
        if (!sameChildren(this.map.get(key), fresh)) {
          this.map.set(key, fresh);
          this.bump();
        }
        this.setLoadError(undefined);
      } catch (error) {
        if (generation === this.generation && this.directory === directory)
          this.handleFailure(key, error);
      } finally {
        if (generation === this.generation) {
          this.loading.delete(key);
          if (this.pendingRefresh.delete(key) && !this.disposed)
            this.requestDirectory(key, true);
        }
      }
    });
    this.loading.set(key, task);
    await task;
  }
  handleFailure(key, error) {
    if (this.map.size === 0) {
      this.setLoadError(`Could not load tree (${describeError(error)})`);
      return;
    }
    const directory = this.directory;
    if (key !== ROOT && directory && existsSync(directory) && !existsSync(joinPath(directory, key))) {
      this.removeDirectory(key);
      this.bump();
    } else {
      const message = `Failed to list "${key || "."}": ${describeError(error)}`;
      this.setLoadError(message);
      this.context.ui.toast.show({ variant: "error", title: "Dir Tree", message, duration: 5000 });
    }
  }
  removeDirectory(key) {
    const prefix = `${key}/`;
    for (const entries of [this.map, this.ignoreCache, this.expandedSet]) {
      for (const dir of entries.keys()) {
        if (dir === key || dir.startsWith(prefix))
          entries.delete(dir);
      }
    }
    this.persistExpanded(key, true);
    this.setLoadError(undefined);
  }
  scheduleRefresh(delay) {
    if (this.disposed)
      return;
    if (this.refreshTimer)
      clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshAll();
    }, delay);
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.loading.clear();
    this.pendingRefresh.clear();
    if (this.refreshTimer)
      clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }
  refreshAll() {
    const directory = this.directory;
    if (!directory || this.disposed)
      return Promise.resolve();
    this.syncDirectory(directory);
    if (this.refreshTask) {
      this.refreshAgain = true;
      return this.refreshTask;
    }
    const generation = this.generation;
    const task = Promise.resolve().then(async () => {
      try {
        do {
          if (generation !== this.generation || this.disposed)
            return;
          this.refreshAgain = false;
          await this.refreshVisible(generation);
        } while (this.refreshAgain && generation === this.generation && !this.disposed);
      } finally {
        if (this.refreshTask === task)
          this.refreshTask = undefined;
      }
    });
    this.refreshTask = task;
    return task;
  }
  async refreshVisible(generation) {
    const directory = this.directory;
    if (this.disposed || generation !== this.generation || !directory)
      return;
    await this.requestDirectory(ROOT, true);
    if (this.disposed || generation !== this.generation || this.directory !== directory || this.state.loadError || !this.settings().visible)
      return;
    let frontier = [ROOT];
    const seen = new Set(frontier);
    while (frontier.length) {
      const next = [];
      for (const parent of frontier) {
        for (const node of this.map.get(parent) ?? []) {
          if (!node.isDir || !this.expandedSet.has(node.path) || seen.has(node.path))
            continue;
          seen.add(node.path);
          next.push(node.path);
        }
      }
      for (const dir of next) {
        if (this.disposed || generation !== this.generation || this.directory !== directory)
          return;
        await this.requestDirectory(dir, true);
      }
      frontier = next;
    }
    if (this.disposed || generation !== this.generation || this.directory !== directory)
      return;
    await this.fetchGitStatuses();
  }
  visibleRows() {
    this.state.version;
    const rows = [];
    const alive = new Map;
    const walk = (dir, depth) => {
      const children = this.map.get(dir);
      if (!children)
        return;
      for (const node of children) {
        const cached = this.rowCache.get(node);
        const row = cached?.depth === depth ? cached : { node, depth };
        alive.set(node, row);
        rows.push(row);
        if (node.isDir && this.expandedSet.has(node.path)) {
          walk(node.path, depth + 1);
        }
      }
    };
    walk(ROOT, 0);
    this.rowCache = alive;
    return rows;
  }
  bump() {
    this.updateState((draft) => {
      draft.version++;
    });
  }
}

// src/components/dir-tree-panel.tsx
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show, createMemo, onCleanup } from "solid-js";
import { spawn } from "child_process";
import { join } from "path";
import { MouseButton, RGBA, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core";
var GIT_STATUS_COLORS = {
  added: RGBA.fromHex("#73c991"),
  untracked: RGBA.fromHex("#73c991"),
  renamed: RGBA.fromHex("#73c991"),
  modified: RGBA.fromHex("#e2c08d"),
  deleted: RGBA.fromHex("#c74e39"),
  conflicting: RGBA.fromHex("#c74e39"),
  ignored: RGBA.fromHex("#8c8c8c")
};
function openPath(absolutePath) {
  const cmd = process.platform === "win32" ? [join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), absolutePath.replaceAll("/", "\\")] : [process.platform === "darwin" ? "open" : "xdg-open", absolutePath];
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd[0], cmd.slice(1), {
        detached: true,
        stdio: "ignore"
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}
function DirTreePanel(props) {
  const rows = createMemo(() => props.store.visibleRows());
  const clipboard = createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(props.store.context.renderer)
  });
  onCleanup(() => {
    clipboard.dispose();
  });
  const rowText = (node, depth) => {
    const indent = "  ".repeat(depth);
    const marker = node.isDir ? props.store.isExpanded(node.path) ? "\u25BE " : "\u25B8 " : "  ";
    return indent + marker + node.name;
  };
  const rowColor = (node) => {
    if (node.isDir)
      return props.theme().text.formfield.selected;
    const status = props.store.gitStatus(node);
    return status ? GIT_STATUS_COLORS[status] : props.theme().text.base;
  };
  const showError = (message, error) => props.store.context.ui.toast.show({
    variant: "error",
    title: "Dir Tree",
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
    duration: 5000
  });
  const showSuccess = (message) => props.store.context.ui.toast.show({
    variant: "success",
    title: "Dir Tree",
    message,
    duration: 1500
  });
  const open = (node) => {
    openPath(node.absolute).then(() => showSuccess(node.isDir ? "Opening folder" : "Opening file"), (error) => showError(`Could not open ${node.name}`, error));
  };
  const openProject = async (copy = false) => {
    try {
      const location = props.store.context.location;
      if (!location)
        throw new Error("Workspace is not available");
      const info = await props.store.context.client.location.get({
        location
      });
      if (copy) {
        await copyPath({
          name: "project folder",
          path: "",
          isDir: true,
          absolute: process.platform === "win32" ? info.project.directory.replaceAll("\\", "/") : info.project.directory
        });
      } else {
        await openPath(info.project.directory);
        showSuccess("Opening project folder");
      }
    } catch (error) {
      showError(copy ? "Could not copy project directory" : "Could not open project directory", error);
    }
  };
  const copyPath = async (node) => {
    try {
      const result = await clipboard.writeText(node.absolute, {
        destination: "best-available"
      });
      if (result.host.status !== "written" && result.terminal.status !== "attempted") {
        throw result.host.status === "failed" ? result.host.error : new Error("Clipboard is not available");
      }
      showSuccess(result.host.status === "written" ? "Path copied" : "Copy request sent");
    } catch (error) {
      showError(`Could not copy ${node.name}`, error);
    }
  };
  const mouseActions = (event, isDir) => {
    const button = event.button === MouseButton.LEFT ? "left" : event.button === MouseButton.MIDDLE ? "middle" : event.button === MouseButton.RIGHT ? "right" : undefined;
    if (!button)
      return [];
    const bindings = props.store.mouseBindings();
    return MOUSE_ACTIONS.filter(({
      id,
      target
    }) => target === (isDir ? "folder" : "file") && bindings[id] === button);
  };
  const onRowMouseDown = (event, node) => {
    event.preventDefault();
    for (const {
      id
    } of mouseActions(event, node.isDir)) {
      if (id === "openFile" || id === "openFolder")
        open(node);
      else if (id === "copyFilePath" || id === "copyFolderPath")
        copyPath(node);
      else if (id === "toggleFolder")
        props.store.toggle(node.path);
    }
  };
  const title = () => props.collapsed() ? "\u25B6 Dir Tree" : "\u25BC Dir Tree";
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("strong");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$insertNode(_el$2, _el$3);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "onMouseDown", (event) => {
      event.preventDefault();
      if (event.button === MouseButton.LEFT || event.button === MouseButton.RIGHT) {
        props.onToggle();
        return;
      }
      for (const {
        id
      } of mouseActions(event, true)) {
        if (id === "openFolder")
          openProject();
        else if (id === "copyFolderPath")
          openProject(true);
        else if (id === "toggleFolder")
          props.onToggle();
      }
    });
    _$insertNode(_el$3, _el$4);
    _$insert(_el$4, title);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return !props.collapsed();
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return props.store.loadError();
          },
          children: (error) => (() => {
            var _el$5 = _$createElement("text");
            _$insert(_el$5, error);
            _$effect((_$p) => _$setProp(_el$5, "style", {
              fg: props.theme().text.feedback.error.base
            }, _$p));
            return _el$5;
          })()
        }), _$createComponent(For, {
          get each() {
            return rows();
          },
          get fallback() {
            return (() => {
              var _el$6 = _$createElement("text");
              _$insertNode(_el$6, _$createTextNode(`No files listed`));
              _$effect((_$p) => _$setProp(_el$6, "style", {
                fg: props.theme().text.muted
              }, _$p));
              return _el$6;
            })();
          },
          children: (row) => (() => {
            var _el$8 = _$createElement("box"), _el$9 = _$createElement("text");
            _$insertNode(_el$8, _el$9);
            _$setProp(_el$8, "onMouseDown", (event) => onRowMouseDown(event, row.node));
            _$setProp(_el$8, "flexDirection", "row");
            _$setProp(_el$9, "flexGrow", 1);
            _$setProp(_el$9, "flexShrink", 1);
            _$setProp(_el$9, "minWidth", 0);
            _$setProp(_el$9, "wrapMode", "none");
            _$setProp(_el$9, "truncate", true);
            _$insert(_el$9, () => rowText(row.node, row.depth));
            _$insert(_el$8, _$createComponent(Show, {
              get when() {
                return _$memo(() => !!!row.node.isDir)() && props.store.gitStatusCode(row.node);
              },
              children: (code) => (() => {
                var _el$0 = _$createElement("text");
                _$setProp(_el$0, "width", 2);
                _$setProp(_el$0, "flexShrink", 0);
                _$setProp(_el$0, "marginLeft", 1);
                _$setProp(_el$0, "textAlign", "right");
                _$setProp(_el$0, "wrapMode", "none");
                _$insert(_el$0, code);
                _$effect((_$p) => _$setProp(_el$0, "style", {
                  fg: rowColor(row.node)
                }, _$p));
                return _el$0;
              })()
            }), null);
            _$effect((_$p) => _$setProp(_el$9, "style", {
              fg: rowColor(row.node)
            }, _$p));
            return _el$8;
          })()
        })];
      }
    }), null);
    _$effect((_$p) => _$setProp(_el$3, "style", {
      fg: props.theme().text.base
    }, _$p));
    return _el$;
  })();
}

// src/components/ignore-dialog.tsx
import { use as _$use } from "@opentui/solid";
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { effect as _$effect2 } from "@opentui/solid";
import { createTextNode as _$createTextNode2 } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { memo as _$memo2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { For as For2, Show as Show2, createEffect, createSignal, onCleanup as onCleanup2 } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton as MouseButton2 } from "@opentui/core";
var dialogs = new WeakMap;
function DirTreeSettingsDialog(props) {
  const context = props.store.context;
  const theme = () => context.theme;
  const dimensions = useTerminalDimensions();
  const [preview, setPreview] = createSignal(false);
  const [settingIndex, setSettingIndex] = createSignal(0);
  const settings = [{
    id: "visible",
    label: "Show file tree",
    category: "Appearance"
  }, ...MOUSE_ACTIONS.map((action) => ({
    ...action,
    category: "Mouse bindings"
  }))];
  let row = 0;
  let category = "";
  const settingRows = settings.map((setting, index) => {
    const heading = setting.category !== category;
    const gap = heading && index > 0 ? 1 : 0;
    if (heading)
      row += 1 + gap;
    category = setting.category;
    return {
      ...setting,
      heading,
      gap,
      row: row++
    };
  });
  const buttonLabels = {
    left: "left-click",
    middle: "middle-click",
    right: "right-click",
    off: "off"
  };
  const rulesTab = () => props.state.tab === "rules";
  const rows = () => preview() ? props.state.previewLines : props.state.lines;
  const viewportHeight = () => Math.max(3, Math.min(14, dimensions().height - 7));
  const digits = () => String(rows().length || 1).length;
  let scroll;
  onCleanup2(() => {
    scroll?.viewport.off("resize", revealSelected);
  });
  const revealSelected = () => {
    if (preview() || !scroll)
      return;
    const selected = rulesTab() ? props.state.selected : settingRows[settingIndex()]?.row ?? 0;
    const top = selected < scroll.scrollTop ? selected : selected >= scroll.scrollTop + viewportHeight() ? selected - viewportHeight() + 1 : scroll.scrollTop;
    const length = rulesTab() ? props.state.lines.length : settingRows.at(-1).row + 1;
    scroll.scrollTo(Math.max(0, Math.min(top, length - viewportHeight())));
  };
  createEffect(() => {
    props.state.selected;
    props.state.tab;
    settingIndex();
    revealSelected();
  });
  const move = (delta) => {
    if (!props.onReload())
      return;
    if (preview())
      scroll?.scrollBy(delta);
    else if (rulesTab())
      props.onMove(delta);
    else {
      const count = settingRows.length;
      setSettingIndex((index) => (index + delta % count + count) % count);
    }
  };
  const jump = (last) => {
    if (!props.onReload())
      return;
    if (preview())
      scroll?.scrollTo(last ? scroll.scrollHeight : 0);
    else if (rulesTab())
      props.onMove(last ? props.state.lines.length : -props.state.lines.length);
    else
      setSettingIndex(last ? settingRows.length - 1 : 0);
  };
  const togglePreview = () => {
    if (!props.onReload())
      return;
    setPreview((value) => !value);
    if (preview())
      scroll?.scrollTo(0);
  };
  const selectTab = (tab) => {
    if (!props.onReload())
      return;
    setPreview(false);
    props.onTab(tab);
    if (tab === "settings")
      revealSelected();
  };
  const switchTab = () => selectTab(rulesTab() ? "settings" : "rules");
  const selectSetting = (index) => {
    if (props.onReload())
      setSettingIndex(index);
  };
  const changeSetting = (delta, index = settingIndex()) => {
    const setting = settingRows[index];
    if (!setting)
      return;
    props.onChange(setting.id === "visible" ? {
      kind: "visibility"
    } : {
      kind: "mouse",
      action: setting.id,
      delta
    });
  };
  const click = (event, action) => {
    if (event.button !== MouseButton2.LEFT)
      return;
    event.preventDefault();
    action();
  };
  const close = () => {
    props.onReload();
    context.ui.dialog.clear();
  };
  const actions = [{
    key: "a",
    label: "add",
    run: props.onAdd,
    enabled: () => !props.state.busy
  }, {
    key: "d",
    label: "delete",
    run: props.onRemove,
    enabled: () => !!props.state.lines.length && !props.state.busy
  }, {
    key: "p",
    label: "preview",
    run: togglePreview,
    enabled: () => true
  }];
  context.keymap.layer(() => ({
    mode: "modal",
    commands: [{
      id: "dir-tree.ignore.up",
      bind: "up,ctrl+p",
      title: "Previous item",
      run: () => move(-1)
    }, {
      id: "dir-tree.ignore.down",
      bind: "down,ctrl+n",
      title: "Next item",
      run: () => move(1)
    }, {
      id: "dir-tree.ignore.j",
      bind: "j",
      title: "Next rule",
      enabled: rulesTab,
      run: () => move(1)
    }, {
      id: "dir-tree.ignore.k",
      bind: "k",
      title: "Previous rule",
      enabled: rulesTab,
      run: () => move(-1)
    }, {
      id: "dir-tree.ignore.page-up",
      bind: "pageup",
      title: "Page up",
      run: () => move(rulesTab() ? -viewportHeight() : -10)
    }, {
      id: "dir-tree.ignore.page-down",
      bind: "pagedown",
      title: "Page down",
      run: () => move(rulesTab() ? viewportHeight() : 10)
    }, {
      id: "dir-tree.ignore.home",
      bind: "home",
      title: "First item",
      run: () => jump(false)
    }, {
      id: "dir-tree.ignore.end",
      bind: "end",
      title: "Last item",
      run: () => jump(true)
    }, {
      id: "dir-tree.ignore.next-tab",
      bind: "tab",
      title: "Next settings tab",
      run: switchTab
    }, {
      id: "dir-tree.ignore.previous-tab",
      bind: "shift+tab",
      title: "Previous settings tab",
      run: switchTab
    }, {
      id: "dir-tree.ignore.setting-previous",
      bind: "left",
      title: "Previous value",
      enabled: () => !rulesTab() && !props.state.busy,
      run: () => changeSetting(-1)
    }, {
      id: "dir-tree.ignore.setting-next",
      bind: "right",
      title: "Next value",
      enabled: () => !rulesTab() && !props.state.busy,
      run: () => changeSetting(1)
    }, {
      id: "dir-tree.ignore.setting-change",
      bind: "enter",
      title: "Change value",
      enabled: () => !rulesTab() && !props.state.busy,
      run: () => changeSetting(1)
    }, {
      id: "dir-tree.ignore.preview",
      bind: "p",
      title: "Preview configuration",
      enabled: rulesTab,
      run: togglePreview
    }, {
      id: "dir-tree.ignore.add",
      bind: "a",
      title: "Add ignore rule",
      enabled: () => rulesTab() && !preview() && !props.state.busy,
      run: () => void props.onAdd()
    }, {
      id: "dir-tree.ignore.remove",
      bind: "d",
      title: "Delete ignore rule",
      enabled: () => rulesTab() && !preview() && !props.state.busy,
      run: () => props.onRemove()
    }, {
      id: "dir-tree.ignore.close",
      bind: "escape",
      title: "Close",
      run: close
    }]
  }));
  return (() => {
    var _el$ = _$createElement2("box"), _el$2 = _$createElement2("box"), _el$3 = _$createElement2("box"), _el$4 = _$createElement2("text"), _el$5 = _$createElement2("strong"), _el$8 = _$createElement2("text"), _el$0 = _$createElement2("box"), _el$1 = _$createElement2("text"), _el$11 = _$createElement2("scrollbox"), _el$12 = _$createElement2("box");
    _$insertNode2(_el$, _el$2);
    _$insertNode2(_el$, _el$0);
    _$insertNode2(_el$, _el$11);
    _$insertNode2(_el$, _el$12);
    _$setProp2(_el$, "flexDirection", "column");
    _$setProp2(_el$, "paddingBottom", 1);
    _$insertNode2(_el$2, _el$3);
    _$insertNode2(_el$2, _el$8);
    _$setProp2(_el$2, "flexDirection", "row");
    _$setProp2(_el$2, "paddingX", 2);
    _$setProp2(_el$2, "gap", 1);
    _$insertNode2(_el$3, _el$4);
    _$setProp2(_el$3, "flexDirection", "row");
    _$setProp2(_el$3, "flexGrow", 1);
    _$setProp2(_el$3, "flexShrink", 1);
    _$setProp2(_el$3, "minWidth", 0);
    _$insertNode2(_el$4, _el$5);
    _$setProp2(_el$4, "flexShrink", 0);
    _$insert2(_el$5, () => preview() ? "Config preview" : "Dir Tree Sidebar");
    _$insert2(_el$3, _$createComponent2(Show2, {
      get when() {
        return preview();
      },
      get children() {
        var _el$6 = _$createElement2("text");
        _$insertNode2(_el$6, _$createTextNode2(` \xB7 read-only`));
        _$setProp2(_el$6, "flexShrink", 1);
        _$setProp2(_el$6, "minWidth", 0);
        _$setProp2(_el$6, "wrapMode", "none");
        _$setProp2(_el$6, "truncate", true);
        _$effect2((_$p) => _$setProp2(_el$6, "fg", theme().text.muted, _$p));
        return _el$6;
      }
    }), null);
    _$insertNode2(_el$8, _$createTextNode2(`esc`));
    _$setProp2(_el$8, "flexShrink", 0);
    _$setProp2(_el$8, "textAlign", "right");
    _$setProp2(_el$8, "selectable", false);
    _$setProp2(_el$8, "onMouseUp", (event) => click(event, close));
    _$insertNode2(_el$0, _el$1);
    _$setProp2(_el$0, "flexDirection", "row");
    _$setProp2(_el$0, "paddingX", 2);
    _$setProp2(_el$0, "marginTop", 1);
    _$setProp2(_el$0, "gap", 2);
    _$setProp2(_el$0, "height", 1);
    _$setProp2(_el$0, "flexShrink", 0);
    _$insert2(_el$0, _$createComponent2(For2, {
      each: [{
        id: "settings",
        label: "Settings"
      }, {
        id: "rules",
        label: "Ignore Rules"
      }],
      children: (tab) => (() => {
        var _el$13 = _$createElement2("text");
        _$setProp2(_el$13, "flexShrink", 0);
        _$setProp2(_el$13, "selectable", false);
        _$setProp2(_el$13, "onMouseUp", (event) => click(event, () => selectTab(tab.id)));
        _$insert2(_el$13, _$createComponent2(Show2, {
          get when() {
            return props.state.tab === tab.id;
          },
          get fallback() {
            return tab.label;
          },
          get children() {
            var _el$14 = _$createElement2("strong");
            _$insert2(_el$14, () => tab.label);
            return _el$14;
          }
        }));
        _$effect2((_$p) => _$setProp2(_el$13, "fg", props.state.tab === tab.id ? theme().text.formfield.selected : theme().text.muted, _$p));
        return _el$13;
      })()
    }), _el$1);
    _$insertNode2(_el$1, _$createTextNode2(`tab`));
    _$setProp2(_el$1, "flexGrow", 1);
    _$setProp2(_el$1, "textAlign", "right");
    _$setProp2(_el$1, "selectable", false);
    _$setProp2(_el$1, "onMouseUp", (event) => click(event, switchTab));
    _$use((value) => {
      scroll = value;
      value.viewport.on("resize", revealSelected);
    }, _el$11);
    _$setProp2(_el$11, "onSizeChange", revealSelected);
    _$setProp2(_el$11, "marginTop", 1);
    _$setProp2(_el$11, "flexShrink", 0);
    _$setProp2(_el$11, "scrollX", false);
    _$setProp2(_el$11, "scrollbarOptions", {
      visible: false
    });
    _$insert2(_el$11, _$createComponent2(Show2, {
      get when() {
        return rulesTab();
      },
      get fallback() {
        return _$createComponent2(For2, {
          each: settingRows,
          children: (setting, index) => {
            const selected = () => index() === settingIndex();
            return (() => {
              var _el$15 = _$createElement2("box"), _el$18 = _$createElement2("box"), _el$19 = _$createElement2("text"), _el$20 = _$createElement2("text");
              _$insertNode2(_el$15, _el$18);
              _$setProp2(_el$15, "flexDirection", "column");
              _$setProp2(_el$15, "flexShrink", 0);
              _$insert2(_el$15, _$createComponent2(Show2, {
                get when() {
                  return setting.heading;
                },
                get children() {
                  var _el$16 = _$createElement2("text"), _el$17 = _$createElement2("strong");
                  _$insertNode2(_el$16, _el$17);
                  _$setProp2(_el$16, "marginX", 2);
                  _$insert2(_el$17, () => setting.category);
                  _$effect2((_p$) => {
                    var _v$5 = setting.gap, _v$6 = theme().text.formfield.selected;
                    _v$5 !== _p$.e && (_p$.e = _$setProp2(_el$16, "marginTop", _v$5, _p$.e));
                    _v$6 !== _p$.t && (_p$.t = _$setProp2(_el$16, "fg", _v$6, _p$.t));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined
                  });
                  return _el$16;
                }
              }), _el$18);
              _$insertNode2(_el$18, _el$19);
              _$insertNode2(_el$18, _el$20);
              _$setProp2(_el$18, "flexDirection", "row");
              _$setProp2(_el$18, "paddingX", 2);
              _$setProp2(_el$18, "gap", 1);
              _$setProp2(_el$18, "height", 1);
              _$setProp2(_el$18, "flexShrink", 0);
              _$setProp2(_el$18, "onSizeChange", () => {
                if (selected())
                  revealSelected();
              });
              _$setProp2(_el$18, "onMouseMove", () => {
                if (!selected())
                  selectSetting(index());
              });
              _$setProp2(_el$18, "onMouseDown", (event) => click(event, () => selectSetting(index())));
              _$setProp2(_el$18, "onMouseUp", (event) => click(event, () => changeSetting(1, index())));
              _$setProp2(_el$19, "flexGrow", 1);
              _$setProp2(_el$19, "minWidth", 0);
              _$setProp2(_el$19, "wrapMode", "none");
              _$setProp2(_el$19, "truncate", true);
              _$setProp2(_el$19, "selectable", false);
              _$insert2(_el$19, () => setting.label);
              _$setProp2(_el$20, "flexShrink", 0);
              _$setProp2(_el$20, "textAlign", "right");
              _$setProp2(_el$20, "selectable", false);
              _$insert2(_el$20, (() => {
                var _c$ = _$memo2(() => setting.id === "visible");
                return () => _c$() ? props.state.settings.visible ? "on" : "off" : buttonLabels[props.store.mouseBindings()[setting.id]];
              })());
              _$effect2((_p$) => {
                var _v$7 = `dir-tree-setting-${index()}`, _v$8 = selected() ? theme().background.action.primary.focused : undefined, _v$9 = selected() ? theme().text.action.primary.focused : theme().text.base, _v$0 = selected() ? theme().text.action.primary.focused : theme().text.muted;
                _v$7 !== _p$.e && (_p$.e = _$setProp2(_el$18, "id", _v$7, _p$.e));
                _v$8 !== _p$.t && (_p$.t = _$setProp2(_el$18, "backgroundColor", _v$8, _p$.t));
                _v$9 !== _p$.a && (_p$.a = _$setProp2(_el$19, "fg", _v$9, _p$.a));
                _v$0 !== _p$.o && (_p$.o = _$setProp2(_el$20, "fg", _v$0, _p$.o));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined
              });
              return _el$15;
            })();
          }
        });
      },
      get children() {
        return _$createComponent2(For2, {
          get each() {
            return rows();
          },
          get fallback() {
            return (() => {
              var _el$21 = _$createElement2("box"), _el$22 = _$createElement2("text"), _el$23 = _$createElement2("text");
              _$insertNode2(_el$21, _el$22);
              _$insertNode2(_el$21, _el$23);
              _$setProp2(_el$21, "justifyContent", "center");
              _$setProp2(_el$22, "textAlign", "center");
              _$insert2(_el$22, () => preview() ? "No configuration yet" : "No ignore rules");
              _$setProp2(_el$23, "textAlign", "center");
              _$insert2(_el$23, () => preview() ? "Change visibility or add a rule" : "Press a to add a rule");
              _$effect2((_p$) => {
                var _v$1 = viewportHeight(), _v$10 = theme().text.base, _v$11 = theme().text.muted;
                _v$1 !== _p$.e && (_p$.e = _$setProp2(_el$21, "height", _v$1, _p$.e));
                _v$10 !== _p$.t && (_p$.t = _$setProp2(_el$22, "fg", _v$10, _p$.t));
                _v$11 !== _p$.a && (_p$.a = _$setProp2(_el$23, "fg", _v$11, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$21;
            })();
          },
          children: (line, index) => {
            const selected = () => !preview() && index() === props.state.selected;
            return (() => {
              var _el$24 = _$createElement2("box"), _el$25 = _$createElement2("text"), _el$26 = _$createTextNode2(` `), _el$28 = _$createElement2("text");
              _$insertNode2(_el$24, _el$25);
              _$insertNode2(_el$24, _el$28);
              _$setProp2(_el$24, "flexDirection", "row");
              _$setProp2(_el$24, "paddingX", 2);
              _$setProp2(_el$24, "flexShrink", 0);
              _$setProp2(_el$24, "onSizeChange", () => {
                if (selected())
                  revealSelected();
              });
              _$setProp2(_el$24, "onMouseDown", (event) => {
                if (!preview())
                  click(event, () => props.onSelect(index()));
              });
              _$insertNode2(_el$25, _el$26);
              _$setProp2(_el$25, "textAlign", "right");
              _$setProp2(_el$25, "selectable", false);
              _$insert2(_el$25, () => index() + 1, _el$26);
              _$insert2(_el$24, _$createComponent2(Show2, {
                get when() {
                  return !preview();
                },
                get children() {
                  var _el$27 = _$createElement2("text");
                  _$setProp2(_el$27, "width", 2);
                  _$setProp2(_el$27, "selectable", false);
                  _$insert2(_el$27, () => selected() ? "\u276F " : "  ");
                  _$effect2((_$p) => _$setProp2(_el$27, "fg", theme().text.action.primary.focused, _$p));
                  return _el$27;
                }
              }), _el$28);
              _$setProp2(_el$28, "flexGrow", 1);
              _$setProp2(_el$28, "minWidth", 0);
              _$insert2(_el$28, () => line || (preview() ? " " : "(empty line)"));
              _$effect2((_p$) => {
                var _v$12 = `dir-tree-ignore-line-${index()}`, _v$13 = preview() ? undefined : 1, _v$14 = selected() ? theme().background.action.primary.focused : undefined, _v$15 = digits() + 1, _v$16 = selected() ? theme().text.action.primary.focused : theme().text.muted, _v$17 = preview() ? "char" : "none", _v$18 = !preview(), _v$19 = preview(), _v$20 = selected() ? theme().text.action.primary.focused : line.startsWith("#") ? theme().text.muted : theme().text.base;
                _v$12 !== _p$.e && (_p$.e = _$setProp2(_el$24, "id", _v$12, _p$.e));
                _v$13 !== _p$.t && (_p$.t = _$setProp2(_el$24, "height", _v$13, _p$.t));
                _v$14 !== _p$.a && (_p$.a = _$setProp2(_el$24, "backgroundColor", _v$14, _p$.a));
                _v$15 !== _p$.o && (_p$.o = _$setProp2(_el$25, "width", _v$15, _p$.o));
                _v$16 !== _p$.i && (_p$.i = _$setProp2(_el$25, "fg", _v$16, _p$.i));
                _v$17 !== _p$.n && (_p$.n = _$setProp2(_el$28, "wrapMode", _v$17, _p$.n));
                _v$18 !== _p$.s && (_p$.s = _$setProp2(_el$28, "truncate", _v$18, _p$.s));
                _v$19 !== _p$.h && (_p$.h = _$setProp2(_el$28, "selectable", _v$19, _p$.h));
                _v$20 !== _p$.r && (_p$.r = _$setProp2(_el$28, "fg", _v$20, _p$.r));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined,
                n: undefined,
                s: undefined,
                h: undefined,
                r: undefined
              });
              return _el$24;
            })();
          }
        });
      }
    }));
    _$setProp2(_el$12, "flexDirection", "row");
    _$setProp2(_el$12, "paddingX", 2);
    _$setProp2(_el$12, "height", 1);
    _$setProp2(_el$12, "flexShrink", 0);
    _$setProp2(_el$12, "marginTop", 1);
    _$insert2(_el$12, _$createComponent2(Show2, {
      get when() {
        return rulesTab();
      },
      get fallback() {
        return (() => {
          var _el$29 = _$createElement2("text"), _el$30 = _$createElement2("strong"), _el$32 = _$createElement2("span");
          _$insertNode2(_el$29, _el$30);
          _$insertNode2(_el$29, _el$32);
          _$insertNode2(_el$30, _$createTextNode2(`\u2190/\u2192`));
          _$insertNode2(_el$32, _$createTextNode2(` change`));
          _$effect2((_p$) => {
            var _v$21 = theme().text.base, _v$22 = {
              fg: theme().text.muted
            };
            _v$21 !== _p$.e && (_p$.e = _$setProp2(_el$29, "fg", _v$21, _p$.e));
            _v$22 !== _p$.t && (_p$.t = _$setProp2(_el$32, "style", _v$22, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$29;
        })();
      },
      get children() {
        return _$createComponent2(For2, {
          each: actions,
          children: (action, index) => _$createComponent2(Show2, {
            get when() {
              return !preview() || action.key === "p";
            },
            get children() {
              return [_$createComponent2(Show2, {
                get when() {
                  return _$memo2(() => !!!preview())() && index() > 0;
                },
                get children() {
                  var _el$34 = _$createElement2("text");
                  _$insertNode2(_el$34, _$createTextNode2(` \xB7 `));
                  _$setProp2(_el$34, "selectable", false);
                  _$effect2((_$p) => _$setProp2(_el$34, "fg", theme().text.muted, _$p));
                  return _el$34;
                }
              }), (() => {
                var _el$36 = _$createElement2("text"), _el$37 = _$createTextNode2(` `), _el$38 = _$createElement2("span");
                _$insertNode2(_el$36, _el$37);
                _$insertNode2(_el$36, _el$38);
                _$setProp2(_el$36, "flexShrink", 0);
                _$setProp2(_el$36, "wrapMode", "none");
                _$setProp2(_el$36, "selectable", false);
                _$setProp2(_el$36, "onMouseUp", (event) => click(event, action.run));
                _$insert2(_el$36, () => action.key, _el$37);
                _$insert2(_el$38, (() => {
                  var _c$2 = _$memo2(() => !!preview());
                  return () => _c$2() ? "back" : action.label;
                })());
                _$effect2((_p$) => {
                  var _v$23 = action.enabled() ? theme().text.base : theme().text.muted, _v$24 = {
                    fg: theme().text.muted
                  };
                  _v$23 !== _p$.e && (_p$.e = _$setProp2(_el$36, "fg", _v$23, _p$.e));
                  _v$24 !== _p$.t && (_p$.t = _$setProp2(_el$38, "style", _v$24, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$36;
              })()];
            }
          })
        });
      }
    }));
    _$effect2((_p$) => {
      var _v$ = theme().text.base, _v$2 = theme().text.muted, _v$3 = theme().text.muted, _v$4 = viewportHeight();
      _v$ !== _p$.e && (_p$.e = _$setProp2(_el$4, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp2(_el$8, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp2(_el$1, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp2(_el$11, "height", _v$4, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$;
  })();
}
async function openIgnoreDialog(context, store) {
  if (store.isDisposed())
    return;
  const instance = {};
  dialogs.set(context, instance);
  const directory = context.location?.directory;
  if (!directory) {
    context.ui.toast.show({
      variant: "error",
      title: "Dir Tree Sidebar",
      message: "Workspace is not available yet",
      duration: 5000
    });
    return;
  }
  let root;
  try {
    const info = await context.client.location.get({
      location: {
        directory
      }
    });
    root = info.project.directory;
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "Dir Tree Sidebar",
      message: `Could not determine project root: ${error instanceof Error ? error.message : String(error)}`,
      duration: 5000
    });
    return;
  }
  if (store.isDisposed() || context.location?.directory !== directory || dialogs.get(context) !== instance)
    return;
  let config;
  try {
    config = store.config.read(root);
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "Dir Tree Sidebar",
      message: `Could not read configuration: ${error instanceof Error ? error.message : String(error)}`,
      duration: 5000
    });
    return;
  }
  if (context.location?.directory !== directory)
    return;
  const [state, setState] = createStore({
    tab: "settings",
    settings: config.settings,
    lines: [],
    selected: 0,
    previewLines: [],
    busy: false
  });
  let prompting = false;
  const update = (mutation) => setState(produce(mutation));
  const apply = (next, selected = state.selected) => {
    config = next;
    store.applySettings(directory, next.settings);
    update((draft) => {
      draft.settings = next.settings;
      draft.lines = next.lines;
      draft.selected = Math.max(0, Math.min(next.lines.length - 1, selected));
      draft.previewLines = next.text.split(`
`);
    });
  };
  apply(config, 0);
  const toast = (variant, message) => context.ui.toast.show({
    variant,
    title: "Dir Tree Sidebar",
    message,
    duration: variant === "error" ? 5000 : 1500
  });
  const reload = () => {
    try {
      const fresh = store.config.read(root);
      if (fresh.text !== config.text || fresh.configured !== config.configured) {
        apply(fresh);
        store.scheduleRefresh(0);
      }
      return true;
    } catch (error) {
      toast("error", `Could not read configuration: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const move = (delta) => update((draft) => {
    if (!draft.lines.length)
      return;
    draft.selected = Math.max(0, Math.min(draft.lines.length - 1, draft.selected + delta));
  });
  const changeSettings = async (change) => {
    if (state.busy || !reload())
      return;
    update((draft) => {
      draft.busy = true;
    });
    try {
      if (change.kind === "mouse") {
        await store.changeMouseBinding(change.action, change.delta);
      } else {
        const saved = await store.config.update(root, change);
        apply(saved);
        if (saved.changed)
          store.scheduleRefresh(0);
      }
    } catch (error) {
      reload();
      toast("error", `Could not save settings: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      update((draft) => {
        draft.busy = false;
      });
    }
  };
  const remove = async () => {
    if (state.busy)
      return;
    const index = state.selected;
    const expected = [...state.lines];
    if (!reload())
      return;
    if (expected.length !== state.lines.length || expected.some((line, index) => line !== state.lines[index])) {
      toast("error", "Ignore rules changed in another terminal; review the refreshed list and retry deletion");
      return;
    }
    if (index >= state.lines.length)
      return;
    update((draft) => {
      draft.busy = true;
    });
    try {
      const saved = await store.config.update(root, {
        kind: "remove",
        index,
        expected
      });
      apply(saved, index);
      store.scheduleRefresh(0);
      toast("success", "Rule deleted");
    } catch (error) {
      reload();
      toast("error", `Could not save ignore rules: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      update((draft) => {
        draft.busy = false;
      });
    }
  };
  const add = async () => {
    if (state.busy || dialogs.get(context) !== instance || !reload())
      return;
    update((draft) => {
      draft.busy = true;
    });
    prompting = true;
    let restore = false;
    try {
      const value = await context.ui.dialog.prompt({
        title: "Add ignore rule",
        description: ".gitignore pattern \u2014 e.g. node_modules/ or *.log",
        placeholder: "node_modules/"
      });
      restore = context.keymap.mode.current() !== "modal";
      if (value?.trim()) {
        const saved = await store.config.update(root, {
          kind: "add",
          line: value
        });
        apply(saved, saved.lines.indexOf(value));
        store.scheduleRefresh(0);
        toast(saved.changed ? "success" : "info", saved.changed ? "Rule added" : "Rule already exists");
      }
    } catch (error) {
      toast("error", `Could not save ignore rules: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      prompting = false;
      update((draft) => {
        draft.busy = false;
      });
      const here = !store.isDisposed() && context.location?.directory === directory;
      if (here)
        reload();
      if (here && dialogs.get(context) === instance && restore && context.keymap.mode.current() !== "modal") {
        show();
      } else if (dialogs.get(context) === instance) {
        dialogs.delete(context);
      }
    }
  };
  const show = () => {
    context.ui.dialog.show(() => _$createComponent2(DirTreeSettingsDialog, {
      store,
      state,
      onTab: (tab) => update((draft) => {
        draft.tab = tab;
      }),
      onReload: reload,
      onMove: move,
      onSelect: (index) => {
        if (reload())
          update((draft) => {
            draft.selected = Math.min(index, Math.max(0, draft.lines.length - 1));
          });
      },
      onRemove: () => void remove(),
      onAdd: add,
      onChange: (change) => void changeSettings(change)
    }), () => {
      if (!prompting && dialogs.get(context) === instance)
        dialogs.delete(context);
    });
    context.ui.dialog.set({
      size: "large",
      centered: true
    });
  };
  show();
}

// src/tui.tsx
var STORAGE_PANEL = "dir-tree.panel";
var AUTO_REFRESH_MS = 1e4;
var tui_default = Plugin.define({
  id: "opencode-dir-tree-tui",
  setup(context) {
    const store = new TreeStore(context);
    const [panel, updatePanel] = context.storage.memory(STORAGE_PANEL, {
      initial: {
        collapsed: context.options?.collapsedByDefault !== false
      }
    });
    const collapsed = () => panel.collapsed;
    const togglePanel = () => {
      const next = !collapsed();
      updatePanel((draft) => {
        draft.collapsed = next;
      });
      if (!next)
        store.scheduleRefresh(0);
    };
    const unregisters = [
      context.data.on("server.connected", () => store.scheduleRefresh(0)),
      context.data.on("project.updated", () => store.scheduleRefresh(400)),
      context.data.on("filesystem.changed", () => store.scheduleRefresh(400))
    ];
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "dir-tree.ignore",
        title: "Open Dir Tree Sidebar settings",
        group: "Dir Tree",
        palette: true,
        slash: {
          name: "dirtree-sidebar"
        },
        run: () => void openIgnoreDialog(context, store)
      }]
    }));
    const autoRefresh = setInterval(() => {
      if (!collapsed() || !store.settings().visible)
        store.refreshAll();
    }, AUTO_REFRESH_MS);
    store.refreshAll();
    let lastSessionID;
    let lastDirectory;
    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const sessionID = props?.sessionID;
        const directory = context.location?.directory;
        if (lastSessionID !== sessionID || lastDirectory !== directory)
          store.scheduleRefresh(0);
        lastSessionID = sessionID;
        lastDirectory = directory;
        return _$createComponent3(Show3, {
          get when() {
            return store.settings().visible;
          },
          get children() {
            return _$createComponent3(DirTreePanel, {
              store,
              theme: () => context.theme,
              collapsed,
              onToggle: togglePanel
            });
          }
        });
      }
    });
    return () => {
      clearInterval(autoRefresh);
      store.dispose();
      unregisterSlot();
      for (const unregister of unregisters)
        unregister();
    };
  }
});
export {
  tui_default as default
};
