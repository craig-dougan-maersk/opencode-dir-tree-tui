import "./fixtures/home"
import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { TreeStore, parsePorcelain } from "../src/tree"
import { CONFIG_STORAGE_KEY, DEFAULT_MOUSE_BINDINGS, DEFAULT_SETTINGS, MOUSE_ACTIONS, MOUSE_BUTTONS, projectKey } from "../src/config"
import type { MouseBinding, StoredConfig } from "../src/config"
import { setRules } from "./fixtures/config"

const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./fixtures/host.ts", import.meta.url))],
  target: "browser",
})
if (!bundle.success) throw new AggregateError(bundle.logs, "Host fixture build failed")
const host: typeof import("./fixtures/host") = await import(
  `data:text/javascript;base64,${Buffer.from(await bundle.outputs[0]!.text()).toString("base64")}`
)

type Entry = { path: string; type: "file" | "directory" }
const stores: TreeStore[] = []
const initialProjects: StoredConfig["projects"] = {}
let projectStorage: readonly [object, (mutation: (draft: object) => void) => void] | undefined
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose())
  for (const key of Object.keys(initialProjects)) delete initialProjects[key]
  projectStorage = undefined
})

/** Create an isolated project with rules in the fake host's durable store. */
function configProject(rules: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "dir-tree-cfg-"))
  initialProjects[projectKey(directory)] = { ignore: rules.map((line, index) => (index === 0 ? line.replace(/^\ufeff/, "") : line).replace(/\r$/, "")) }
  return directory
}

function fixture(initialDirectory: string | undefined = tmpdir(), expanded: string[] = [], rules?: readonly string[], durable = new Map<string, readonly [object, (mutation: (draft: object) => void) => void]>()) {
  let directory = rules === undefined ? initialDirectory : configProject(rules)
  let projectDirectory: string | undefined
  const calls: string[] = []
  let list = async (path: string): Promise<Entry[] | undefined> => path === "."
    ? [{ path: "src/", type: "directory" }]
    : [{ path: "src/index.ts", type: "file" }]
  const storage = (_key: string, options: { initial: object }) => {
    let saved = structuredClone(options.initial)
    const [state, setState] = host.createStore(structuredClone(saved))
    return [state, (mutation: (draft: object) => void) => {
      const draft = structuredClone(saved)
      mutation(draft)
      saved = structuredClone(draft)
      setState(host.reconcile(structuredClone(saved)))
    }] as const
  }
  const context = {
    get location() { return directory ? { directory } : undefined },
    storage: {
      memory: storage,
      store: (key: string, options: { initial: object }) => {
        let entry: readonly [object, (mutation: (draft: object) => void) => void]
        if (key === CONFIG_STORAGE_KEY) {
          projectStorage ??= storage(key, { initial: { projects: initialProjects } })
          entry = projectStorage
        } else {
          if (!durable.has(key)) durable.set(key, storage(key, key === "dir-tree.expanded" ? { initial: { dirs: expanded } } : options))
          entry = durable.get(key)!
        }
        return [entry[0], async (mutation: (draft: object) => void) => entry[1](mutation)] as const
      },
    },
    client: { location: { get: async ({ location }: { location: { directory: string } }) => ({
      directory: location.directory,
      project: { directory: projectDirectory ?? location.directory },
    }) }, file: { list: async ({ path }: { path: string }) => {
      calls.push(path)
      return { data: await list(path) }
    } } },
    ui: { toast: { show() {} } },
  } as unknown as Plugin.Context
  const store = new TreeStore(context)
  stores.push(store)
  return {
    store, calls, durable,
    setDirectory: (value: string) => { directory = value },
    setProjectDirectory: (value: string) => { projectDirectory = value },
    setList: (value: typeof list) => { list = value },
  }
}

test("host computations see async children and cached collapse/reopen across Solid instances", async () => {
  const { store } = fixture()
  let visible: string[] = []
  let isExpanded = false
  const dispose = host.createRoot((dispose) => {
    host.createComputed(() => { visible = store.visibleRows().map(({ node }) => node.path) })
    host.createComputed(() => { isExpanded = store.isExpanded("src") })
    return dispose
  })
  try {
    await store.requestDirectory("")
    expect(visible).toEqual(["src"])
    store.toggle("src")
    await Bun.sleep(10)
    expect(visible).toEqual(["src", "src/index.ts"])
    expect(isExpanded).toBe(true)
    store.toggle("src")
    expect(visible).toEqual(["src"])
    expect(isExpanded).toBe(false)
    store.toggle("src")
    expect(visible).toEqual(["src", "src/index.ts"])
  } finally { dispose() }
})

test.each([
  { rules: ["*.log"], hidden: ["debug.log", ".log", "错误.log"], visible: ["debugXlog", "debug.log.bak", "debug.LOG"] },
  { rules: [".env*"], hidden: [".env", ".env.local"], visible: ["env", "other.env"] },
  { rules: ["temp?"], hidden: ["temp1"], visible: ["temp中", "temp😀", "temp", "temp12"] },
  { rules: ["a*b?c"], hidden: ["ab1c", "axxb2c"], visible: ["abc", "ab12c", "xab1c"] },
  { rules: ["a**b*c"], hidden: ["abc", "axbybzc"], visible: ["ab", "abcx"] },
  { rules: ["[ab]*.log", "a+(b).txt", "file{1}.txt"], hidden: ["ax.log", "a+(b).txt", "file{1}.txt"], visible: ["[ab]x.log", "ab.txt", "file1.txt"] },
  { rules: ["*"], hidden: [".env", "file.txt", "目录"], visible: [] },
  { rules: [], hidden: [], visible: [".env", "node_modules", "debug.log"] },
  { rules: ["node_modules"], hidden: ["node_modules"], visible: ["node_modules_old", "Node_modules"] },
])("Gitignore basename patterns match rules $rules", async ({ rules, hidden, visible }) => {
  const { store, setList } = fixture(tmpdir(), [], rules)
  setList(async () => [...hidden, ...visible].map((path) => ({ path, type: "file" })))
  await store.requestDirectory("")
  expect(store.visibleRows().map(({ node }) => node.name).sort()).toEqual([...visible].sort())
})

test("wildcards filter files and directories at any depth and on refresh", async () => {
  const { store, setList } = fixture(tmpdir(), [], ["*.log", "cache*", "node_modules"])
  setList(async (path) => path === "." ? [
    { path: "src/", type: "directory" },
    { path: "cache-main/", type: "directory" },
    { path: "node_modules/", type: "directory" },
    { path: "debug.log", type: "file" },
  ] : [
    { path: "src/cache-local/", type: "directory" },
    { path: "src/debug.log", type: "file" },
    { path: "src/keep.ts", type: "file" },
  ])
  await store.requestDirectory("")
  await store.requestDirectory("src")
  store.toggle("src")
  expect(store.visibleRows().map(({ node }) => node.path)).toEqual(["src", "src/keep.ts"])
  await store.requestDirectory("src", true)
  expect(store.visibleRows().map(({ node }) => node.path)).toEqual(["src", "src/keep.ts"])
})

test("project config reloads when the workspace directory changes", async () => {
  const first = configProject(["*.log"])
  const second = configProject(["node_modules"])
  try {
    const { store, setList, setDirectory } = fixture(first)
    setList(async () => [
      { path: "debug.log", type: "file" },
      { path: "node_modules/", type: "directory" },
    ])
    await store.requestDirectory("")
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["node_modules"])
    setDirectory(second)
    await store.requestDirectory("", true)
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["debug.log"])
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test("another TUI's stored rules apply on refresh without a restart", async () => {
  const project = configProject(["*.log"])
  try {
    const { store, setList } = fixture(project)
    setList(async () => [
      { path: "debug.log", type: "file" },
      { path: "keep.ts", type: "file" },
    ])
    await store.requestDirectory("")
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["keep.ts"])
    await setRules(store.context.storage, project, ["keep.ts"])
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["debug.log"])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test("a trailing slash limits a rule to directories; a bare name matches both", async () => {
  const project = configProject(["node_modules/"])
  try {
    const { store, setList } = fixture(project)
    setList(async () => [
      { path: "node_modules/", type: "directory" },
      { path: "node_modules", type: "file" },
      { path: "debug.log", type: "file" },
    ])
    await store.requestDirectory("")
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["debug.log", "node_modules"])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test("comments and blank lines do not match entries", async () => {
  const project = configProject([
    "# build output",
    "",
    "dist/",
    "node_modules",
  ])
  try {
    const { store, setList } = fixture(project)
    setList(async () => [
      { path: "dist/", type: "directory" },
      { path: "dist", type: "file" },
      { path: "keep.log", type: "file" },
      { path: "docs/", type: "directory" },
      { path: "node_modules/", type: "directory" },
    ])
    await store.requestDirectory("")
    // dist/ hides the directory only; the bare "dist" file stays.
    expect(store.visibleRows().map(({ node }) => node.name).sort()).toEqual(["dist", "docs", "keep.log"])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test("old user/project config files are ignored and never recreated or modified", async () => {
  const project = mkdtempSync(join(tmpdir(), "dir-tree-bigcfg-"))
  const oldDirectory = join(homedir(), ".dirtree")
  try {
    mkdirSync(oldDirectory)
    writeFileSync(join(oldDirectory, "config.jsonc"), "{ broken old JSONC")
    writeFileSync(join(project, ".dirtreeignore"), `# ${"x".repeat(70_000)}\n*.log\n`)
    mkdirSync(join(project, ".opencode"))
    writeFileSync(join(project, ".opencode", ".dirtreeignore"), "debug.log\n")
    const { store, setList } = fixture(project)
    setList(async () => [{ path: "debug.log", type: "file" }])
    await store.requestDirectory("")
    expect(store.loadError()).toBeUndefined()
    expect(store.config.read(project).configured).toBe(false)
    expect(store.visibleRows()[0]?.node.name).toBe("debug.log")
    expect(readFileSync(join(project, ".dirtreeignore"), "utf8")).toContain("*.log")
    expect(readFileSync(join(oldDirectory, "config.jsonc"), "utf8")).toBe("{ broken old JSONC")
    rmSync(oldDirectory, { recursive: true })
    await store.config.update(project, { kind: "add", line: "debug.log" })
    await store.refreshAll()
    expect(store.visibleRows()).toEqual([])
    expect(existsSync(oldDirectory)).toBe(false)
  } finally {
    rmSync(oldDirectory, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test("many wildcard segments with a failing suffix complete without exponential backtracking", async () => {
  const { store, setList } = fixture(tmpdir(), [], ["*a".repeat(40) + "b"])
  const path = "a".repeat(200)
  setList(async () => [{ path, type: "file" }])
  await store.requestDirectory("")
  expect(store.visibleRows()[0]?.node.name).toBe(path)
})

test("host settings react independently of tree rows, persist while hidden and follow project roots", async () => {
  const project = configProject([])
  const otherProject = configProject([])
  const child = join(project, "src")
  mkdirSync(child)
  const a = fixture(project)
  const b = fixture(child, [], undefined, a.durable)
  b.setProjectDirectory(project)
  let dispose = () => {}
  try {
    await a.store.refreshAll()
    let rowSignals = 0
    let settingSignals = 0
    dispose = host.createRoot((dispose) => {
      host.createComputed(() => { a.store.visibleRows(); rowSignals++ })
      host.createComputed(() => { a.store.mouseBindings().openFile; settingSignals++ })
      return dispose
    })
    await a.store.refreshAll()
    expect(rowSignals).toBe(1)
    expect(settingSignals).toBe(1)
    const beforeBindings = a.store.config.read(project).text
    await a.store.changeMouseBinding("openFile", 1)
    expect(a.store.config.read(project).text).toBe(beforeBindings)
    expect(b.store.mouseBindings().openFile).toBe("off") // No refresh needed in another TUI/project.
    await a.store.refreshAll()
    expect(a.store.mouseBindings().openFile).toBe("off")
    expect(rowSignals).toBe(1)
    expect(settingSignals).toBe(2)
    await a.store.refreshAll()
    expect(settingSignals).toBe(2)
    await a.store.config.update(project, { kind: "visibility", value: false })
    const calls = a.calls.length
    await a.store.refreshAll()
    await a.store.refreshAll()
    await b.store.refreshAll()
    expect(a.store.settings().visible).toBe(false)
    expect(b.store.settings()).toEqual(a.store.settings())
    expect(a.calls.length).toBe(calls)
    expect(b.calls).toEqual([])
    a.setDirectory(otherProject)
    await a.store.refreshAll()
    expect(a.store.settings()).toEqual(DEFAULT_SETTINGS)
    expect(a.store.mouseBindings().openFile).toBe("off") // Project switches cannot reset global bindings.
    const restarted = fixture(otherProject, [], undefined, a.durable)
    expect(restarted.store.mouseBindings()).toEqual(a.store.mouseBindings())
    a.store.applySettings(project, { ...DEFAULT_SETTINGS, visible: false })
    expect(a.store.settings().visible).toBe(true) // A late save from the old session cannot hide the new project.
    a.setDirectory(project)
    await a.store.refreshAll()
    expect(a.store.settings().visible).toBe(false)
    await a.store.config.update(project, { kind: "visibility", value: true })
    await a.store.refreshAll()
    expect(a.store.settings().visible).toBe(true)
    expect(a.store.visibleRows().length).toBeGreaterThan(0)
  } finally {
    dispose()
    a.store.dispose()
    b.store.dispose()
    rmSync(project, { recursive: true, force: true })
    rmSync(otherProject, { recursive: true, force: true })
  }
})

test("global mouse bindings cycle only the selected action, allow overlaps, and reject invalid changes", async () => {
  const { store, durable } = fixture()
  expect(store.mouseBindings()).toEqual(DEFAULT_MOUSE_BINDINGS)
  expect(store.mouseBindings().copyFilePath).toBe("middle")
  expect(store.mouseBindings().copyFolderPath).toBe("middle")
  for (const { id } of MOUSE_ACTIONS) {
    const values: readonly MouseBinding[] = id === "toggleFolder" ? MOUSE_BUTTONS : [...MOUSE_BUTTONS, "off"]
    const untouched = MOUSE_ACTIONS.filter((action) => action.id !== id).map(({ id }) => [id, store.mouseBindings()[id]])
    for (const delta of [1, -1] as const) {
      for (let i = 0; i < values.length; i++) {
        const previous = store.mouseBindings()[id]
        await store.changeMouseBinding(id, delta)
        expect(store.mouseBindings()[id]).toBe(values[(values.indexOf(previous) + delta + values.length) % values.length]!)
        expect(MOUSE_ACTIONS.filter((action) => action.id !== id).map(({ id }) => [id, store.mouseBindings()[id]])).toEqual(untouched)
      }
    }
  }
  await store.changeMouseBinding("openFile", 1)
  expect(store.mouseBindings().openFile).toBe("off")
  expect(store.mouseBindings().copyFilePath).toBe("middle")
  await store.changeMouseBinding("openFile", 1)
  expect(store.mouseBindings().openFile).toBe("left")
  expect(store.mouseBindings().copyFilePath).toBe("middle")
  await store.changeMouseBinding("openFile", 1)
  expect(store.mouseBindings().openFile).toBe("middle")
  expect(store.mouseBindings().copyFilePath).toBe("middle")
  const before = { ...store.mouseBindings() }
  await expect(store.changeMouseBinding("unknown" as never, 1)).rejects.toThrow("Invalid mouse binding change")
  await expect(store.changeMouseBinding("openFile", 0 as never)).rejects.toThrow("Invalid mouse binding change")
  expect(store.mouseBindings()).toEqual(before)
  durable.get("dir-tree.mouse")![1]((draft) => { Object.assign(draft, { openFile: "wheel" }) })
  await expect(store.changeMouseBinding("openFile", 1)).rejects.toThrow("Invalid stored mouse binding")
  expect(store.mouseBindings().openFile as string).toBe("wheel") // Invalid storage is not silently replaced.
  durable.get("dir-tree.mouse")![1]((draft) => { Object.assign(draft, { toggleFolder: "off" }) })
  await expect(store.changeMouseBinding("toggleFolder", 1)).rejects.toThrow("Invalid stored mouse binding: toggleFolder")
  expect(store.mouseBindings().toggleFolder as string).toBe("off") // Do not overwrite invalid storage.
})

test.each(MOUSE_ACTIONS.filter(({ id }) => id !== "toggleFolder"))("$label can be disabled, persisted and re-enabled independently", async ({ id }) => {
  const { store, durable } = fixture()
  const before = { ...store.mouseBindings() }
  for (let i = 0; i < 3 && store.mouseBindings()[id] !== "off"; i++) await store.changeMouseBinding(id, 1)
  expect(store.mouseBindings()).toEqual({ ...before, [id]: "off" })
  const restarted = fixture(tmpdir(), [], undefined, durable)
  expect(restarted.store.mouseBindings()).toEqual({ ...before, [id]: "off" })
  await restarted.store.changeMouseBinding(id, 1)
  expect(restarted.store.mouseBindings()).toEqual({ ...before, [id]: "left" })
})

test("saved copy bindings are preserved instead of reset to the middle-click defaults", async () => {
  const { store, durable } = fixture()
  await store.changeMouseBinding("copyFilePath", -1)
  await store.changeMouseBinding("copyFolderPath", 1)
  const restarted = fixture(tmpdir(), [], undefined, durable)
  expect(restarted.store.mouseBindings()).toEqual({ ...DEFAULT_MOUSE_BINDINGS, copyFilePath: "left", copyFolderPath: "right" })
})

test("invalid stored settings report an error, keep the last good tree, and recover after repair", async () => {
  const project = configProject(["*.log"])
  const { store, setList } = fixture(project, ["src"])
  try {
    setList(async (path) => path === "." ? [{ path: "src/", type: "directory" }, { path: "debug.log", type: "file" }, { path: "keep.ts", type: "file" }]
      : [{ path: "src/child.ts", type: "file" }])
    await store.refreshAll()
    const before = store.visibleRows()
    await setRules(store.context.storage, project, [1] as never)
    await store.refreshAll() // Must resolve, not reject an unattended poll task.
    expect(store.loadError()).toContain("single-line strings")
    expect(store.visibleRows()[0]).toBe(before[0])
    await setRules(store.context.storage, project, ["keep.ts"])
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["src", "child.ts", "debug.log"])
    expect(store.loadError()).toBeUndefined()
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("other-project edits and unrelated settings emit no tree signals", async () => {
  const project = configProject(["*.log"])
  const other = configProject(["*.ts"])
  const { store } = fixture(project)
  let dispose = () => {}
  try {
    await store.refreshAll()
    let signals = 0
    dispose = host.createRoot((dispose) => {
      host.createComputed(() => { store.visibleRows(); signals++ })
      return dispose
    })
    await setRules(store.context.storage, other, ["dist/"])
    await store.refreshAll()
    expect(signals).toBe(1)
  } finally {
    dispose()
    store.dispose()
    rmSync(project, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test.each([
  { name: "paths, anchoring and directories", rules: ["/dist/", "docs/build/", "node_modules/"], paths: ["dist/", "dist/file.ts", "src/dist/", "docs/build/", "docs/build/file.ts", "other/docs/build/file.ts", "node_modules/", "src/node_modules/file.ts", "keep.ts"] },
  { name: "negation and ignored parents", rules: ["*.log", "!keep.log", "blocked/", "!blocked/keep.ts", "out/*", "!out/keep/"], paths: ["drop.log", "keep.log", "src/keep.log", "blocked/keep.ts", "out/drop.ts", "out/keep/", "out/keep/file.ts"] },
  { name: "recursive globstars", rules: ["docs/**/build/", "**/*.tmp", "a/**/b.txt"], paths: ["docs/build/", "docs/x/y/build/file.ts", "x.tmp", "src/x.tmp", "a/b.txt", "a/x/y/b.txt", "a/x/c.txt"] },
  { name: "character classes and UTF-8 bytes", rules: ["[ab]*.log", "file[[:digit:]].txt", "x[!a].txt", "temp?", "中文*.log"], paths: ["ax.log", "cx.log", "file1.txt", "filex.txt", "xb.txt", "xa.txt", "temp1", "temp中", "temp😀", "中文日志.log"] },
  { name: "escapes and whitespace", rules: ["# comment", "", "\\#secret", "\\!literal", "space\\ ", "trimmed   ", "file\\*", " leading"], paths: ["#secret", "!literal", "space ", "space", "trimmed", "trimmed ", "file*", "fileX", " leading", "leading"] },
  { name: "last matching rule wins", rules: ["*.log", "!keep.log", "keep.log"], paths: ["drop.log", "keep.log", "keep.ts"] },
  { name: "UTF-8 BOM and CRLF", rules: ["\uFEFF*.log\r", "!keep.log\r"], paths: ["drop.log", "keep.log", "keep.ts"] },
  { name: "three-star prefix", rules: ["***/foo"], paths: ["foo", "a/foo", "a/b/foo"] },
  { name: "three-star suffix and directory negation", rules: ["a/***", "!a/x/"], paths: ["a/", "a/x/", "a/x/keep.txt", "a/x/deep/keep.txt"] },
  { name: "directory traversal for trailing globstars", rules: ["a/**"], paths: ["a/", "a/x/", "a/x/keep.txt"] },
  { name: "line breaks in paths", rules: ["**/keep.tmp"], paths: ["a\nb/keep.tmp", "a\rb/keep.tmp", "a/b/keep.tmp"] },
  { name: "case-sensitive repository", rules: ["*.log"], paths: ["a.log", "a.LOG"], ignoreCase: false },
  { name: "case-insensitive repository", rules: ["*.log"], paths: ["a.log", "a.LOG"], ignoreCase: true },
])("stored ignore rules agree with git check-ignore: $name", async ({ rules, paths, ignoreCase = false }) => {
  const project = configProject(rules)
  const { store, setList } = fixture(project)
  try {
    execFileSync("git", ["-C", project, "init", "-q"])
    execFileSync("git", ["-C", project, "config", "core.ignorecase", String(ignoreCase)])
    writeFileSync(join(project, ".gitignore"), rules.join("\n"))
    for (const path of paths) if (path.endsWith("/")) mkdirSync(join(project, path), { recursive: true })
    setList(async () => paths.map((path) => ({ path, type: path.endsWith("/") ? "directory" : "file" })))
    await store.refreshAll()
    const result = spawnSync("git", ["-C", project, "check-ignore", "--no-index", "-z", "--stdin"], {
      input: paths.map((path) => path.replace(/\/$/, "")).join("\0") + "\0", encoding: "utf8",
    })
    expect([0, 1]).toContain(result.status)
    const hidden = new Set(result.stdout.split("\0").filter(Boolean))
    const expected = paths.map((path) => path.replace(/\/$/, "")).filter((path) => !hidden.has(path)).sort()
    expect(store.visibleRows().map(({ node }) => node.path).sort()).toEqual(expected)
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("stored project rules take precedence over all obsolete ignore files", async () => {
  const project = mkdtempSync(join(tmpdir(), "dir-tree-migration-"))
  const preferred = join(project, ".opencode", ".dirtreeignore")
  const { store, setList } = fixture(project)
  setList(async () => [
    { path: "tests/", type: "directory" },
    { path: "root-only.txt", type: "file" },
    { path: "main-only.txt", type: "file" },
    { path: "keep.ts", type: "file" },
  ])
  const names = () => store.visibleRows().map(({ node }) => node.name).sort()
  let computed = 0
  let dispose = () => {}
  try {
    writeFileSync(join(project, ".dirtreeignore"), "root-only.txt\n")
    mkdirSync(join(project, ".opencode"))
    writeFileSync(preferred, "/tests/\nmain-only.txt\n")
    await setRules(store.context.storage, project, ["/tests/", "main-only.txt"])
    await store.refreshAll()
    expect(store.config.read(project).lines).toEqual(["/tests/", "main-only.txt"])
    expect(existsSync(preferred)).toBe(true)
    expect(names()).toEqual(["keep.ts", "root-only.txt"])
    dispose = host.createRoot((dispose) => {
      host.createComputed(() => { store.visibleRows(); computed++ })
      return dispose
    })
    // Both old files are inactive and must emit no tree signal.
    writeFileSync(preferred, "root-only.txt")
    await store.refreshAll()
    expect(computed).toBe(1)
    const before = store.visibleRows()
    const signals = computed
    writeFileSync(join(project, ".dirtreeignore"), "keep.ts\n")
    await store.refreshAll()
    expect(computed).toBe(signals) // inactive root edits have no effect
    store.visibleRows().forEach((row, index) => expect(row).toBe(before[index]))
    await setRules(store.context.storage, project, ["main-only.txt", "!main-only.txt"])
    await store.refreshAll()
    expect(names()).toEqual(["keep.ts", "main-only.txt", "root-only.txt", "tests"])
    // Empty new rules mean no hiding, not fallback to an old file.
    await setRules(store.context.storage, project, [])
    await store.refreshAll()
    expect(names()).toEqual(["keep.ts", "main-only.txt", "root-only.txt", "tests"])
    rmSync(preferred)
    await store.refreshAll()
    expect(names()).toEqual(["keep.ts", "main-only.txt", "root-only.txt", "tests"])
    rmSync(join(project, ".dirtreeignore"))
    await store.refreshAll()
    expect(names()).toEqual(["keep.ts", "main-only.txt", "root-only.txt", "tests"])
  } finally {
    dispose()
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test.each(["oversized", "directory"])("a %s obsolete ignore file cannot block the tree", async (kind) => {
  const project = mkdtempSync(join(tmpdir(), "dir-tree-invalid-legacy-"))
  const preferred = join(project, ".opencode", ".dirtreeignore")
  const { store, setList } = fixture(project)
  try {
    mkdirSync(join(project, ".opencode"))
    writeFileSync(join(project, ".dirtreeignore"), "keep.ts\n")
    if (kind === "directory") mkdirSync(preferred) // exists, but cannot be read as a file
    else writeFileSync(preferred, `# ${"x".repeat(70_000)}\nkeep.ts\n`)
    setList(async () => [{ path: "keep.ts", type: "file" }])
    await store.refreshAll()
    expect(store.loadError()).toBeUndefined()
    expect(store.config.read(project).configured).toBe(false)
    expect(store.visibleRows()[0]?.node.name).toBe("keep.ts")
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("sessions at the root or a subdirectory share stored rules without leaking to other projects", async () => {
  const project = configProject(["*.log", "/root-only.txt", "/src/private/"])
  const otherProject = configProject(["keep.ts"])
  mkdirSync(join(project, "src"))
  const a = fixture(project)
  const b = fixture(project)
  const child = fixture(join(project, "src"))
  child.setProjectDirectory(project)
  const other = fixture(otherProject)
  const sessions = [a, b, child, other]
  sessions.forEach(({ setList }) => setList(async () => [
    { path: "debug.log", type: "file" },
    { path: "root-only.txt", type: "file" },
    { path: "keep.ts", type: "file" },
    { path: "private/", type: "directory" },
  ]))
  const names = ({ store }: typeof a) => store.visibleRows().map(({ node }) => node.name).sort()
  try {
    await Promise.all(sessions.map(({ store }) => store.refreshAll()))
    expect(names(a)).toEqual(["keep.ts", "private"])
    expect(names(b)).toEqual(names(a))
    expect(names(child)).toEqual(["keep.ts", "root-only.txt"])
    expect(names(other)).toEqual(["debug.log", "private", "root-only.txt"])
    await setRules(a.store.context.storage, project, ["*.log", "!debug.log"])
    await Promise.all(sessions.map(({ store }) => store.refreshAll()))
    expect(names(a)).toEqual(["debug.log", "keep.ts", "private", "root-only.txt"])
    expect(names(b)).toEqual(names(a))
    expect(names(child)).toEqual(names(a))
    expect(names(other)).toEqual(["debug.log", "private", "root-only.txt"])
    // Returning to the project re-reads durable rules, not session state.
    a.setDirectory(otherProject)
    await a.store.refreshAll()
    expect(names(a)).toEqual(names(other))
    a.setDirectory(project)
    await a.store.refreshAll()
    expect(names(a)).toEqual(names(b))
  } finally {
    sessions.forEach(({ store }) => store.dispose())
    rmSync(project, { recursive: true, force: true })
    rmSync(otherProject, { recursive: true, force: true })
  }
})

test("reordering negation rules applies on refresh", async () => {
  const project = configProject(["*.log", "!keep.log"])
  const { store, setList } = fixture(project)
  try {
    setList(async () => [{ path: "keep.log", type: "file" }])
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["keep.log"])
    await setRules(store.context.storage, project, ["!keep.log", "*.log"])
    await store.refreshAll()
    expect(store.visibleRows()).toEqual([])
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("native matching uses only the selected rules and does not change project Git data", async () => {
  const project = configProject(["*.log"])
  const { store, setList } = fixture(project, ["src"])
  try {
    execFileSync("git", ["-C", project, "init", "-q"])
    const gitignore = join(project, ".gitignore")
    const global = join(project, "global-ignore")
    writeFileSync(gitignore, "keep.ts\nsrc/\n")
    writeFileSync(join(project, ".git", "info", "exclude"), "local.ts\n")
    writeFileSync(global, "global.ts\n")
    execFileSync("git", ["-C", project, "config", "core.excludesFile", global])
    mkdirSync(join(project, "src"))
    writeFileSync(join(project, "src", ".gitignore"), "keep.ts\n")
    writeFileSync(join(project, "tracked.log"), "tracked")
    execFileSync("git", ["-C", project, "add", "tracked.log"])
    const index = readFileSync(join(project, ".git", "index"))
    const config = readFileSync(join(project, ".git", "config"))
    setList(async (path) => path === "." ? [
      { path: "src/", type: "directory" },
      ...["keep.ts", "local.ts", "global.ts", "tracked.log"].map((path) => ({ path, type: "file" as const })),
    ] : [{ path: "src/keep.ts", type: "file" }])
    await store.requestDirectory("")
    await store.requestDirectory("src")
    expect(store.loadError()).toBeUndefined()
    expect(store.visibleRows().map(({ node }) => node.path)).toEqual(["src", "src/keep.ts", "global.ts", "keep.ts", "local.ts"])
    expect(readFileSync(gitignore, "utf8")).toBe("keep.ts\nsrc/\n")
    expect(readFileSync(join(project, ".git", "index"))).toEqual(index)
    expect(readFileSync(join(project, ".git", "config"))).toEqual(config)
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("changing core.ignorecase reapplies unchanged rules on the next refresh", async () => {
  const project = configProject(["*.log"])
  const { store, setList } = fixture(project)
  try {
    execFileSync("git", ["-C", project, "init", "-q"])
    setList(async () => [{ path: "debug.LOG", type: "file" }])
    execFileSync("git", ["-C", project, "config", "core.ignorecase", "false"])
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["debug.LOG"])
    execFileSync("git", ["-C", project, "config", "core.ignorecase", "true"])
    await store.refreshAll()
    expect(store.visibleRows()).toEqual([])
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("invalid UTF-8 in an obsolete rules file is not read or migrated", async () => {
  const project = mkdtempSync(join(tmpdir(), "dir-tree-invalid-utf8-"))
  const { store, setList } = fixture(project)
  try {
    const original = Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74])
    writeFileSync(join(project, ".dirtreeignore"), original)
    setList(async () => [{ path: "\ufffd.txt", type: "file" }])
    await store.requestDirectory("")
    expect(store.loadError()).toBeUndefined()
    expect(store.config.read(project).configured).toBe(false)
    expect(store.visibleRows()[0]?.node.name).toBe("\ufffd.txt")
    expect(readFileSync(join(project, ".dirtreeignore"))).toEqual(original)
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("project root discovery is refreshed even when the session directory stays unchanged", async () => {
  const project = configProject(["*.log"])
  const child = join(project, "src")
  mkdirSync(child)
  initialProjects[projectKey(child)] = { ignore: ["keep.ts"] }
  const { store, setList, setProjectDirectory } = fixture(child)
  setList(async () => [{ path: "debug.log", type: "file" }, { path: "keep.ts", type: "file" }])
  try {
    setProjectDirectory(project)
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["keep.ts"])
    setProjectDirectory(child)
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["debug.log"])
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("transient project discovery failure keeps the known root and retries", async () => {
  const project = configProject(["*.log"])
  const child = join(project, "src")
  mkdirSync(child)
  const { store, setList, setProjectDirectory } = fixture(child)
  setProjectDirectory(project)
  setList(async () => [{ path: "debug.log", type: "file" }, { path: "keep.ts", type: "file" }])
  const get = store.context.client.location.get
  let calls = 0
  try {
    await store.refreshAll()
    store.context.client.location.get = async () => { calls++; throw new Error("temporarily disconnected") }
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["keep.ts"])
    store.context.client.location.get = async (...args) => { calls++; return get(...args) }
    await store.refreshAll()
    expect(calls).toBe(2)
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["keep.ts"])
  } finally {
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("late project discovery cannot replace a switched project's ignore rules", async () => {
  const first = configProject(["secret.ts"])
  const second = configProject(["keep.ts"])
  const { store, setList, setDirectory } = fixture(first)
  const get = store.context.client.location.get
  const started = Promise.withResolvers<void>()
  let finish!: (info: Awaited<ReturnType<typeof get>>) => void
  store.context.client.location.get = (input) => input?.location?.directory === first
    ? new Promise((resolve) => { finish = resolve; started.resolve() }) : get(input)
  setList(async () => [{ path: "secret.ts", type: "file" }, { path: "keep.ts", type: "file" }])
  try {
    const pending = store.requestDirectory("")
    await started.promise
    setDirectory(second)
    await store.requestDirectory("")
    finish({ directory: first, project: { id: "first", directory: first, canonical: first } })
    await pending
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["secret.ts"])
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["secret.ts"])
  } finally {
    store.dispose()
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test("unchanged rows keep node and row identities across a forced refresh", async () => {
  const { store, setList } = fixture()
  setList(async () => [
    { path: "src/", type: "directory" },
    { path: "a.ts", type: "file" },
  ])
  await store.requestDirectory("")
  const rowsBefore = store.visibleRows()
  await store.requestDirectory("", true)
  const rowsAfter = store.visibleRows()
  expect(rowsAfter.map(({ node }) => node.path)).toEqual(["src", "a.ts"])
  // <For> keys rows by reference: reusing the objects avoids rebuilding
  // (and flickering) unchanged lines on every refresh.
  expect(rowsAfter[0]).toBe(rowsBefore[0])
  expect(rowsAfter[1]).toBe(rowsBefore[1])
  expect(rowsAfter[0]!.node).toBe(rowsBefore[0]!.node)
  expect(rowsAfter[1]!.node).toBe(rowsBefore[1]!.node)

  // A file replaced by a directory of the same name must get a new node.
  setList(async () => [
    { path: "src/", type: "directory" },
    { path: "a.ts", type: "directory" },
  ])
  await store.requestDirectory("", true)
  const rowsChanged = store.visibleRows()
  // Both entries are directories now, so name order puts a.ts first.
  expect(rowsChanged.map(({ node }) => node.path)).toEqual(["a.ts", "src"])
  expect(rowsChanged[1]).toBe(rowsBefore[0]) // untouched src row still reused
  expect(rowsChanged[0]!.node.isDir).toBe(true)
  expect(rowsChanged[0]!.node).not.toBe(rowsBefore[1]!.node)
})

test("a refresh with unchanged contents emits no render signal", async () => {
  const { store, setList } = fixture()
  setList(async () => [{ path: "a.ts", type: "file" }])
  await store.requestDirectory("")
  let computed = 0
  const dispose = host.createRoot((dispose) => {
    host.createComputed(() => { store.visibleRows(); computed++ })
    return dispose
  })
  try {
    await store.requestDirectory("", true) // identical listing
    await Bun.sleep(10)
    expect(computed).toBe(1) // no version bump → computed never re-runs
    setList(async () => [{ path: "a.ts", type: "file" }, { path: "b.ts", type: "file" }])
    await store.requestDirectory("", true) // real change
    await Bun.sleep(10)
    expect(computed).toBe(2)
  } finally {
    dispose()
  }
})

test.each(["*.log", "node_modules/"])("unchanged nonempty ignore rule %s preserves rows without render signals", async (rule) => {
  const project = configProject([rule])
  const { store } = fixture(project, ["src"])
  let computed = 0
  let dispose = () => {}
  try {
    await store.refreshAll()
    const before = store.visibleRows()
    dispose = host.createRoot((dispose) => {
      host.createComputed(() => { store.visibleRows(); computed++ })
      return dispose
    })
    for (let i = 0; i < 3; i++) await store.refreshAll()
    expect(computed).toBe(1)
    const after = store.visibleRows()
    expect(after).toEqual(before)
    after.forEach((row, index) => expect(row).toBe(before[index]))
  } finally {
    dispose()
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("refresh retries the root and restored expansions after location becomes available", async () => {
  const { store, calls, setDirectory } = fixture("", ["src"])
  void store.refreshAll()
  expect(calls).toEqual([])
  setDirectory(tmpdir())
  store.scheduleRefresh(0)
  await Bun.sleep(30)
  expect(calls).toContain(".")
  expect(calls).toContain("src")
  expect(store.visibleRows().map(({ node }) => node.path)).toEqual(["src", "src/index.ts"])
})

test("refresh retries an initial listing failure", async () => {
  const { store, setList } = fixture()
  setList(async () => { throw new Error("server not ready") })
  await store.requestDirectory("")
  expect(store.loadError()).toContain("server not ready")
  setList(async () => [{ path: "README.md", type: "file" }])
  store.scheduleRefresh(0)
  await Bun.sleep(30)
  expect(store.visibleRows()[0]?.node.name).toBe("README.md")
  expect(store.loadError()).toBeUndefined()
})

test("missing response data reports failure without replacing a loaded listing", async () => {
  const { store, setList } = fixture()
  setList(async () => undefined)
  await store.requestDirectory("")
  expect(store.loadError()).toContain("response contained no data")

  setList(async () => [{ path: "keep.ts", type: "file" }])
  await store.requestDirectory("")
  expect(store.loadError()).toBeUndefined()
  setList(async () => undefined)
  await store.requestDirectory("", true)
  expect(store.loadError()).toContain('Failed to list ".": response contained no data')
  expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["keep.ts"])
})

test("rename source filenames resembling porcelain status are not parsed as extra files", () => {
  expect(parsePorcelain("R  new.ts\0AM old.ts\0?? added.ts\0")).toEqual([
    { path: "new.ts", status: "renamed", code: "R" },
    { path: "added.ts", status: "untracked", code: "??" },
  ])
})

test("copied files use the renamed decoration and their source path is skipped", () => {
  expect(parsePorcelain("C  copy.ts\0orig.ts\0?? added.ts\0")).toEqual([
    { path: "copy.ts", status: "renamed", code: "C" },
    { path: "added.ts", status: "untracked", code: "??" },
  ])
})

test("porcelain decorations follow VS Code: conflicts first, then working tree before index", () => {
  for (const [xy, status] of [
    ["A ", "added"], [" A", "added"], ["??", "untracked"], ["!!", "ignored"],
    ["M ", "modified"], [" M", "modified"], ["T ", "modified"], [" T", "modified"],
    ["D ", "deleted"], [" D", "deleted"], ["AM", "modified"], ["AD", "deleted"],
    ["DD", "conflicting"], ["AU", "conflicting"], ["UD", "conflicting"],
    ["UA", "conflicting"], ["DU", "conflicting"], ["AA", "conflicting"], ["UU", "conflicting"],
  ]) expect(parsePorcelain(`${xy} file.txt\0`)).toEqual([{ path: "file.txt", status, code: xy.trim() }])
  for (const xy of ["RM", "CM"]) {
    expect(parsePorcelain(`${xy} new.txt\0?? old.txt\0`)).toEqual([{ path: "new.txt", status: "modified", code: xy }])
  }
})

test("Git ignored files are decorated but stay visible, including ignored parents and subdirectory sessions", async () => {
  const repo = mkdtempSync(join(tmpdir(), "dir-tree-git-ignore-color-"))
  const workspace = join(repo, "workspace")
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args])
  let dispose = () => {}
  let store: TreeStore | undefined
  try {
    git("init", "-q", "--template=")
    mkdirSync(join(workspace, "ignored-dir"), { recursive: true })
    writeFileSync(join(workspace, "tracked.txt"), "tracked")
    writeFileSync(join(workspace, "ignored-dir", "tracked-child.txt"), "tracked child")
    git("add", ".")
    git("-c", "user.name=Dir Tree Test", "-c", "user.email=dir-tree@example.invalid", "-c", "core.hooksPath=", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture")
    writeFileSync(join(repo, ".gitignore"), "workspace/ignored.txt\nworkspace/ignored-dir/\nworkspace/tracked.txt\n")
    writeFileSync(join(workspace, "ignored.txt"), "ignored")
    writeFileSync(join(workspace, "ignored-dir", "child.txt"), "ignored child")
    writeFileSync(join(workspace, "new.txt"), "new")
    mkdirSync(join(workspace, "sub"))
    writeFileSync(join(workspace, "sub", "file.txt"), "submodule child")
    git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD").toString().trim()},workspace/sub`)
    const instance = fixture(workspace, ["ignored-dir", "sub"])
    store = instance.store
    instance.setList(async (path) => path === "." ? [
      { path: "ignored-dir/", type: "directory" },
      { path: "sub/", type: "directory" },
      ...["tracked.txt", "ignored.txt", "new.txt"].map((path) => ({ path, type: "file" as const })),
    ] : path === "sub" ? [{ path: "sub/file.txt", type: "file" }]
      : ["ignored-dir/child.txt", "ignored-dir/tracked-child.txt"].map((path) => ({ path, type: "file" })))
    await store.refreshAll()
    const nodes = store.visibleRows().map(({ node }) => node)
    const statuses = () => Object.fromEntries(nodes.filter((node) => !node.isDir).map((node) => [node.path, store!.gitStatus(node)]))
    expect(statuses()).toEqual({ "ignored-dir/child.txt": "ignored", "ignored-dir/tracked-child.txt": undefined, "sub/file.txt": undefined, "ignored.txt": "ignored", "new.txt": "untracked", "tracked.txt": undefined })
    expect(store.gitStatusCode(nodes.find((node) => node.path === "ignored.txt")!)).toBe("!!")
    expect(nodes.map((node) => node.path)).toContain("ignored-dir")
    let signals = 0
    dispose = host.createRoot((dispose) => {
      host.createComputed(() => { statuses(); signals++ })
      return dispose
    })
    await store.refreshAll()
    expect(signals).toBe(1)
    writeFileSync(join(repo, ".gitignore"), "")
    await store.refreshAll()
    expect(statuses()).toEqual({ "ignored-dir/child.txt": "untracked", "ignored-dir/tracked-child.txt": undefined, "sub/file.txt": undefined, "ignored.txt": "untracked", "new.txt": "untracked", "tracked.txt": undefined })
    // A badge must update even when its color group does not change.
    const tracked = nodes.find((node) => node.path === "tracked.txt")!
    writeFileSync(join(workspace, "tracked.txt"), "modified")
    await store.refreshAll()
    expect(store.gitStatusCode(tracked)).toBe("M")
    const before = signals
    git("add", "workspace/tracked.txt")
    await store.refreshAll()
    expect(store.gitStatusCode(tracked)).toBe("M")
    expect(signals).toBe(before) // same displayed code and color, no repaint
    writeFileSync(join(workspace, "tracked.txt"), "modified again")
    await store.refreshAll()
    expect(store.gitStatus(tracked)).toBe("modified")
    expect(store.gitStatusCode(tracked)).toBe("MM")
    expect(signals).toBe(before + 1)
    await store.refreshAll()
    expect(signals).toBe(before + 1)
  } finally {
    dispose()
    store?.dispose()
    rmSync(repo, { recursive: true, force: true })
  }
})

test("late responses cannot overwrite a switched workspace or a disposed store", async () => {
  const { store, setList, setDirectory } = fixture()
  const listed = Promise.withResolvers<void>()
  let finish!: (entries: Entry[]) => void
  setList(() => new Promise((resolve) => { finish = resolve; listed.resolve() }))
  const oldRequest = store.requestDirectory("")
  await listed.promise
  setDirectory(join(tmpdir(), "new-workspace"))
  setList(async () => [{ path: "new.ts", type: "file" }])
  await store.requestDirectory("")
  finish([{ path: "old.ts", type: "file" }])
  await oldRequest
  expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["new.ts"])

  const lateListed = Promise.withResolvers<void>()
  setList(() => new Promise((resolve) => { finish = resolve; lateListed.resolve() }))
  const lateRequest = store.requestDirectory("", true)
  await lateListed.promise
  store.dispose()
  finish([{ path: "late.ts", type: "file" }])
  await lateRequest
  expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["new.ts"])
})

test("a removed directory clears its descendants but keeps the root and sibling cache", async () => {
  const removed = `missing-${randomUUID()}`
  const sibling = `${removed}-sibling`
  const { store, calls, setList } = fixture(tmpdir(), [removed, `${removed}/child`, sibling])
  setList(async (path) => {
    if (path === ".") return [removed, sibling].map((path) => ({ path, type: "directory" }))
    if (path === removed) return [{ path: `${removed}/child`, type: "directory" }]
    return [{ path: `${path}/keep.ts`, type: "file" }]
  })
  for (const dir of ["", removed, `${removed}/child`, sibling]) await store.requestDirectory(dir)
  setList(async () => { throw new Error("directory removed") })
  await store.requestDirectory(removed, true)
  expect(store.isExpanded(removed)).toBe(false)
  expect(store.isExpanded(`${removed}/child`)).toBe(false)
  expect(store.isExpanded(sibling)).toBe(true)
  expect(store.visibleRows().map(({ node }) => node.path)).toEqual([removed, sibling, `${sibling}/keep.ts`])

  const before = calls.length
  setList(async () => [])
  for (const dir of ["", sibling, removed, `${removed}/child`]) await store.requestDirectory(dir)
  expect(calls.slice(before)).toEqual([removed, `${removed}/child`])
})


test("forced refresh during an in-flight listing fetches the latest result", async () => {
  const { store, setList } = fixture()
  const listed = Promise.withResolvers<void>()
  let finish!: (entries: Entry[]) => void
  let calls = 0
  setList(async () => {
    calls++
    return calls === 1
      ? new Promise<Entry[]>((resolve) => { finish = resolve; listed.resolve() })
      : [{ path: "latest.ts", type: "file" }]
  })
  const first = store.requestDirectory("")
  await listed.promise
  const refresh = store.requestDirectory("", true)
  finish([{ path: "old.ts", type: "file" }])
  await Promise.all([first, refresh])
  expect(calls).toBe(2)
  expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["latest.ts"])
})

test("refresh only visits visible expanded folders", async () => {
  const names = Array.from({ length: 11 }, (_, i) => `dir-${i}`)
  const { store, calls, setList } = fixture(tmpdir(), names)
  setList(async (path) => path === "."
    ? names.map((name) => ({ path: `${name}/`, type: "directory" }))
    : [{ path: `${path}/file.ts`, type: "file" }])
  await store.refreshAll()
  store.toggle("dir-0")
  const before = calls.length
  await store.refreshAll()
  expect(calls.slice(before)).not.toContain("dir-0")
  const reopening = calls.length
  store.toggle("dir-0")
  await store.requestDirectory("dir-0")
  expect(calls.slice(reopening)).toContain("dir-0")
})

test("git discovers a new repository and colors files inside an untracked folder", { timeout: 15000 }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "dir-tree-git-test-"))
  try {
    const workspace = join(repo, "workspace")
    mkdirSync(join(workspace, "fresh"), { recursive: true })
    writeFileSync(join(workspace, "fresh", "new.ts"), "new")
    const { store, setList } = fixture(workspace, ["fresh"])
    setList(async (path) => path === "."
      ? [{ path: "fresh/", type: "directory" }]
      : [{ path: "fresh/new.ts", type: "file" }])
    await store.refreshAll() // Not a Git repository yet; failed probe must not stick.
    execFileSync("git", ["-C", repo, "init", "-q"])
    await store.refreshAll()
    const file = store.visibleRows().find(({ node }) => node.name === "new.ts")?.node
    expect(file).toBeDefined()
    expect(store.gitStatus(file!)).toBe("untracked")
  } finally {
    // mkdtempSync creates this exact, explicitly named directory under tmpdir.
    if (repo.startsWith(join(tmpdir(), "dir-tree-git-test-"))) rmSync(repo, { recursive: true, force: true })
  }
})

test("a git init inside the workspace restyles against the new repository root", { timeout: 15000 }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "dir-tree-nested-"))
  try {
    execFileSync("git", ["-C", repo, "init", "-q"])
    const workspace = join(repo, "w")
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, "new.ts"), "new")
    const { store, setList } = fixture(workspace)
    setList(async () => [{ path: "new.ts", type: "file" }])
    await store.refreshAll()
    const file = () => store.visibleRows()[0]!.node
    expect(store.gitStatus(file())).toBe("untracked") // untracked in the outer repo
    // The workspace itself becomes a repository: the prefix probe must follow.
    execFileSync("git", ["-C", workspace, "init", "-q"])
    await store.refreshAll()
    expect(store.gitStatus(file())).toBe("untracked")
  } finally {
    // mkdtempSync creates this exact, explicitly named directory under tmpdir.
    if (repo.startsWith(join(tmpdir(), "dir-tree-nested-"))) rmSync(repo, { recursive: true, force: true })
  }
})


test("overlapping full refreshes coalesce into one follow-up pass", async () => {
  const { store, calls, setList } = fixture()
  const listed = Promise.withResolvers<void>()
  let finish!: (entries: Entry[]) => void
  let active = 0
  let peak = 0
  setList(async () => {
    active++
    peak = Math.max(peak, active)
    const result: Entry[] = calls.length === 1
      ? await new Promise((resolve) => { finish = resolve; listed.resolve() })
      : [{ path: "latest.ts", type: "file" }]
    active--
    return result
  })
  const first = store.refreshAll()
  await listed.promise
  const second = store.refreshAll()
  finish([{ path: "old.ts", type: "file" }])
  await Promise.all([first, second])
  expect(calls).toEqual([".", "."])
  expect(peak).toBe(1)
  expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["latest.ts"])
})


test("a remote directory listing error does not mistake the folder for locally deleted", async () => {
  const remote = join(tmpdir(), `nonexistent-remote-${randomUUID()}`)
  const { store, setList } = fixture(remote, ["src"])
  await store.requestDirectory("")
  await store.requestDirectory("src")
  setList(async () => { throw new Error("remote unavailable") })
  await store.requestDirectory("src", true)
  expect(store.isExpanded("src")).toBe(true)
  expect(store.loadError()).toContain("remote unavailable")
})

test.skipIf(process.platform !== "win32")("Windows listings normalize backslashes and trailing directory separators", async () => {
  const { store, setList } = fixture(tmpdir(), ["src"])
  setList(async (path) => path === "." ? [{ path: "src\\", type: "directory" }] : [{ path: "src\\index.ts", type: "file" }])
  await store.refreshAll()
  expect(store.visibleRows().map(({ node }) => node.path)).toEqual(["src", "src/index.ts"])
})

test.skipIf(process.platform === "win32")("POSIX listings preserve literal backslashes in filenames", async () => {
  const { store, setList } = fixture()
  setList(async () => [{ path: "literal\\name.txt", type: "file" }])
  await store.requestDirectory("")
  expect(store.visibleRows()[0]?.node.name).toBe("literal\\name.txt")
})

test("hiding during a refresh cannot leave a completed folder request stuck in loading", async () => {
  const project = configProject([])
  const { store, setList, calls } = fixture(project, ["one", "two"])
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Entry[]>()
  let hold = false
  let fresh = false
  setList(async (path) => {
    if (path === ".") return ["one", "two"].map((path) => ({ path, type: "directory" }))
    if (path === "one" && hold) { started.resolve(); return pending.promise }
    return [{ path: `${path}/${fresh ? "new" : "old"}.txt`, type: "file" }]
  })
  try {
    await store.refreshAll()
    hold = true
    const refreshing = store.refreshAll()
    await started.promise
    await store.config.update(project, { kind: "visibility", value: false })
    store.applySettings(project, { visible: false })
    hold = false
    pending.resolve([{ path: "one/old.txt", type: "file" }])
    await refreshing
    const before = calls.filter((path) => path === "two").length
    fresh = true
    await store.config.update(project, { kind: "visibility", value: true })
    await store.refreshAll()
    expect(calls.filter((path) => path === "two").length).toBeGreaterThan(before)
    expect(store.visibleRows().map(({ node }) => node.path)).toEqual(["one", "one/new.txt", "two", "two/new.txt"])
  } finally {
    pending.resolve([])
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("workspace switching starts a new full refresh while the old request is still pending", async () => {
  const first = configProject([])
  const second = configProject([])
  const { store, setList, setDirectory } = fixture(first)
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Entry[]>()
  let old = true
  let hold = false
  setList(async () => {
    if (old && hold) { started.resolve(); return pending.promise }
    return [{ path: old ? "old.txt" : "new.txt", type: "file" }]
  })
  try {
    await store.refreshAll()
    hold = true
    const oldRefresh = store.refreshAll()
    await started.promise
    old = false
    setDirectory(second)
    const newRefresh = store.refreshAll()
    let finished = false
    void newRefresh.then(() => { finished = true })
    await Promise.race([newRefresh, Bun.sleep(1000)])
    try {
      expect(finished).toBe(true)
      expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["new.txt"])
    } finally {
      pending.resolve([{ path: "late-old.txt", type: "file" }])
      await Promise.all([oldRefresh, newRefresh])
    }
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["new.txt"])
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["new.txt"])
  } finally {
    pending.resolve([])
    store.dispose()
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test("late root discovery cannot change rules after switching A to B and back to A", async () => {
  const first = configProject(["secret.ts"])
  const second = configProject(["keep.ts"])
  const child = join(first, "src")
  mkdirSync(child)
  initialProjects[projectKey(child)] = { ignore: ["keep.ts"] }
  const { store, setList, setDirectory, setProjectDirectory } = fixture(child)
  const get = store.context.client.location.get
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof get>>>()
  let probes = 0
  store.context.client.location.get = (input) => {
    if (input?.location?.directory === child && probes++ === 0) { started.resolve(); return pending.promise }
    return get(input)
  }
  setList(async () => [{ path: "secret.ts", type: "file" }, { path: "keep.ts", type: "file" }])
  try {
    const stale = store.requestDirectory("")
    await started.promise
    setDirectory(second)
    setProjectDirectory(second)
    await store.refreshAll()
    setDirectory(child)
    setProjectDirectory(child)
    await store.refreshAll()
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["secret.ts"])
    pending.resolve({ directory: child, project: { id: "old", directory: first, canonical: first } })
    await stale
    expect(store.visibleRows().map(({ node }) => node.name)).toEqual(["secret.ts"])
  } finally {
    pending.resolve({ directory: child, project: { id: "old", directory: first, canonical: first } })
    store.dispose()
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test("a disposed queued listing does not start a project probe", async () => {
  const { store } = fixture()
  const get = spyOn(store.context.client.location, "get")
  try {
    const pending = store.requestDirectory("")
    store.dispose()
    await pending
    expect(get).not.toHaveBeenCalled()
  } finally { get.mockRestore() }
})

test("expanded directory saves merge each terminal's changes instead of replacing other folders", async () => {
  const a = fixture()
  const b = fixture(tmpdir(), [], undefined, a.durable)
  a.store.toggle("src")
  b.store.toggle("tests")
  const restart = fixture(tmpdir(), [], undefined, a.durable)
  expect(restart.store.isExpanded("src")).toBe(true)
  expect(restart.store.isExpanded("tests")).toBe(true)
  a.store.toggle("src")
  expect(a.durable.get("dir-tree.expanded")![0]).toEqual({ dirs: ["tests"] })
  expect(b.store.isExpanded("tests")).toBe(true)
})

test("queued expansion saves use the latest local toggle even when host locks finish out of order", async () => {
  const first = fixture()
  const storeEntry = first.store.context.storage.store
  const queued: Array<() => Promise<void>> = []
  first.store.context.storage.store = ((key, options) => {
    const [state, save] = storeEntry(key, options)
    return key !== "dir-tree.expanded" ? [state, save] : [state, (change) => new Promise<void>((resolve, reject) => {
      queued.push(async () => { try { await save(change); resolve() } catch (error) { reject(error) } })
    })]
  }) as typeof storeEntry
  const a = new TreeStore(first.store.context)
  stores.push(a)
  const b = fixture(tmpdir(), [], undefined, first.durable)
  a.toggle("src")
  a.toggle("src")
  b.store.toggle("tests")
  expect(queued).toHaveLength(2)
  for (const save of queued.reverse()) await save()
  const restart = fixture(tmpdir(), [], undefined, first.durable)
  expect(restart.store.isExpanded("src")).toBe(false)
  expect(restart.store.isExpanded("tests")).toBe(true)
})

test("expansion storage failures are reported without discarding saved folders", async () => {
  const first = fixture(tmpdir(), ["existing"])
  const storeEntry = first.store.context.storage.store
  first.store.context.storage.store = ((key, options) => {
    const [state, save] = storeEntry(key, options)
    return [state, key === "dir-tree.expanded" ? async () => { throw new Error("storage denied") } : save]
  }) as typeof storeEntry
  const toast = spyOn(first.store.context.ui.toast, "show")
  const store = new TreeStore(first.store.context)
  stores.push(store)
  try {
    store.toggle("src")
    await Bun.sleep(0)
    expect(store.isExpanded("src")).toBe(true)
    expect(first.durable.get("dir-tree.expanded")![0]).toEqual({ dirs: ["existing"] })
    expect(toast.mock.calls.at(-1)?.[0].message).toContain("Could not save expanded folders: storage denied")
  } finally { toast.mockRestore() }
})

test.each([null, [1]])("invalid stored expansions are not replaced by a toggle: %j", async (dirs) => {
  const { store, durable } = fixture()
  durable.get("dir-tree.expanded")![1]((draft) => { Object.assign(draft, { dirs }) })
  const toast = spyOn(store.context.ui.toast, "show")
  try {
    store.toggle("src")
    await Bun.sleep(0)
    expect(durable.get("dir-tree.expanded")![0]).toEqual({ dirs })
    expect(toast.mock.calls.at(-1)?.[0].message).toContain("Invalid stored expanded directories")
  } finally { toast.mockRestore() }
})

test("native match cache invalidates on file types, project roots and rule changes", async () => {
  const project = configProject(["/target/"])
  const child = join(project, "src")
  mkdirSync(child)
  initialProjects[projectKey(child)] = { ignore: ["/target/"] }
  const { store, setList, setProjectDirectory } = fixture(child)
  setProjectDirectory(project)
  let type: Entry["type"] = "file"
  setList(async () => [{ path: "target", type }])
  const makeTemp = spyOn(fs, "mkdtempSync")
  const matcherCalls = () => makeTemp.mock.calls.filter(([prefix]) => String(prefix).includes("dir-tree-ignore-")).length
  try {
    await store.requestDirectory("")
    await store.requestDirectory("", true)
    expect(matcherCalls()).toBe(1)
    expect(store.visibleRows()[0]?.node.isDir).toBe(false)
    type = "directory"
    await store.requestDirectory("", true)
    expect(matcherCalls()).toBe(2)
    expect(store.visibleRows()[0]?.node.isDir).toBe(true)
    setProjectDirectory(child)
    await store.requestDirectory("", true)
    expect(matcherCalls()).toBe(3)
    expect(store.visibleRows()).toEqual([])
    await setRules(store.context.storage, child, ["/other/"])
    await store.requestDirectory("", true)
    expect(matcherCalls()).toBe(4)
    expect(store.visibleRows()[0]?.node.name).toBe("target")
  } finally {
    makeTemp.mockRestore()
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("native match cache avoids rebuilding Git sandboxes for unchanged or reordered listings", { timeout: 15000 }, async () => {
  const project = configProject(["*.log"])
  const names = Array.from({ length: 50 }, (_, index) => `folder-${index}`)
  const { store, setList } = fixture(project, names)
  let reverse = false
  let extra = false
  setList(async (path) => {
    const entries: Entry[] = path === "." ? names.map((path) => ({ path, type: "directory" }))
      : [{ path: `${path}/keep.ts`, type: "file" }, { path: `${path}/drop.log`, type: "file" }, ...(extra && path === "folder-0" ? [{ path: `${path}/new.ts`, type: "file" as const }] : [])]
    return reverse ? entries.reverse() : entries
  })
  const makeTemp = spyOn(fs, "mkdtempSync")
  const matcherCalls = () => makeTemp.mock.calls.filter(([prefix]) => String(prefix).includes("dir-tree-ignore-")).length
  try {
    await store.refreshAll()
    expect(matcherCalls()).toBe(51)
    const before = store.visibleRows()
    makeTemp.mockClear()
    reverse = true
    await store.refreshAll()
    expect(matcherCalls()).toBe(0)
    store.visibleRows().forEach((row, index) => expect(row).toBe(before[index]))
    extra = true
    await store.refreshAll()
    expect(matcherCalls()).toBe(1)
    expect(store.visibleRows().some(({ node }) => node.path === "folder-0/new.ts")).toBe(true)
  } finally {
    makeTemp.mockRestore()
    store.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})
