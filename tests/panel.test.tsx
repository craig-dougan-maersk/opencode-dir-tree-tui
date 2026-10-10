/** @jsxImportSource @opentui/solid */
import "./fixtures/home"
import { expect, mock, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { MouseButton, RGBA } from "@opentui/core"
import * as core from "@opentui/core"
import type { HostClipboardWriteResult } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Show, createSignal } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { ConfigStore, MOUSE_ACTIONS, MOUSE_BUTTONS } from "../src/config"
import type { MouseAction, MouseBinding, MouseBindings } from "../src/config"
import { makeDurableStorage, makeStorage, setRules } from "./fixtures/config"
const { default: plugin } = await import(process.env.PLUGIN_TEST_ENTRY ?? "../src/tui")

const white = RGBA.fromHex("#ffffff")
const theme = { text: { base: white, muted: white, action: { primary: { base: white } }, formfield: { selected: white }, feedback: {
  success: { base: white }, error: { base: white }, warning: { base: white },
} } }

test.each([".dirtreeignore", join(".opencode", ".dirtreeignore")])("real panel handles stored rules and ignores obsolete %s", { timeout: 15000 }, async (oldFile) => {
  let render!: () => any
  let unregistered = false
  let calls = 0
  let extraFile = false
  let empty = false
  let rootListed = Promise.withResolvers<void>()
  let folderListed = Promise.withResolvers<void>()
  const longName = "很长的文件名称😀-&%PATH%!^-very-long-file-name.ts"
  const toastMessages: string[] = []
  const showToast = mock(({ message }: { message: string }) => { toastMessages.push(message) })
  const copiedPaths: string[] = []
  const terminalPaths: string[] = []
  let clipboardResult: HostClipboardWriteResult = { status: "written" }
  let terminalSucceeds = true
  const renderer = {
    capabilities: { remote: false, osc52_support: "unsupported" },
    copyToClipboardOSC52: (text: string) => { terminalPaths.push(text); return terminalSucceeds },
  }
  const hostClipboard = {
    maxWriteBytes: 65_536,
    writeText: async (text: string) => { copiedPaths.push(text); return clipboardResult },
    dispose: mock(async () => {}),
  }
  const launches: string[] = []
  const launcherCalls: Array<{ command: string; args: string[] }> = []
  let openerFails = false
  const actualChildProcess = { ...childProcess }
  const fakeSpawn = (command: string, args: string[]) => {
    launcherCalls.push({ command, args })
    launches.push(args.at(-1)!.replaceAll("\\", "/"))
    const child = Object.assign(new EventEmitter(), { unref() {} })
    queueMicrotask(() => {
      if (openerFails) child.emit("error", new Error("missing opener"))
      else child.emit("spawn")
    })
    return child
  }
  const events = new Map<string, () => void>()
  // Obsolete files must stay inactive in the published package as well.
  const project = mkdtempSync(join(tmpdir(), "dir-tree-panel-"))
  if (oldFile !== ".dirtreeignore") {
    mkdirSync(join(project, ".opencode"))
    writeFileSync(join(project, ".dirtreeignore"), "src/\n")
  }
  writeFileSync(join(project, oldFile), "src/\n") // Must not hide src.
  const [location] = createSignal<{ directory: string } | undefined>({ directory: project })
  const context = {
    get location() { return location() },
    renderer,
    storage: { memory: makeStorage, store: makeDurableStorage() },
    themeMode: "dark",
    theme,
    client: { location: { get: async () => ({ project: { directory: project, canonical: join(project, "canonical") } }) }, file: { list: async ({ path }: { path: string }) => {
      calls++
      if (path === ".") rootListed.resolve()
      if (path === "src") folderListed.resolve()
      return { data: empty ? [] : path === "." ? [
        { path: "src/", type: "directory" },
        { path: "hidden/", type: "directory" },
        { path: longName, type: "file" },
        ...(extraFile ? [{ path: "fresh.ts", type: "file" }] : []),
      ] : [
        { path: "src/index.ts", type: "file" },
        { path: "src/keep.log", type: "file" },
        { path: "src/drop.log", type: "file" },
        { path: "src/private/", type: "directory" },
      ] }
    } } },
    keymap: { layer: () => {} },
    data: { on: (name: string, fn: () => void) => {
      events.set(name, fn)
      return () => { events.delete(name) }
    } },
    ui: {
      slot: (options: { render: () => any }) => {
        render = options.render
        return () => { unregistered = true }
      },
      toast: { show: showToast },
    },
  } as unknown as Plugin.Context
  await setRules(context.storage, project, ["hidden", "*.log", "!keep.log", "src/private/"])
  // Keep interaction tests away from the user's clipboard and default apps.
  const clipboardFactory = spyOn(core, "createHostClipboard").mockReturnValue(hostClipboard as ReturnType<typeof core.createHostClipboard>)
  mock.module("node:child_process", () => ({ ...actualChildProcess, spawn: fakeSpawn }))
  const cleanup = plugin.setup!(context) as () => void
  const [mounted, setMounted] = createSignal(true)
  const view = await testRender(() => <box width="100%" height={16}><scrollbox><Show when={mounted()}>{render()}</Show></scrollbox></box>, {
    width: 40, height: 20,
  })
  const waitForFrame = view.waitForFrame
  view.waitForFrame = async (predicate, options) => {
    // Visual idle does not mean the native Git matcher has finished.
    const deadline = Date.now() + 5000
    while (!await predicate(view.captureCharFrame()) && Date.now() < deadline) {
      await Bun.sleep(10)
      await view.renderOnce()
    }
    return waitForFrame(predicate, options)
  }
  try {
    await view.waitForFrame((frame) => frame.includes("▸ src"))
    expect(view.captureCharFrame()).not.toContain("hidden")
    view.resize(80, 20)
    await view.waitForFrame((frame) => frame.includes(longName))
    view.resize(20, 20)
    await view.waitForFrame((frame) => !frame.includes(longName) && frame.includes("..."))
    const narrow = view.captureCharFrame()
    expect(narrow.split("\n").some((line) => line.includes("...") && line.trimEnd().endsWith(".ts"))).toBe(true)
    expect(narrow).not.toContain("�")
    view.resize(80, 20)
    await view.waitForFrame((frame) => frame.includes(longName))
    const absolute = (...parts: string[]) => join(project, ...parts).replaceAll("\\", "/")
    // Middle copies files; left only toggles folders, even with a modifier held.
    await view.mockMouse.click(2, 2, MouseButton.LEFT, { modifiers: { ctrl: true } })
    expect(copiedPaths).toEqual([])
    await view.mockMouse.click(2, 2, MouseButton.MIDDLE, { modifiers: { ctrl: true } })
    await view.mockMouse.click(2, 1, MouseButton.LEFT, { modifiers: { ctrl: true } })
    await view.waitForFrame((frame) => frame.includes("index.ts"))
    expect(copiedPaths).toEqual([absolute(longName)])
    expect(launches).toEqual([])
    expect(toastMessages).toEqual(["Path copied"])
    expect(showToast).toHaveBeenLastCalledWith({
      variant: "success", title: "Dir Tree", message: "Path copied", duration: 1500,
    })
    toastMessages.length = 0
    await view.mockMouse.click(2, 2, MouseButton.MIDDLE)
    expect(copiedPaths.at(-1)).toBe(absolute("src", "index.ts"))
    expect(toastMessages).toEqual(["Path copied"])
    toastMessages.length = 0
    await view.mockMouse.click(2, 1)
    await view.waitForFrame((frame) => !frame.includes("index.ts"))
    expect(copiedPaths).toEqual([absolute(longName), absolute("src", "index.ts")])
    expect(toastMessages).toEqual([])

    const copiesBeforeOpening = copiedPaths.length
    await view.mockMouse.click(2, 2, MouseButton.RIGHT)
    await view.mockMouse.click(2, 1, MouseButton.RIGHT)
    await view.mockMouse.click(2, 0, MouseButton.RIGHT)
    await view.waitFor(() => launches.length === 2)
    expect(launches).toEqual([absolute(longName), absolute("src")])
    expect(launcherCalls.map(({ args }) => args.length)).toEqual([1, 1])
    expect(launcherCalls[0]!.args).toEqual([process.platform === "win32" ? absolute(longName).replaceAll("/", "\\") : absolute(longName)])
    expect(launcherCalls[0]!.command).toBe(process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe") : process.platform === "darwin" ? "open" : "xdg-open")
    expect(view.captureCharFrame()).toContain("▶ Dir Tree")
    expect(view.captureCharFrame()).not.toContain("index.ts")
    expect(copiedPaths.length).toBe(copiesBeforeOpening)
    await view.waitFor(() => toastMessages.length === 2)
    expect(toastMessages).toEqual(["Opening file", "Opening folder"])
    toastMessages.length = 0

    // Left/right always fold, while middle keeps its existing project-root binding.
    await view.mockMouse.click(2, 0, MouseButton.MIDDLE)
    await view.waitFor(() => copiedPaths.length === copiesBeforeOpening + 1)
    expect(copiedPaths.at(-1)).toBe(absolute())
    await view.waitFor(() => toastMessages.length === 1)
    expect(toastMessages).toEqual(["Path copied"])
    toastMessages.length = 0
    expect(view.captureCharFrame()).toContain("▶ Dir Tree")
    await view.mockMouse.click(2, 0, MouseButton.LEFT)
    await view.waitForFrame((frame) => frame.includes("▸ src") && frame.includes(longName))
    expect(launches).toHaveLength(2)
    expect(toastMessages).toEqual([])

    openerFails = true
    await view.mockMouse.click(2, 2, MouseButton.RIGHT)
    await view.waitFor(() => toastMessages.length === 1)
    expect(toastMessages[0]).toContain("Could not open")
    openerFails = false
    toastMessages.length = 0

    clipboardResult = { status: "failed", error: new Error("clipboard busy") }
    const copiesBeforeExpanding = copiedPaths.length
    await view.mockMouse.click(2, 1)
    await view.waitForFrame((frame) => frame.includes("index.ts"))
    expect(copiedPaths.length).toBe(copiesBeforeExpanding)
    expect(terminalPaths).toEqual([])
    expect(toastMessages).toEqual([])
    await view.mockMouse.click(2, 2, MouseButton.MIDDLE)
    await view.waitFor(() => toastMessages.length === 1)
    expect(toastMessages[0]).toContain("Could not copy index.ts: clipboard busy")
    toastMessages.length = 0
    clipboardResult = { status: "unsupported" }
    renderer.capabilities.osc52_support = "supported"
    await view.mockMouse.click(2, 2, MouseButton.MIDDLE)
    await view.waitFor(() => terminalPaths.length === 1)
    expect(terminalPaths.at(-1)).toBe(absolute("src", "index.ts"))
    await view.waitFor(() => toastMessages.length === 1)
    expect(toastMessages).toEqual(["Copy request sent"])
    toastMessages.length = 0

    renderer.capabilities.remote = true
    const hostCopies = copiedPaths.length
    await view.mockMouse.click(2, 2, MouseButton.MIDDLE)
    await view.waitFor(() => terminalPaths.length === 2)
    expect(copiedPaths.length).toBe(hostCopies)
    expect(terminalPaths.at(-1)).toBe(absolute("src", "index.ts"))
    await view.waitFor(() => toastMessages.length === 1)
    expect(toastMessages).toEqual(["Copy request sent"])
    toastMessages.length = 0
    terminalSucceeds = false
    await view.mockMouse.click(2, 2, MouseButton.MIDDLE)
    await view.waitFor(() => toastMessages.length === 1)
    expect(toastMessages[0]).toContain("Could not copy index.ts")
    terminalSucceeds = true
    renderer.capabilities.remote = false
    clipboardResult = { status: "written" }
    toastMessages.length = 0
    await view.mockMouse.click(2, 1)
    await view.waitForFrame((frame) => !frame.includes("index.ts"))
    await view.mockMouse.click(2, 1)
    await view.waitForFrame((frame) => frame.includes("index.ts"))
    expect(view.captureCharFrame()).toContain("▾ src")
    await view.mockMouse.click(2, 1)
    await view.waitForFrame((frame) => !frame.includes("index.ts"))
    const cachedCalls = calls
    folderListed = Promise.withResolvers<void>()
    await view.mockMouse.click(2, 1)
    await view.waitForFrame((frame) => frame.includes("index.ts"))
    // Cached rows appear immediately; reopening also revalidates the folder.
    await folderListed.promise
    expect(calls).toBeGreaterThan(cachedCalls)

    await view.mockMouse.click(2, 0)
    await view.waitForFrame((frame) => frame.includes("▶ Dir Tree"))
    expect(view.captureCharFrame()).not.toContain("index.ts")
    await view.mockMouse.click(2, 0, MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("▼ Dir Tree"))
    expect(toastMessages).toEqual([])
    await view.mockMouse.click(2, 0, MouseButton.LEFT)
    await view.waitForFrame((frame) => frame.includes("▶ Dir Tree"))
    extraFile = true
    rootListed = Promise.withResolvers<void>()
    await view.mockMouse.click(2, 0)
    await rootListed.promise
    await view.waitForFrame((frame) => frame.includes("fresh.ts"))
    expect(view.captureCharFrame()).toContain("index.ts")
    expect(toastMessages).toEqual([])

    empty = true
    // Frame waits stop at visual idle; wait for the debounced request first.
    rootListed = Promise.withResolvers<void>()
    events.get("server.connected")!()
    await rootListed.promise
    await view.waitForFrame((frame) => frame.includes("No files listed"))
    empty = false
    rootListed = Promise.withResolvers<void>()
    events.get("server.connected")!()
    await rootListed.promise
    await view.waitForFrame((frame) => frame.includes("▾ src") && !frame.includes("No files listed"))

    // The host can unmount the sidebar without unloading the plugin.
    // A cached renderable has already been destroyed and cannot be reused.
    setMounted(false)
    await view.waitForFrame((frame) => !frame.includes("Dir Tree"))
    await view.waitFor(() => hostClipboard.dispose.mock.calls.length > 0)
    setMounted(true)
    await view.waitForFrame((frame) => frame.includes("index.ts"))
    expect(view.captureCharFrame()).toContain("keep.log")
    expect(view.captureCharFrame()).not.toContain("drop.log")
    expect(view.captureCharFrame()).not.toContain("private")
    await view.mockMouse.click(2, 0)
    await view.waitForFrame((frame) => frame.includes("▶ Dir Tree"))
  } finally {
    cleanup()
    view.renderer.destroy()
    clipboardFactory.mockRestore()
    mock.module("node:child_process", () => actualChildProcess)
    rmSync(project, { recursive: true, force: true })
  }
  expect(hostClipboard.dispose).toHaveBeenCalled()
  expect(unregistered).toBe(true)
  expect(events.size).toBe(0)
})

test("session or workspace switches re-read the new directory immediately", { timeout: 15000 }, async () => {
  // Both slot props and context.location are reactive in the host: a session
  // switch re-renders the slot, and a late location update re-renders it again
  // without any session change. Either signal alone must refresh the tree —
  // otherwise it keeps the old directory until the 10s poll.
  let render!: (props?: { sessionID: string }) => any
  const oldDir = `${tmpdir().replaceAll("\\", "/")}/dir-tree-old`
  const newDir = `${tmpdir().replaceAll("\\", "/")}/dir-tree-new`
  const newListed = Promise.withResolvers<void>()
  const [directory, setDirectory] = createSignal(oldDir)
  const context = {
    location: { get directory() { return directory() } },
    keymap: { layer: () => {} },
    options: {},
    storage: { memory: makeStorage, store: makeDurableStorage() },
    themeMode: "dark",
    theme,
    client: { location: { get: async ({ location }: { location: { directory: string } }) => ({ project: { directory: location.directory } }) }, file: { list: async ({ location }: { location: { directory: string } }) => {
      if (location.directory === newDir) newListed.resolve()
      return { data: location.directory === oldDir
        ? [{ path: "old/", type: "directory" }, { path: "old-file.txt", type: "file" }]
        : [{ path: "new/", type: "directory" }, { path: "new-file.md", type: "file" }],
      }
    } } },
    data: { on: () => () => {} },
    ui: {
      slot: (slotOptions: { render: (props?: { sessionID: string }) => any }) => {
        render = slotOptions.render
        return () => {}
      },
      toast: { show: () => {} },
    },
  } as unknown as Plugin.Context
  const cleanup = plugin.setup!(context) as () => void
  // Simulate the host: the slot re-renders when sessionID or location moves.
  const [sessionID, setSessionID] = createSignal<string | undefined>(undefined)
  const view = await testRender(() => <box width="100%" height={8}><scrollbox>{render({ sessionID: sessionID() })}</scrollbox></box>, {
    width: 40, height: 10,
  })
  try {
    await view.waitForFrame((frame) => frame.includes("old-file.txt"))
    // The session appears while location still points at the old directory.
    setSessionID("ses_a")
    expect(view.captureCharFrame()).toContain("old-file")
    // Location lands late, with no further session change.
    const switchedAt = Date.now()
    setDirectory(newDir)
    // A coalesced refresh may still be waiting for the previous Git process.
    await newListed.promise
    await view.waitForFrame((frame) => frame.includes("new-file.md"))
    expect(view.captureCharFrame()).not.toContain("old-file")
    // The 10s auto-poll must not be what refreshed the tree.
    expect(Date.now() - switchedAt).toBeLessThan(8000)
  } finally {
    cleanup()
    view.renderer.destroy()
  }
})

test("collapsing the panel in one terminal leaves other terminals expanded", async () => {
  // The host synchronizes storage.store across TUI instances while
  // storage.memory stays per-terminal. Simulate that split: both instances
  // share one durable backing, memory is fresh per instance. With the old
  // storage.store panel state, collapsing here folded every terminal.
  const durable = new Map<string, ReturnType<typeof makeStorage>>()
  const list = async () => ({
    data: [
      { path: "src/", type: "directory" },
      { path: "readme.md", type: "file" },
    ],
  })
  const setupInstance = () => {
    let render!: () => any
    const context = {
      location: { directory: tmpdir() },
      keymap: { layer: () => {} },
      options: {},
      storage: {
        memory: makeStorage,
        store: (key: string, options: { initial: object }) => {
          let entry = durable.get(key)
          if (!entry) durable.set(key, (entry = makeStorage(key, options)))
          return entry
        },
      },
      themeMode: "dark",
      theme,
      client: { location: { get: async () => ({ project: { directory: tmpdir() } }) }, file: { list } },
      data: { on: () => () => {} },
      ui: {
        slot: (slotOptions: { render: () => any }) => {
          render = slotOptions.render
          return () => {}
        },
        toast: { show: () => {} },
      },
    } as unknown as Plugin.Context
    const cleanup = plugin.setup!(context) as () => void
    return { render: () => render(), cleanup }
  }
  const a = setupInstance()
  const b = setupInstance()
  const aView = await testRender(() => <box width="100%" height={8}><scrollbox>{a.render()}</scrollbox></box>, {
    width: 40, height: 10,
  })
  const bView = await testRender(() => <box width="100%" height={8}><scrollbox>{b.render()}</scrollbox></box>, {
    width: 40, height: 10,
  })
  try {
    await aView.waitForFrame((frame) => frame.includes("▸ src"))
    await bView.waitForFrame((frame) => frame.includes("▸ src"))
    await aView.mockMouse.click(2, 0)
    await aView.waitForFrame((frame) => frame.includes("▶ Dir Tree"))
    expect(aView.captureCharFrame()).not.toContain("readme.md")
    expect(bView.captureCharFrame()).toContain("▼ Dir Tree")
    expect(bView.captureCharFrame()).toContain("readme.md")
  } finally {
    a.cleanup()
    b.cleanup()
    aView.renderer.destroy()
    bView.renderer.destroy()
  }
})

test("global overlapping bindings control file/folder actions while header left/right always toggle", { timeout: 15000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "dir-tree-bindings-"))
  const copied: string[] = []
  const opened: string[] = []
  const memory = new Map<string, ReturnType<typeof makeStorage>>()
  const durable = new Map<string, ReturnType<typeof makeStorage>>()
  const events = new Map<string, () => void>()
  let render!: () => any
  let calls = 0
  const context = {
    location: { directory: project },
    renderer: { capabilities: { remote: false, osc52_support: "unsupported" } },
    storage: {
      memory: (key: string, options: { initial: object }) => {
        if (!memory.has(key)) memory.set(key, makeStorage(key, options))
        return memory.get(key)!
      },
      store: (key: string, options: { initial: object }) => {
        if (!durable.has(key)) durable.set(key, makeStorage(key, options))
        return durable.get(key)!
      },
    },
    theme,
    client: {
      location: { get: async () => ({ project: { directory: project } }) },
      file: { list: async ({ path }: { path: string }) => {
        calls++
        return { data: path === "." ? [{ path: "folder", type: "directory" }, { path: "file.txt", type: "file" }] : [{ path: "folder/child.txt", type: "file" }] }
      } },
    },
    keymap: { layer: () => {} },
    data: { on: (name: string, handler: () => void) => { events.set(name, handler); return () => events.delete(name) } },
    ui: { slot: (slot: { render: () => any }) => { render = slot.render; return () => {} }, toast: { show: () => {} } },
  } as unknown as Plugin.Context
  const actualChildProcess = { ...childProcess }
  const clipboard = spyOn(core, "createHostClipboard").mockReturnValue({
    maxWriteBytes: 65_536,
    writeText: async (path: string) => { copied.push(path); return { status: "written" } },
    dispose: async () => {},
  } as ReturnType<typeof core.createHostClipboard>)
  mock.module("node:child_process", () => ({ ...actualChildProcess, spawn: (_command: string, args: string[]) => {
    opened.push(args.at(-1)!.replaceAll("\\", "/"))
    const child = Object.assign(new EventEmitter(), { unref() {} })
    queueMicrotask(() => child.emit("spawn"))
    return child
  } }))
  const cleanup = plugin.setup!(context) as () => void
  const view = await testRender(() => <box width="100%" height={10}>{render()}</box>, { width: 50, height: 14 })
  const settings = () => ({
    ...(memory.get("dir-tree.state")![0] as { settings: { visible: boolean } }).settings,
    mouse: durable.get("dir-tree.mouse")![0] as MouseBindings,
  })
  const bind = async (action: MouseAction, button: MouseBinding) => {
    durable.get("dir-tree.mouse")![1]((draft) => { (draft as MouseBindings)[action] = button })
    await view.renderOnce()
  }
  const refresh = async (ready: () => boolean) => {
    events.get("server.connected")!()
    // Native Git can still be running when the renderer is visually idle.
    for (let i = 0; i < 100 && !ready(); i++) {
      await Bun.sleep(10)
      await view.renderOnce()
    }
    expect(ready()).toBe(true)
  }
  const click = async (label: string, button: number) => {
    const rows = view.captureCharFrame().split("\n")
    const y = rows.findIndex((row) => row.includes(label))
    expect(y).toBeGreaterThanOrEqual(0)
    await view.mockMouse.click(rows[y]!.indexOf(label), y, button)
    await Bun.sleep(0)
    await view.renderOnce()
  }
  const absolute = (...parts: string[]) => join(project, ...parts).replaceAll("\\", "/")
  try {
    await view.waitForFrame((frame) => frame.includes("file.txt"))
    await click("folder", MouseButton.MIDDLE)
    expect(copied).toEqual([absolute("folder")])
    expect(view.captureCharFrame()).toContain("▸ folder")
    await click("file.txt", MouseButton.MIDDLE)
    expect(copied).toEqual([absolute("folder"), absolute("file.txt")])
    await click("file.txt", MouseButton.LEFT) // The unused file button does nothing.
    expect(copied).toHaveLength(2)
    expect(opened).toHaveLength(0)
    const config = new ConfigStore(context.storage)
    const beforeBindings = config.read(project).text

    for (const { id, target } of MOUSE_ACTIONS) {
      for (const button of MOUSE_BUTTONS) {
        await bind(id, button)
        const matches = MOUSE_ACTIONS.filter((action) => action.target === target && settings().mouse[action.id] === button).map(({ id }) => id)
        const opens = matches.includes(target === "file" ? "openFile" : "openFolder")
        const copies = matches.includes(target === "file" ? "copyFilePath" : "copyFolderPath")
        const toggles = matches.includes("toggleFolder")
        const beforeOpen = opened.length
        const beforeCopy = copied.length
        const expanded = view.captureCharFrame().includes("▾ folder")
        await click(target === "file" ? "file.txt" : "folder", MOUSE_BUTTONS.indexOf(button))
        expect(opened.length - beforeOpen).toBe(opens ? 1 : 0)
        expect(copied.length - beforeCopy).toBe(copies ? 1 : 0)
        expect(view.captureCharFrame().includes("▾ folder")).toBe(toggles ? !expanded : expanded)
        if (opens) expect(opened.at(-1)).toBe(absolute(target === "file" ? "file.txt" : "folder"))
        if (copies) expect(copied.at(-1)).toBe(absolute(target === "file" ? "file.txt" : "folder"))
        if (target === "folder") {
          const headerOpen = opened.length
          const headerCopy = copied.length
          await click("Dir Tree", MOUSE_BUTTONS.indexOf(button))
          expect(opened.length - headerOpen).toBe(button === "middle" && opens ? 1 : 0)
          expect(copied.length - headerCopy).toBe(button === "middle" && copies ? 1 : 0)
          if (button === "middle" && opens) expect(opened.at(-1)).toBe(absolute())
          if (button === "middle" && copies) expect(copied.at(-1)).toBe(absolute())
          if (button !== "middle" || toggles) {
            expect(view.captureCharFrame()).toContain("▶ Dir Tree")
            await click("Dir Tree", MOUSE_BUTTONS.indexOf(button))
            await view.waitForFrame((frame) => frame.includes("file.txt"))
          } else expect(view.captureCharFrame()).toContain("▼ Dir Tree")
        }
      }
    }

    // All actions can share each physical button, including omitted/default bindings.
    for (const button of MOUSE_BUTTONS) {
      for (const { id } of MOUSE_ACTIONS) await bind(id, button)
      const beforeOpen = opened.length
      const beforeCopy = copied.length
      const expanded = view.captureCharFrame().includes("▾ folder")
      await click("file.txt", MOUSE_BUTTONS.indexOf(button))
      expect(opened.slice(beforeOpen)).toEqual([absolute("file.txt")])
      expect(copied.slice(beforeCopy)).toEqual([absolute("file.txt")])
      expect(view.captureCharFrame().includes("▾ folder")).toBe(expanded) // File clicks never run folder actions.
      await click("folder", MOUSE_BUTTONS.indexOf(button))
      expect(opened.slice(beforeOpen)).toEqual([absolute("file.txt"), absolute("folder")])
      expect(copied.slice(beforeCopy)).toEqual([absolute("file.txt"), absolute("folder")])
      expect(view.captureCharFrame().includes("▾ folder")).toBe(!expanded)
      await click("Dir Tree", MOUSE_BUTTONS.indexOf(button))
      const paths = [absolute("file.txt"), absolute("folder"), ...(button === "middle" ? [absolute()] : [])]
      expect(opened.slice(beforeOpen)).toEqual(paths)
      expect(copied.slice(beforeCopy)).toEqual(paths)
      expect(view.captureCharFrame()).toContain("▶ Dir Tree")
      await click("Dir Tree", MOUSE_BUTTONS.indexOf(button))
      await view.waitForFrame((frame) => frame.includes("file.txt"))
      const unusedOpen = opened.length
      const unusedCopy = copied.length
      await click("file.txt", (MOUSE_BUTTONS.indexOf(button) + 1) % MOUSE_BUTTONS.length)
      expect(opened).toHaveLength(unusedOpen)
      expect(copied).toHaveLength(unusedCopy)
    }

    for (const { id } of MOUSE_ACTIONS) if (id !== "toggleFolder") await bind(id, "off")
    await bind("toggleFolder", "left")
    const disabledOpen = opened.length
    const disabledCopy = copied.length
    for (const button of MOUSE_BUTTONS) {
      await click("file.txt", MOUSE_BUTTONS.indexOf(button))
      const expanded = view.captureCharFrame().includes("▾ folder")
      await click("folder", MOUSE_BUTTONS.indexOf(button))
      expect(view.captureCharFrame().includes("▾ folder")).toBe(button === "left" ? !expanded : expanded)
      await click("Dir Tree", MouseButton.MIDDLE)
      expect(view.captureCharFrame()).toContain("▼ Dir Tree")
      expect(opened).toHaveLength(disabledOpen)
      expect(copied).toHaveLength(disabledCopy)
    }
    for (const button of [MouseButton.LEFT, MouseButton.RIGHT]) {
      await click("Dir Tree", button)
      expect(view.captureCharFrame()).toContain("▶ Dir Tree")
      await click("Dir Tree", button)
      await view.waitForFrame((frame) => frame.includes("file.txt"))
    }
    expect(opened).toHaveLength(disabledOpen)
    expect(copied).toHaveLength(disabledCopy)

    expect(config.read(project).text).toBe(beforeBindings)
    expect(config.read(project).configured).toBe(false)

    await config.update(project, { kind: "visibility", value: false })
    await refresh(() => !settings().visible)
    await view.waitForFrame((frame) => !frame.includes("Dir Tree") && !frame.includes("file.txt"))
    const hiddenCalls = calls
    events.get("server.connected")!()
    await Bun.sleep(50)
    expect(calls).toBe(hiddenCalls) // Hidden trees reload settings, not file listings.
    await config.update(project, { kind: "visibility", value: true })
    await refresh(() => settings().visible)
    await view.waitForFrame((frame) => frame.includes("Dir Tree") && frame.includes("file.txt"))
  } finally {
    cleanup()
    view.renderer.destroy()
    clipboard.mockRestore()
    mock.module("node:child_process", () => actualChildProcess)
    rmSync(project, { recursive: true, force: true })
  }
})

test("folder colors follow live themes while Git colors stay fixed in both modes", { timeout: 15000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "dir-tree-colors-"))
  let cleanup = () => {}
  let view: Awaited<ReturnType<typeof testRender>> | undefined
  let clipboardFactory: ReturnType<typeof spyOn> | undefined
  const actualChildProcess = { ...childProcess }
  const copied: string[] = []
  const opened: string[] = []
  try {
    const git = (...args: string[]) => childProcess.execFileSync("git", ["-C", project, ...args])
    git("init", "-q", "--template=", "--initial-branch=main")
    for (const name of ["clean.txt", "modified.txt", "deleted.txt", "original.txt", "conflict.txt"]) writeFileSync(join(project, name), "original")
    git("add", ".")
    const commit = () => git("-c", "user.name=Dir Tree Test", "-c", "user.email=dir-tree@example.invalid", "-c", "core.hooksPath=", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture")
    commit()
    git("checkout", "-qb", "other")
    writeFileSync(join(project, "conflict.txt"), "theirs")
    git("add", "conflict.txt")
    commit()
    git("checkout", "-q", "main")
    writeFileSync(join(project, "conflict.txt"), "ours")
    git("add", "conflict.txt")
    commit()
    const merge = childProcess.spawnSync("git", ["-C", project, "-c", "user.name=Dir Tree Test", "-c", "user.email=dir-tree@example.invalid", "-c", "core.hooksPath=", "-c", "commit.gpgSign=false", "merge", "--no-edit", "other"], { encoding: "utf8" })
    expect(merge.status).toBe(1)
    expect(merge.stdout).toContain("CONFLICT")
    writeFileSync(join(project, "modified.txt"), "changed")
    git("add", "modified.txt")
    writeFileSync(join(project, "modified.txt"), "changed after staging")
    rmSync(join(project, "deleted.txt"))
    writeFileSync(join(project, "new.txt"), "new")
    writeFileSync(join(project, "added.txt"), "added")
    git("add", "added.txt")
    git("mv", "original.txt", "renamed.txt")
    writeFileSync(join(project, ".gitignore"), "ignored.txt\nsrc/\n")
    writeFileSync(join(project, "ignored.txt"), "ignored")
    mkdirSync(join(project, "src"))
    writeFileSync(join(project, "src", "ignored-child.txt"), "ignored child")
    const longName = "很长的文件名称😀-very-long-file-name.ts"
    writeFileSync(join(project, longName), "new")
    clipboardFactory = spyOn(core, "createHostClipboard").mockReturnValue({
      maxWriteBytes: 65_536,
      writeText: async (path: string) => { copied.push(path); return { status: "written" } },
      dispose: async () => {},
    } as ReturnType<typeof core.createHostClipboard>)
    mock.module("node:child_process", () => ({ ...actualChildProcess, spawn: (_command: string, args: string[]) => {
      opened.push(args.at(-1)!.replaceAll("\\", "/"))
      const child = Object.assign(new EventEmitter(), { unref() {} })
      queueMicrotask(() => child.emit("spawn"))
      return child
    } }))
    // [selected/highlight, base/action text], resolved by @opencode/theme@2.0.23
    // from anomalyco/opencode v2.0.23 packages/tui/src/theme/assets/*.json.
    // Unlike the old synthetic fixture, action.primary.base is NOT the highlight.
    const builtins = {
      opencode: { dark: ["#fab283", "#eeeeee"], light: ["#3b7dd8", "#1a1a1a"] },
      vesper: { dark: ["#ffc799", "#ffffff"], light: ["#ffc799", "#101010"] },
      tokyonight: { dark: ["#82aaff", "#c8d3f5"], light: ["#2e7de9", "#3760bf"] },
      dracula: { dark: ["#bd93f9", "#f8f8f2"], light: ["#bd93f9", "#282a36"] },
    } as const
    const [selected, setSelected] = createSignal<keyof typeof builtins>("opencode")
    const [mode, setMode] = createSignal<"dark" | "light">("dark")
    let render!: () => any
    const context = {
      location: { directory: project },
      renderer: { capabilities: { remote: false, osc52_support: "unsupported" } },
      storage: { memory: makeStorage, store: makeDurableStorage() },
      get themeMode() { return mode() },
      get theme() {
        const [highlight, foreground] = builtins[selected()][mode()]
        const base = RGBA.fromHex(foreground)
        return { ...theme, text: { ...theme.text, base, action: { primary: { base } }, formfield: { selected: RGBA.fromHex(highlight) } } }
      },
      client: { location: { get: async () => ({ project: { directory: project } }) }, file: { list: async ({ path }: { path: string }) => ({ data: path === "." ? [
        { path: "src/", type: "directory" },
        ...["clean.txt", "modified.txt", "deleted.txt", "new.txt", "added.txt", "renamed.txt", "ignored.txt", "conflict.txt", longName].map((path) => ({ path, type: "file" })),
      ] : [{ path: "src/ignored-child.txt", type: "file" }] }) } },
      data: { on: () => () => {} },
      keymap: { layer: () => {} },
      ui: { slot: (slot: { render: () => any }) => { render = slot.render; return () => {} }, toast: { show: () => {} } },
    } as unknown as Plugin.Context
    cleanup = plugin.setup!(context) as () => void
    view = await testRender(() => <box width="100%" height={16}>{render()}</box>, { width: 50, height: 20 })
    const color = (name: string) => view!.captureSpans().lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes(name))?.fg.toInts()
    const green = RGBA.fromHex("#73c991").toInts()
    // Native Git may finish after the renderer has already become visually idle.
    for (let i = 0; i < 100 && JSON.stringify(color("new.txt")) !== JSON.stringify(green); i++) {
      await Bun.sleep(10)
      await view.renderOnce()
    }
    for (const name of Object.keys(builtins) as (keyof typeof builtins)[]) {
      setSelected(name)
      for (const variant of ["dark", "light"] as const) {
        setMode(variant)
        await view.renderOnce()
        const [highlight, foreground] = builtins[name][variant]
        expect(color("src")).toEqual(RGBA.fromHex(highlight).toInts())
        expect(color("new.txt")).toEqual(green)
        // One green for all additions; one red for deletions and conflicts.
        expect(color("added.txt")).toEqual(green)
        expect(color("renamed.txt")).toEqual(green)
        expect(color("modified.txt")).toEqual(RGBA.fromHex("#e2c08d").toInts())
        expect(color("deleted.txt")).toEqual(RGBA.fromHex("#c74e39").toInts())
        expect(color("conflict.txt")).toEqual(RGBA.fromHex("#c74e39").toInts())
        expect(color("ignored.txt")).toEqual(RGBA.fromHex("#8c8c8c").toInts())
        expect(color("clean.txt")).toEqual(RGBA.fromHex(foreground).toInts())
      }
    }
    const checkBadges = () => {
      const lines = view!.captureCharFrame().split("\n")
      for (const [name, code] of [
        ["added.txt", "A"], ["new.txt", "??"], ["renamed.txt", "R"],
        ["modified.txt", "MM"], ["deleted.txt", "D"], ["conflict.txt", "UU"], ["ignored.txt", "!!"],
      ]) {
        const line = lines.find((line) => line.includes(name!))!
        expect(line.endsWith(code!)).toBe(true) // right edge, not just after the name
        const spans = view!.captureSpans().lines[lines.indexOf(line)]!.spans
        expect(spans.findLast((span) => span.text.trim())!.fg.toInts()).toEqual(color(name!))
      }
      expect(lines.find((line) => line.includes("clean.txt"))!.trimEnd().endsWith("clean.txt")).toBe(true)
      expect(lines.find((line) => line.includes("src"))!.trimEnd().endsWith("src")).toBe(true)
    }
    checkBadges()
    // Clicking the status column must still copy/open the file, not the badge.
    const row = view.captureCharFrame().split("\n").findIndex((line) => line.includes("new.txt"))
    await view.mockMouse.click(49, row, MouseButton.MIDDLE)
    await view.waitFor(() => copied.length === 1)
    await view.mockMouse.click(49, row, MouseButton.RIGHT)
    await view.waitFor(() => opened.length === 1)
    const absolute = join(project, "new.txt").replaceAll("\\", "/")
    expect(copied).toEqual([absolute])
    expect(opened).toEqual([absolute])
    view.resize(20, 20)
    await view.renderOnce()
    checkBadges()
    const narrow = view.captureCharFrame()
    expect(narrow.split("\n").find((line) => line.includes(".ts"))!.endsWith("??")).toBe(true)
    expect(narrow).toContain("...")
    expect(narrow).not.toContain("�")
    view.resize(50, 20)
    await view.renderOnce()
    await view.mockMouse.click(2, 1)
    const gray = RGBA.fromHex("#8c8c8c").toInts()
    const deadline = Date.now() + 5000
    while (JSON.stringify(color("ignored-child.txt")) !== JSON.stringify(gray) && Date.now() < deadline) {
      await Bun.sleep(10)
      await view.renderOnce()
    }
    expect(color("ignored-child.txt")).toEqual(gray)
    expect(color("src")).toEqual(RGBA.fromHex(builtins.dracula.light[0]).toInts())
  } finally {
    cleanup()
    view?.renderer.destroy()
    clipboardFactory?.mockRestore()
    mock.module("node:child_process", () => actualChildProcess)
    rmSync(project, { recursive: true, force: true })
  }
})
