import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join as joinPath, posix, relative } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Buffer } from "node:buffer"
import type { Plugin } from "@opencode/plugin/tui"
import { ConfigStore, DEFAULT_MOUSE_BINDINGS, DEFAULT_SETTINGS, MOUSE_ACTIONS, MOUSE_BUTTONS, rulesText } from "./config"
import type { MouseAction, MouseBinding, MouseBindings, ProjectSettings } from "./config"

type Context = Plugin.Context

const ROOT = ""
const STORAGE_EXPANDED = "dir-tree.expanded"
const exec = promisify(execFile)

interface TreeState {
  version: number
  gitVersion: number
  loadError: string | undefined
  settings: ProjectSettings
}

export type GitStatus = "added" | "deleted" | "modified" | "renamed" | "untracked" | "ignored" | "conflicting"

export interface TreeNode {
  name: string
  /** Normalized relative path (forward slashes, no trailing slash). "" is the root. */
  path: string
  absolute: string
  isDir: boolean
}

/** V2 `FileSystemEntry` only carries `{ path, type }` — paths relative to the requested location. */
interface FsEntry {
  path: string
  type: "file" | "directory"
}

function normalizePath(input: string): string {
  const normalized = (process.platform === "win32" ? input.replaceAll("\\", "/") : input).replace(/\/+$/, "")
  return normalized === "." || normalized === "" ? ROOT : normalized
}

function sameChildren(a: TreeNode[] | undefined, b: TreeNode[]): boolean {
  return a !== undefined && a.length === b.length && a.every((node, index) => node === b[index])
}

function ignoreKey(node: TreeNode): string {
  return `${node.isDir ? "directory" : "file"}:${node.absolute}`
}

function sameStatuses(a: ReadonlyMap<string, StatusRow>, b: ReadonlyMap<string, StatusRow>): boolean {
  return a.size === b.size && [...a].every(([path, status]) => {
    const next = b.get(path)
    return next?.status === status.status && next.code === status.code
  })
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return JSON.stringify(error) ?? String(error)
}

/** V2 entries contain paths relative to the requested location. */
function toNode(raw: FsEntry, directory: string): TreeNode {
  const path = normalizePath(raw.path)
  return {
    name: posix.basename(path),
    path,
    absolute: isAbsolute(path) ? path : normalizePath(joinPath(directory, path)),
    isDir: raw.type === "directory",
  }
}

/** VS Code order: directories first, then case-insensitive natural name order. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
}

interface StatusRow {
  path: string
  status: GitStatus
  code: string
}

/**
 * Full git status via the git binary — covers untracked (`??`) and staged
 * (`A`) files, which OpenCode's VCS status API does not report.
 */
async function git(directory: string, args: string[], input?: string, env = process.env): Promise<string> {
  const task = exec("git", ["-C", directory, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    env,
  })
  task.child.stdin?.end(input)
  const { stdout } = await task
  return stdout
}

/** Parse `git status --porcelain -z` output. */
export function parsePorcelain(out: string): StatusRow[] {
  const rows: StatusRow[] = []
  const entries = out.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    if (!/^[ MADRCUTX?!B]{2}$/.test(xy)) continue
    // Rename/copy source paths are separate NUL fields, even if they look like XY records.
    if (/[RC]/.test(xy)) i++
    const file = entry.slice(3)
    // VS Code's Explorer prefers working-tree changes over staged changes,
    // and merge conflicts over either (including AA/DD, which contain no U).
    const code = xy[1] === " " ? xy[0] : xy[1]
    const status: GitStatus = xy.includes("U") || xy === "AA" || xy === "DD"
      ? "conflicting"
      : xy === "??" ? "untracked"
        : xy === "!!" ? "ignored"
          : code === "D" ? "deleted"
            : code === "A" ? "added"
              : code === "R" || code === "C" ? "renamed"
                : "modified"
    rows.push({ path: normalizePath(file), status, code: xy.trim() })
  }
  return rows
}

export class TreeStore {
  readonly context: Context
  readonly config: ConfigStore
  private ignoreText = Buffer.alloc(0)
  private ignoreRoot: string | undefined
  private ignoreLocation: string | undefined
  private ignoreCase = false
  private ignoreVersion = 0
  private ignoreCache = new Map<string, { signature: string; hidden: Set<string> }>()
  private map = new Map<string, TreeNode[]>()
  private rowCache = new Map<TreeNode, { node: TreeNode; depth: number }>()
  private loading = new Map<string, Promise<void>>()
  private pendingRefresh = new Set<string>()
  private expandedSet = new Set<string>([ROOT])
  private gitStatuses = new Map<string, StatusRow>()
  private readonly state: TreeState
  private readonly updateState: (mutation: (draft: TreeState) => void) => void
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private refreshTask: Promise<void> | undefined
  private refreshAgain = false
  private updateExpanded: (mutation: (draft: { dirs: string[] }) => void) => Promise<void>
  private readonly mouse: MouseBindings
  private readonly updateMouse: (mutation: (draft: MouseBindings) => void) => Promise<void>
  private activeDirectory: string | undefined
  private generation = 0
  private disposed = false

  /** Current workspace root; read live so workspace switches keep paths valid. Undefined until the location syncs. */
  private get directory(): string | undefined {
    return this.context.location?.directory
  }

  constructor(context: Context) {
    this.context = context
    this.config = new ConfigStore(context.storage)
    // The host owns these signals, even when a plain .ts import resolves a different Solid runtime.
    const [state, updateState] = context.storage.memory<TreeState>("dir-tree.state", {
      initial: { version: 0, gitVersion: 0, loadError: undefined, settings: { ...DEFAULT_SETTINGS } },
    })
    this.state = state
    this.updateState = updateState
    this.updateState((draft) => { draft.settings ??= { ...DEFAULT_SETTINGS } })
    this.setLoadError(undefined)

    const [mouse, updateMouse] = context.storage.store("dir-tree.mouse", {
      initial: { ...DEFAULT_MOUSE_BINDINGS },
    })
    this.mouse = mouse
    this.updateMouse = updateMouse

    const [expanded, updateExpanded] = context.storage.store(STORAGE_EXPANDED, {
      initial: { dirs: [] as string[] },
    })
    this.updateExpanded = updateExpanded
    for (const item of expanded.dirs) {
      if (typeof item === "string") this.expandedSet.add(normalizePath(item))
    }
  }

  isExpanded(path: string): boolean {
    this.state.version
    return this.expandedSet.has(normalizePath(path))
  }

  loadError(): string | undefined {
    return this.state.loadError
  }

  isDisposed(): boolean {
    return this.disposed
  }

  private setLoadError(error: string | undefined): void {
    this.updateState((draft) => { draft.loadError = error })
  }

  toggle(path: string): void {
    const key = normalizePath(path)
    if (this.expandedSet.has(key)) {
      this.expandedSet.delete(key)
    } else {
      this.expandedSet.add(key)
      // Show cached rows immediately, then revalidate after a folded period.
      void this.requestDirectory(key, this.map.has(key))
      this.scheduleRefresh(0) // Recolor newly visible Git-ignored files as well.
    }
    this.persistExpanded(key)
    this.bump()
  }

  /** Git status for a file node (absolute path), or undefined. */
  gitStatus(node: TreeNode): GitStatus | undefined {
    this.state.gitVersion
    return this.gitStatuses.get(node.absolute)?.status
  }

  settings(): ProjectSettings {
    return this.state.settings
  }

  mouseBindings(): MouseBindings {
    return this.mouse
  }

  async changeMouseBinding(action: MouseAction, delta: -1 | 1): Promise<void> {
    if (!MOUSE_ACTIONS.some(({ id }) => id === action) || (delta !== 1 && delta !== -1)) throw new Error("Invalid mouse binding change")
    const values: readonly MouseBinding[] = action === "toggleFolder" ? MOUSE_BUTTONS : [...MOUSE_BUTTONS, "off"]
    await this.updateMouse((draft) => {
      const index = values.indexOf(draft[action])
      if (index < 0) throw new Error(`Invalid stored mouse binding: ${action}`)
      draft[action] = values[(index + delta + values.length) % values.length]!
    })
  }

  /** Publish live settings via the host's store, without rebuilding unchanged tree rows. */
  applySettings(directory: string, settings: ProjectSettings): void {
    if (this.disposed || this.directory !== directory) return
    this.updateState((draft) => {
      draft.settings.visible = settings.visible
    })
  }

  gitStatusCode(node: TreeNode): string | undefined {
    this.state.gitVersion
    return this.gitStatuses.get(node.absolute)?.code
  }

  private async fetchGitStatuses(): Promise<void> {
    const directory = this.directory
    if (!directory || this.disposed) return
    const generation = this.generation

    try {
      // Re-probe the workspace's prefix inside its Git repository on every
      // refresh: one cheap rev-parse, and a topology change (git init in a
      // former subdirectory) restyles on the next cycle instead of sticking
      // to a stale cached probe.
      const prefix = await git(directory, ["rev-parse", "--show-prefix"]).then(
        (out) => {
          const [prefix = ""] = out.split(/\r?\n/)
          return normalizePath(prefix)
        },
        () => undefined,
      )
      if (generation !== this.generation || this.directory !== directory) return
      if (prefix === undefined) return // Retry on the next refresh: git init can happen later.
      const next = new Map<string, StatusRow>()
      // Porcelain paths are repository-root-relative. Use Git's own prefix
      // instead of comparing absolute paths: Git may expand Windows 8.3
      // aliases or symlinks that the file API retains in location.directory.
      // check-ignore rejects paths inside submodules. Exclude those queries
      // using gitlinks from the index, not the submodule's dirty status.
      const submodules: string[] = []
      for (const entry of (await git(directory, ["ls-files", "--stage", "--full-name", "-z", "--", "."])).split("\0")) {
        if (!entry.startsWith("160000 ")) continue
        const path = normalizePath(entry.slice(entry.indexOf("\t") + 1))
        const local = prefix === "" ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined
        if (local !== undefined) submodules.push(local)
      }
      for (const item of parsePorcelain(await git(directory, ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all", "--", "."]))) {
        const path = normalizePath(item.path)
        const local = prefix === "" ? path
          : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined
        if (local !== undefined) next.set(normalizePath(joinPath(directory, local)), item)
      }
      // Query only visible undecorated files, not every ignored dependency.
      // Unlike the plugin's hide rules, this respects the real Git index and
      // ignore rules. It adds gray decorations only; it never hides rows.
      const files = this.visibleRows().filter(({ node }) => !node.isDir && !next.has(node.absolute)
        && !submodules.some((path) => node.path === path || node.path.startsWith(`${path}/`))).map(({ node }) => node.path)
      if (files.length) {
        let ignored = ""
        try {
          ignored = await git(directory, ["check-ignore", "-z", "--stdin"], files.join("\0") + "\0")
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error
        }
        for (const path of ignored.split("\0").filter(Boolean)) next.set(normalizePath(joinPath(directory, path)), { path, status: "ignored", code: "!!" })
      }
      if (generation !== this.generation || this.directory !== directory) return
      // Same rule as the listings: an unchanged status map must not bump
      // gitVersion — every bump recalculates (and repaints) all row colors.
      if (!sameStatuses(this.gitStatuses, next)) {
        this.gitStatuses = next
        this.updateState((draft) => { draft.gitVersion++ })
      }
    } catch {
      // Git status is a nicety; a failing status call stays silent and keeps
      // the previous colors until the next refresh succeeds.
    }
  }

  private persistExpanded(key: string, descendants = false): void {
    void this.updateExpanded((draft) => {
      if (!Array.isArray(draft.dirs) || draft.dirs.some((dir) => typeof dir !== "string")) throw new Error("Invalid stored expanded directories")
      const dirs = new Set(draft.dirs.map(normalizePath))
      if (this.expandedSet.has(key)) dirs.add(key)
      else for (const dir of dirs) if (dir === key || (descendants && dir.startsWith(`${key}/`))) dirs.delete(dir)
      draft.dirs = [...dirs]
    }).catch((error) => {
      this.context.ui.toast.show({ variant: "error", title: "Dir Tree", message: `Could not save expanded folders: ${describeError(error)}`, duration: 5000 })
    })
  }

  private async filterNodes(dir: string, nodes: TreeNode[]): Promise<TreeNode[]> {
    const text = this.ignoreText
    const ignoreCase = this.ignoreCase
    const root = this.ignoreRoot
    if (!text.length || !root || !nodes.length) return nodes
    const cache = this.ignoreCache
    const signature = JSON.stringify(nodes.map(ignoreKey).sort())
    const cached = cache.get(dir)
    if (cached?.signature === signature) return nodes.filter((node) => !cached.hidden.has(ignoreKey(node)))
    const candidates = nodes.map((node) => ({ node, path: normalizePath(relative(root, node.absolute)) }))
      .filter(({ path }) => path && path !== ".." && !path.startsWith("../") && !isAbsolute(path) && !path.includes("\0"))
    if (!candidates.length) return nodes

    // Git owns the matcher. A private worktree contains only directory markers,
    // never project files, .gitignore files or the user's Git index/config.
    const temporary = joinPath(tmpdir(), "opencode")
    mkdirSync(temporary, { recursive: true })
    const sandbox = mkdtempSync(joinPath(temporary, "dir-tree-ignore-"))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key]
    const hidden = new Set<TreeNode>()
    try {
      await git(sandbox, ["init", "--bare", "--quiet", "--template=", "repo"], undefined, env)
      const rules = joinPath(sandbox, "rules")
      writeFileSync(rules, new Uint8Array(text.buffer, text.byteOffset, text.byteLength))
      // Separate types: an API listing can contain a stale file/dir pair for
      // the same path, and a directory marker must not affect file matching.
      for (const isDir of [false, true]) {
        const group = candidates.filter(({ node }) => node.isDir === isDir)
        if (!group.length) continue
        const worktree = joinPath(sandbox, isDir ? "dirs" : "files")
        mkdirSync(worktree)
        if (isDir) for (const { path } of group) mkdirSync(joinPath(worktree, path), { recursive: true })
        let output: string
        try {
          output = await git(worktree, [
            `--git-dir=${joinPath(sandbox, "repo")}`, `--work-tree=${worktree}`,
            "-c", `core.excludesFile=${rules}`, "-c", `core.ignorecase=${ignoreCase}`,
            "check-ignore", "--no-index", "-z", "--stdin",
          ], group.map(({ path }) => path).join("\0") + "\0", env)
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error
          output = "" // Git exit 1 means no matches, not a failed matcher.
        }
        const ignored = new Set(output.split("\0").filter(Boolean))
        for (const { node, path } of group) if (ignored.has(path)) hidden.add(node)
      }
      cache.set(dir, { signature, hidden: new Set([...hidden].map(ignoreKey)) })
      return nodes.filter((node) => !hidden.has(node))
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  }

  /** Re-probe the project root and its shared durable settings on every refresh. */
  private async reloadConfig(directory: string, generation: number): Promise<void> {
    let root = this.ignoreLocation === directory ? this.ignoreRoot : undefined
    try {
      const info = await this.context.client.location.get({ location: { directory } })
      if (this.disposed || generation !== this.generation || this.directory !== directory) return
      root = info.project.directory
    } catch (error) {
      // Keep a known root during transient failures; retry next refresh.
      if (this.disposed || generation !== this.generation || this.directory !== directory) return
      if (!root) throw new Error(`Could not determine project root: ${describeError(error)}`)
    }
    const config = this.config.read(root)
    let ignoreCase = false
    if (config.lines.length) {
      try {
        ignoreCase = (await git(root, ["config", "--type=bool", "--get", "core.ignorecase"])).trim() === "true"
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error
      }
    }
    if (this.disposed || generation !== this.generation || this.directory !== directory) return
    // Git/config awaits may overlap a dialog save; never publish their old settings snapshot.
    const fresh = this.config.read(root)
    const text = Buffer.from(rulesText(fresh.lines))
    if (!text.length) ignoreCase = false
    this.applySettings(directory, fresh.settings)
    this.ignoreLocation = directory
    // Rule order matters for negation. Unchanged rules must emit no render signal.
    const previous = new Uint8Array(this.ignoreText.buffer, this.ignoreText.byteOffset, this.ignoreText.byteLength)
    if (root === this.ignoreRoot && text.equals(previous) && ignoreCase === this.ignoreCase) return
    this.ignoreRoot = root
    this.ignoreText = text
    this.ignoreCase = ignoreCase
    this.ignoreVersion++
    this.ignoreCache = new Map()
    this.map.clear()
    this.bump()
  }

  private syncDirectory(directory: string): void {
    if (this.activeDirectory === directory) return
    this.activeDirectory = directory
    this.generation++
    this.refreshTask = undefined
    this.refreshAgain = false
    this.map.clear()
    this.ignoreCache = new Map()
    this.loading.clear()
    this.pendingRefresh.clear()
    this.gitStatuses.clear()
    this.applySettings(directory, DEFAULT_SETTINGS)
    this.setLoadError(undefined)
    this.bump()
    this.updateState((draft) => { draft.gitVersion++ })
  }

  async requestDirectory(dir: string, force = false): Promise<void> {
    const key = normalizePath(dir)
    // The location may not be synced yet (undefined); the server.connected /
    // project.updated listeners re-fire this, so just wait.
    const directory = this.directory
    if (!directory || this.disposed) return
    this.syncDirectory(directory)
    const inFlight = this.loading.get(key)
    if (inFlight) {
      // A filesystem event during a request must not be lost. Coalesce all
      // forced refreshes into one follow-up request after the current one.
      if (force) this.pendingRefresh.add(key)
      await inFlight
      await this.loading.get(key)
      return
    }
    if (!force && this.map.has(key)) return
    const generation = this.generation

    const task = Promise.resolve().then(async () => {
      try {
        if (generation !== this.generation || this.directory !== directory || this.disposed) return
        if (key === ROOT || this.ignoreLocation !== directory) await this.reloadConfig(directory, generation)
        if (generation !== this.generation || this.directory !== directory || this.disposed) return
        if (!this.settings().visible) {
          this.setLoadError(undefined)
          return // Hidden trees still reload config, but do not list files.
        }
        const result = await this.context.client.file.list({
          location: { directory },
          path: key === ROOT ? "." : key,
        })
        if (generation !== this.generation || this.directory !== directory) return

        if (result.data === undefined) throw new Error("response contained no data")

        // Reuse the previous node objects for unchanged paths: Solid's <For>
        // keys rows by reference, so fresh objects would tear down and rebuild
        // every row on each refresh (visible flicker). Only genuinely new or
        // type-changed entries (file→dir) get new objects.
        const previous = new Map((this.map.get(key) ?? []).map((node) => [node.path, node]))
        const ignoreVersion = this.ignoreVersion
        const nodes = await this.filterNodes(key, result.data.map((entry) => toNode(entry, directory)))
        if (generation !== this.generation || this.directory !== directory || this.disposed) return
        if (ignoreVersion !== this.ignoreVersion) {
          this.pendingRefresh.add(key)
          return
        }
        const fresh = nodes
          .sort(compareNodes)
          .map((node) => {
            const old = previous.get(node.path)
            return old?.isDir === node.isDir ? old : node
          })
        // Node reuse makes an unchanged listing compare equal by reference.
        // Only signal the renderer when something actually changed: OpenTUI
        // does not short-circuit identical text/color updates, so every bump
        // repaints all rows — a no-op poll must emit zero signals.
        if (!sameChildren(this.map.get(key), fresh)) {
          this.map.set(key, fresh)
          this.bump()
        }
        this.setLoadError(undefined)
      } catch (error) {
        if (generation === this.generation && this.directory === directory) this.handleFailure(key, error)
      } finally {
        if (generation === this.generation) {
          this.loading.delete(key)
          if (this.pendingRefresh.delete(key) && !this.disposed) void this.requestDirectory(key, true)
        }
      }
    })
    this.loading.set(key, task)
    await task
  }

  private handleFailure(key: string, error: unknown): void {
    // Startup race: server/workspace not ready yet (nothing ever loaded).
    // Stay quiet — the server.connected event re-fires the refresh; toasting
    // every pending directory here would spam the TUI.
    if (this.map.size === 0) {
      this.setLoadError(`Could not load tree (${describeError(error)})`)
      return
    }
    const directory = this.directory
    if (key !== ROOT && directory && existsSync(directory) && !existsSync(joinPath(directory, key))) {
      // Directory no longer exists: drop it and its expanded subtree
      // silently. The next listing of the parent removes the row.
      this.removeDirectory(key)
      this.bump()
    } else {
      const message = `Failed to list "${key || "."}": ${describeError(error)}`
      this.setLoadError(message)
      this.context.ui.toast.show({ variant: "error", title: "Dir Tree", message, duration: 5000 })
    }
  }

  /** Remove a directory and all of its descendants from the cache/expansion. */
  private removeDirectory(key: string): void {
    const prefix = `${key}/`
    for (const entries of [this.map, this.ignoreCache, this.expandedSet]) {
      for (const dir of entries.keys()) {
        if (dir === key || dir.startsWith(prefix)) entries.delete(dir)
      }
    }

    this.persistExpanded(key, true)
    this.setLoadError(undefined)
  }

  /** Refresh every directory we have data for (debounced). */
  scheduleRefresh(delay: number): void {
    if (this.disposed) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refreshAll()
    }, delay)
  }

  /** Stop pending work; call from the plugin cleanup function. */
  dispose(): void {
    this.disposed = true
    this.generation++
    this.loading.clear()
    this.pendingRefresh.clear()
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  refreshAll(): Promise<void> {
    const directory = this.directory
    if (!directory || this.disposed) return Promise.resolve()
    this.syncDirectory(directory)
    if (this.refreshTask) {
      this.refreshAgain = true
      return this.refreshTask
    }
    // Coalesce within a location; a new location must not wait for old requests.
    const generation = this.generation
    const task = Promise.resolve().then(async () => {
      try {
        do {
          if (generation !== this.generation || this.disposed) return
          this.refreshAgain = false
          await this.refreshVisible(generation)
        } while (this.refreshAgain && generation === this.generation && !this.disposed)
      } finally {
        if (this.refreshTask === task) this.refreshTask = undefined
      }
    })
    this.refreshTask = task
    return task
  }

  private async refreshVisible(generation: number): Promise<void> {
    // Refresh only the visible expanded tree. Cached but folded directories
    // stay available for instant reopening without being polled forever.
    const directory = this.directory
    if (this.disposed || generation !== this.generation || !directory) return
    // The forced root request re-reads durable settings and handles configuration
    // errors without dropping the last good tree or rejecting the poll task.
    await this.requestDirectory(ROOT, true)
    if (this.disposed || generation !== this.generation || this.directory !== directory || this.state.loadError || !this.settings().visible) return

    let frontier = [ROOT]
    const seen = new Set(frontier)
    while (frontier.length) {
      const next: string[] = []
      for (const parent of frontier) {
        for (const node of this.map.get(parent) ?? []) {
          if (!node.isDir || !this.expandedSet.has(node.path) || seen.has(node.path)) continue
          seen.add(node.path)
          next.push(node.path)
        }
      }
      for (const dir of next) {
        if (this.disposed || generation !== this.generation || this.directory !== directory) return
        await this.requestDirectory(dir, true)
      }
      frontier = next
    }
    if (this.disposed || generation !== this.generation || this.directory !== directory) return
    await this.fetchGitStatuses()
  }

  /** Flatten visible nodes depth-first. Row objects are cached per node so a
   * refresh reuses them: <For> keys by reference, and stable rows keep
   * unchanged lines from being rebuilt (and flickering). */
  visibleRows(): Array<{ node: TreeNode; depth: number }> {
    this.state.version
    type Row = { node: TreeNode; depth: number }
    const rows: Row[] = []
    const alive = new Map<TreeNode, Row>()
    const walk = (dir: string, depth: number) => {
      const children = this.map.get(dir)
      if (!children) return
      for (const node of children) {
        const cached = this.rowCache.get(node)
        const row = cached?.depth === depth ? cached : { node, depth }
        alive.set(node, row)
        rows.push(row)
        if (node.isDir && this.expandedSet.has(node.path)) {
          walk(node.path, depth + 1)
        }
      }
    }
    walk(ROOT, 0)
    this.rowCache = alive
    return rows
  }

  private bump(): void {
    this.updateState((draft) => { draft.version++ })
  }
}
