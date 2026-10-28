/** @jsxImportSource @opentui/solid */
import "./fixtures/home"
import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, getOwner, onCleanup } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { CONFIG_STORAGE_KEY, ConfigStore, MOUSE_ACTIONS, projectKey } from "../src/config"
import type { MouseBindings } from "../src/config"
import { makeStorage, setRules } from "./fixtures/config"
const { default: plugin } = await import(process.env.PLUGIN_TEST_ENTRY ?? "../src/tui")

const white = RGBA.fromHex("#ffffff")
const theme = { background: { action: { primary: { focused: RGBA.fromHex("#333333") } }, formfield: { focused: RGBA.fromHex("#222222") } }, text: { base: white, muted: RGBA.fromHex("#888888"), action: { primary: { base: white, focused: white } }, formfield: { selected: RGBA.fromHex("#fab283"), focused: white }, feedback: {
  success: { base: white }, error: { base: white }, warning: { base: white },
} } }

test.each([
  { width: 88, height: 26, config: join(".opencode", ".dirtreeignore") },
  { width: 52, height: 18, config: ".dirtreeignore" },
  { width: 40, height: 18, config: ".dirtreeignore" },
])("/dirtree-sidebar stored settings interaction, JSON preview and editing at $width columns", { timeout: 15000 }, async ({ width, height, config }) => {
  const project = mkdtempSync(join(tmpdir(), "dir-tree-dialog-"))
  let cleanup = () => {}
  let view: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    const rulesFile = join(project, config)
    if (config !== ".dirtreeignore") {
      mkdirSync(join(project, ".opencode"))
      writeFileSync(join(project, ".dirtreeignore"), "wrong-source/\n")
    }
    const originalLines = ["node_modules/", "*.log", "# keep this comment", "", `${"long-path/".repeat(10)}end-rule/`, ...Array.from({ length: 20 }, (_, index) => `build-${index}/`)]
    const original = `\ufeff${originalLines.join("\r\n")}\r\n`
    writeFileSync(rulesFile, original)
    const toasts: Array<{ variant: string; message: string }> = []
    const layers = new Set<KeymapLayer>()
    let mode = "base"
    // V2 exposes only reachable commands: autocomplete and dialogs replace
    // base mode, so a direct call to a stored handler misses these regressions.
    const commands = () => [...layers]
      .filter((layer) => layer.mode === "global" || (layer.mode ?? "base") === mode)
      .flatMap((layer) => layer.commands ?? [])
      .filter((command) => typeof command.enabled === "function" ? command.enabled() : command.enabled !== false)
    const [current, setCurrent] = createSignal<() => any>(() => () => {})
    let promptValue: string | undefined
    let delayPrompt: Promise<string | undefined> | undefined
    let listCalls = 0
    let presentation = { size: "medium", centered: false }
    const memory = new Map<string, ReturnType<typeof makeStorage>>()
    const durable = new Map<string, ReturnType<typeof makeStorage>>()
    let storageError: Error | undefined
    let configWrites = 0
    let delayConfigSave: Promise<void> | undefined
    let configSaveStarted: (() => void) | undefined
    let closeDialog: (() => void) | undefined
    const context = {
      location: { directory: project },
      // The panel ships collapsed by default; these suites drive the expanded
      // tree, so opt out explicitly.
      options: { collapsedByDefault: false },
      storage: {
        memory: (key: string, options: { initial: object }) => {
          if (!memory.has(key)) memory.set(key, makeStorage(key, options))
          return memory.get(key)!
        },
        store: (key: string, options: { initial: object }) => {
          if (!durable.has(key)) durable.set(key, makeStorage(key, key === CONFIG_STORAGE_KEY
            ? { initial: { note: "config header", future: { enabled: true }, projects: {} } } : options))
          const [state, update] = durable.get(key)!
          return [state, async (mutation: (draft: object) => void) => {
            if (storageError) throw storageError
            if (key === CONFIG_STORAGE_KEY) {
              configWrites++
              configSaveStarted?.()
              await delayConfigSave
            }
            await update(mutation)
          }] as const
        },
      },
      themeMode: "dark",
      theme,
      keymap: { mode: { current: () => mode }, layer: (factory: () => KeymapLayer) => {
        const layer = factory()
        layers.add(layer)
        if (getOwner()) onCleanup(() => { layers.delete(layer) })
      } },
      client: {
        location: { get: async () => ({ project: { directory: project } }) },
        file: { list: async () => { listCalls++; return { data: [] } } },
      },
      data: { on: () => () => {} },
      ui: {
        slot: () => () => {},
        toast: { show: (options: { variant: string; message: string }) => { toasts.push(options) } },
        dialog: {
          set: (options: typeof presentation) => { presentation = options },
          // Mirrors the released host: show() resets size and centering.
          show: (r: () => any, onClose?: () => void) => {
            closeDialog?.()
            closeDialog = onClose
            mode = "modal"
            presentation = { size: "medium", centered: false }
            setCurrent(() => r)
          },
          clear: () => { closeDialog?.(); closeDialog = undefined; mode = "base"; setCurrent(() => () => null) },
          prompt: async () => {
            const cancelled = Promise.withResolvers<string | undefined>()
            const render = () => <text>Add ignore rule</text>
            context.ui.dialog.show(render, () => cancelled.resolve(undefined))
            const value = await Promise.race([delayPrompt ?? Promise.resolve(promptValue), cancelled.promise])
            if (current() === render) context.ui.dialog.clear()
            return value
          },
        },
      },
    } as unknown as Plugin.Context
    const settingsConfig = new ConfigStore(context.storage)
    const readProjectRules = (root: string) => settingsConfig.read(root)
    const configText = () => settingsConfig.read(project).text
    const replaceConfig = async (text: string) => {
      await durable.get(CONFIG_STORAGE_KEY)![1]((draft) => { Object.assign(draft, JSON.parse(text)) })
    }
    const setProjectRules = (root: string, lines: readonly string[]) => setRules(context.storage, root, lines)
    await setProjectRules(project, originalLines)
    cleanup = plugin.setup!(context) as () => void
    mode = "autocomplete"
    const command = commands().find((item) => item.slash?.name === "dirtree-sidebar")
    expect(command).toBeDefined()
    if (!command) throw new Error("/dirtree-sidebar is unreachable during slash completion")
    expect(command.id).toBe("dir-tree.ignore")
    expect(command.title).toBe("Open Dir Tree Sidebar settings")
    expect(commands().some((item) => item.slash?.name === "dirtree" || item.slash?.aliases?.includes("dirtree"))).toBe(false)
    expect(command.slash?.arguments).not.toBe(true)
    // The command palette itself opens in modal mode.
    mode = "modal"
    expect(commands().find((item) => item.id === command.id)?.palette).toBe(true)
    mode = "autocomplete"

    command.run()
    await Bun.sleep(50) // openIgnoreDialog is async (root probe)
    view = await testRender(() => <box width="100%" height="100%">{current()()}</box>, { width, height })
    await view.waitForFrame((frame) => frame.includes("Appearance") && frame.includes("Mouse bindings"))
    expect(readProjectRules(project).lines).toEqual(originalLines)
    expect(readFileSync(rulesFile, "utf8")).toBe(original)
    let initialConfig = configText()
    expect(presentation).toEqual({ size: "large", centered: true })
    const assertHeader = () => {
      const frame = view!.captureCharFrame()
      expect(frame.split("\n")[0]!.trimEnd().endsWith("esc")).toBe(true)
      expect(frame.match(/\besc\b/g)).toHaveLength(1)
      expect(frame).not.toContain("~/.dirtree/config.jsonc")
      expect(frame).not.toMatch(/saved immediately|Changes save immediately|esc Close|j\/k|PgUp\/PgDn/)
      expect(frame).not.toMatch(/\b\d+ rules\b/)
      expect(frame).not.toContain("Loaded file")
      expect(frame).not.toContain("gitignore syntax")
      expect(frame).toContain("Settings")
      expect(frame).toContain("Ignore Rules")
      expect(frame).not.toMatch(/[\u4e00-\u9fff]/) // All UI copy is English; user patterns remain untouched.
      const span = view!.captureSpans().lines[0]!.spans.find((item) => item.text.includes("esc"))
      expect(span?.fg.toInts()).toEqual(theme.text.muted.toInts())
    }
    const dialogKeys = () => commands().reduce((map, item) => {
      if (item.id) map.set(item.id.replace("dir-tree.ignore.", ""), item.run)
      return map
    }, new Map<string, (input?: string) => void | false | Promise<void>>())
    const clickText = async (text: string) => {
      const rows = view!.captureCharFrame().split("\n")
      const y = rows.findIndex((row) => row.includes(text))
      expect(y).toBeGreaterThanOrEqual(0)
      await view!.mockMouse.click(rows[y]!.indexOf(text), y)
      await view!.renderOnce()
    }
    const tabColor = (label: string) => view!.captureSpans().lines[2]!.spans.find((span) => span.text.includes(label))?.fg.toInts()
    const liveSettings = () => ({
      ...(memory.get("dir-tree.state")![0] as { settings: { visible: boolean } }).settings,
      mouse: durable.get("dir-tree.mouse")![0] as MouseBindings,
    })
    const settleSettings = async () => {
      await view!.waitFor(() => dialogKeys().has("setting-change"))
      await view!.renderOnce()
    }

    // The default tab mirrors the native settings layout, not the rule editor.
    assertHeader()
    expect(view.captureCharFrame()).toContain("←/→ change")
    expect(view.captureCharFrame()).toContain("Dir Tree Sidebar")
    expect(view.captureCharFrame()).not.toContain("Search")
    expect(view.renderer.root.findDescendantById("dir-tree-settings-search")).toBeUndefined()
    expect(view.captureCharFrame()).not.toContain("a add")
    expect(view.captureCharFrame()).not.toContain("node_modules/")
    expect(tabColor("Settings")).toEqual(theme.text.formfield.selected.toInts())
    expect(tabColor("Ignore Rules")).toEqual(theme.text.muted.toInts())
    expect(dialogKeys().has("add")).toBe(false)
    expect(dialogKeys().has("remove")).toBe(false)
    expect(dialogKeys().has("preview")).toBe(false)
    expect(dialogKeys().has("j")).toBe(false) // j/k navigate rules only.
    expect(dialogKeys().has("k")).toBe(false)
    expect(commands().find((item) => item.id === "dir-tree.ignore.up")?.bind).toBe("up,ctrl+p")
    expect(commands().find((item) => item.id === "dir-tree.ignore.down")?.bind).toBe("down,ctrl+n")
    expect(commands().find((item) => item.id === "dir-tree.ignore.home")?.bind).toBe("home")
    expect(commands().find((item) => item.id === "dir-tree.ignore.end")?.bind).toBe("end")
    expect(commands().find((item) => item.id === "dir-tree.ignore.next-tab")?.bind).toBe("tab")
    expect(commands().find((item) => item.id === "dir-tree.ignore.previous-tab")?.bind).toBe("shift+tab")
    const settingsRows = view.captureCharFrame().split("\n")
    const expandedRow = settingsRows.findIndex((row) => row.includes("Show file tree"))
    expect(settingsRows[expandedRow]!.indexOf("Show file tree")).toBe(2)
    expect(settingsRows[expandedRow]!.trimEnd().endsWith("on")).toBe(true)
    expect(view.captureSpans().lines[expandedRow]!.spans.map((span) => span.bg.toInts())).toEqual(
      view.captureSpans().lines[expandedRow]!.spans.map(() => theme.background.action.primary.focused.toInts()),
    )
    expect(view.captureSpans().lines[expandedRow]!.spans.find((span) => span.text.includes("Show file tree"))?.fg.toInts()).toEqual(theme.text.action.primary.focused.toInts())
    for (const [label, value] of [["Open file", "right-click"], ["Copy file path", "middle-click"], ["Open folder", "right-click"], ["Copy folder path", "middle-click"], ["Expand/collapse folder", "left-click"]]) {
      const row = settingsRows.find((row) => row.includes(label!))!
      expect(row.indexOf(label!)).toBe(2)
      const spans = view.captureSpans().lines[settingsRows.indexOf(row)]!.spans
      const beforeValue = spans.slice(0, spans.findIndex((span) => span.text.includes(value!))).reduce((width, span) => width + span.width, 0)
      const valueSpan = spans.find((span) => span.text.includes(value!))!
      expect(beforeValue + valueSpan.width).toBe(width - 2)
    }

    // This is a saved show/hide preference, independent of the temporary header fold state.
    dialogKeys().get("setting-previous")!()
    await settleSettings()
    expect(liveSettings().visible).toBe(false)
    expect(readProjectRules(project).settings.visible).toBe(false)
    expect(view.captureCharFrame().split("\n")[expandedRow]!.trimEnd().endsWith("off")).toBe(true)
    // Like /settings, either arrow cycles boolean values rather than forcing off/on.
    dialogKeys().get("setting-previous")!()
    await settleSettings()
    expect(liveSettings().visible).toBe(true)
    dialogKeys().get("setting-previous")!()
    await settleSettings()
    expect(liveSettings().visible).toBe(false)
    dialogKeys().get("setting-change")!()
    await settleSettings()
    expect(liveSettings().visible).toBe(true)
    await clickText("Show file tree")
    await settleSettings()
    expect(liveSettings().visible).toBe(false)
    dialogKeys().get("setting-next")!()
    await settleSettings()
    expect(liveSettings().visible).toBe(true)
    expect((memory.get("dir-tree.panel")![0] as { collapsed: boolean }).collapsed).toBe(false)

    const beforeBindings = configText()
    dialogKeys().get("down")!() // Select Open file, not an ignore-rule line.
    await view.renderOnce()
    const openRow = view.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("Open file")))!
    expect(openRow.spans.find((span) => span.text.includes("Open file"))?.bg.toInts()).toEqual(theme.background.action.primary.focused.toInts())
    dialogKeys().get("setting-next")!()
    await settleSettings()
    expect(liveSettings().mouse.openFile).toBe("off")
    expect(view.captureCharFrame().split("\n").find((row) => row.includes("Open file"))!.trimEnd().endsWith("off")).toBe(true)
    dialogKeys().get("setting-change")!()
    await settleSettings()
    expect(liveSettings().mouse.openFile).toBe("left")
    expect(liveSettings().mouse.copyFilePath).toBe("middle") // Only the selected action changes.
    dialogKeys().get("setting-change")!()
    await settleSettings()
    expect(liveSettings().mouse.openFile).toBe("middle")
    expect(liveSettings().mouse.copyFilePath).toBe("middle") // Overlap is allowed.
    dialogKeys().get("setting-previous")!()
    await settleSettings()
    expect(liveSettings().mouse.openFile).toBe("left")
    await clickText("Copy file path")
    await settleSettings()
    expect(liveSettings().mouse.copyFilePath).toBe("right")
    expect(liveSettings().mouse.openFile).toBe("left")
    for (const { id, label } of MOUSE_ACTIONS) {
      const untouched = MOUSE_ACTIONS.filter((action) => action.id !== id).map(({ id }) => [id, liveSettings().mouse[id]])
      const originalBinding = liveSettings().mouse[id]
      const seen: string[] = []
      for (let i = 0; i < (id === "toggleFolder" ? 3 : 4); i++) {
        await clickText(label)
        await settleSettings()
        const value = liveSettings().mouse[id]
        seen.push(value)
        expect(view.captureCharFrame().split("\n").find((row) => row.includes(label))!.trimEnd().endsWith(value === "off" ? "off" : `${value}-click`)).toBe(true)
        expect(MOUSE_ACTIONS.filter((action) => action.id !== id).map(({ id }) => [id, liveSettings().mouse[id]])).toEqual(untouched)
      }
      expect(seen.includes("off")).toBe(id !== "toggleFolder")
      expect(liveSettings().mouse[id]).toBe(originalBinding)
    }
    expect(configText()).toBe(beforeBindings)
    const beforeFailedSave = { ...liveSettings().mouse }
    storageError = new Error("storage denied")
    await clickText("Open file")
    await settleSettings()
    expect(liveSettings().mouse).toEqual(beforeFailedSave)
    expect(configText()).toBe(beforeBindings)
    expect(toasts.at(-1)?.message).toContain("Could not save settings: storage denied")
    const visibleBeforeFailedSave = liveSettings().visible
    await clickText("Show file tree")
    await settleSettings()
    expect(liveSettings().visible).toBe(visibleBeforeFailedSave)
    expect(configText()).toBe(beforeBindings)
    expect(toasts.at(-1)?.message).toContain("Could not save settings: storage denied")
    storageError = undefined
    view.resize(width, 14)
    dialogKeys().get("end")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Expand/collapse folder")
    expect(view.captureCharFrame()).toContain("←/→ change")
    view.resize(width, height)
    await view.renderOnce()

    const selectedSetting = () => ["Show file tree", ...MOUSE_ACTIONS.map(({ label }) => label)].find((label) =>
      view!.captureSpans().lines.flatMap((line) => line.spans).some((span) =>
        span.bg.toInts().join() === theme.background.action.primary.focused.toInts().join() && span.text.includes(label)))
    const beforeNavigation = configText()
    const writesBeforeNavigation = configWrites
    dialogKeys().get("down")!() // Wrap after the last item, as /settings does.
    await view.renderOnce()
    expect(selectedSetting()).toBe("Show file tree")
    dialogKeys().get("up")!()
    await view.renderOnce()
    expect(selectedSetting()).toBe("Expand/collapse folder")
    dialogKeys().get("home")!()
    await view.renderOnce()
    expect(selectedSetting()).toBe("Show file tree")
    dialogKeys().get("page-down")!() // Native page navigation advances ten items and wraps.
    await view.renderOnce()
    expect(selectedSetting()).toBe("Copy folder path")
    dialogKeys().get("page-up")!()
    await view.renderOnce()
    expect(selectedSetting()).toBe("Show file tree")
    expect(configText()).toBe(beforeNavigation)
    expect(configWrites).toBe(writesBeforeNavigation)

    const beforeMouseDown = configText()
    const writesBeforeMouseDown = configWrites
    const previousBinding = liveSettings().mouse.copyFolderPath
    const copyRows = view.captureCharFrame().split("\n")
    const copyY = copyRows.findIndex((row) => row.includes("Copy folder path"))
    const copyX = copyRows[copyY]!.indexOf("Copy folder path")
    await view.mockMouse.moveTo(copyX, copyY)
    await view.renderOnce()
    expect(selectedSetting()).toBe("Copy folder path")
    expect(configText()).toBe(beforeMouseDown)
    expect(configWrites).toBe(writesBeforeMouseDown)
    await view.mockMouse.pressDown(copyX, copyY)
    await view.renderOnce()
    expect(configText()).toBe(beforeMouseDown) // Press selects; only release changes.
    expect(liveSettings().mouse.copyFolderPath).toBe(previousBinding)
    await view.mockMouse.release(copyX, copyY)
    await settleSettings()
    expect(liveSettings().mouse.copyFolderPath).not.toBe(previousBinding)
    expect(configText()).toBe(beforeMouseDown)
    expect(readProjectRules(project).lines).toEqual(originalLines)
    expect(readFileSync(rulesFile, "utf8")).toBe(original)
    initialConfig = configText()
    expect(JSON.parse(initialConfig).note).toBe("config header")
    expect(JSON.parse(initialConfig).future).toEqual({ enabled: true })

    const tabConfig = initialConfig.replace('"node_modules/"', '"updated-on-tab/"')
    await replaceConfig(tabConfig)
    dialogKeys().get("next-tab")!()
    await view.renderOnce()
    expect(tabColor("Settings")).toEqual(theme.text.muted.toInts())
    expect(tabColor("Ignore Rules")).toEqual(theme.text.formfield.selected.toInts())
    expect(dialogKeys().has("setting-change")).toBe(false)
    expect(view.captureCharFrame()).not.toContain("Appearance")
    expect(view.captureCharFrame()).toContain("updated-on-tab/") // Switching tabs re-reads live rules.
    expect(configText()).toBe(tabConfig)
    await replaceConfig(initialConfig)
    dialogKeys().get("previous-tab")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Appearance")
    await clickText("Ignore Rules")
    expect(view.captureCharFrame()).toContain("node_modules/")
    storageError = new Error("storage denied")
    promptValue = "must-not-save/"
    dialogKeys().get("add")!()
    await Bun.sleep(100)
    await view.renderOnce()
    expect(configText()).toBe(initialConfig)
    expect(toasts.at(-1)?.message).toContain("Could not save ignore rules: storage denied")
    await clickText("delete")
    await Bun.sleep(50)
    expect(configText()).toBe(initialConfig)
    expect(toasts.at(-1)?.message).toContain("Could not save ignore rules: storage denied")
    storageError = undefined
    promptValue = undefined
    assertHeader()
    const frameRows = view.captureCharFrame().split("\n")
    const actionsRow = frameRows.findIndex((row) => row.includes("a add"))
    expect(actionsRow).toBeGreaterThan(0)
    expect(frameRows[actionsRow]!.trim()).toBe("a add · d delete · p preview")
    expect(frameRows[actionsRow]!.indexOf("a add")).toBe(2) // Left-aligned like the host's dialog footer.
    expect(frameRows.slice(actionsRow + 1).join("").trim()).toBe("") // One row, no extra navigation toolbar.
    expect(view.captureCharFrame()).not.toContain("wrong-source/")
    expect(view.captureCharFrame()).not.toContain("No ignore rules")
    expect(view.captureCharFrame()).not.toMatch(/[╭╮╰╯│]/)
    const title = view.captureSpans().lines[0]!.spans.find((span) => span.text.includes("Dir Tree Sidebar"))
    expect(title?.fg.toInts()).toEqual(theme.text.base.toInts())
    const footer = view.captureSpans().lines[actionsRow]!
    expect(footer.spans.find((span) => span.text.trim() === "a")?.fg.toInts()).toEqual(theme.text.base.toInts())
    expect(footer.spans.find((span) => span.text.includes("add"))?.fg.toInts()).toEqual(theme.text.muted.toInts())
    expect(footer.spans.find((span) => span.text.trim() === "d")?.fg.toInts()).toEqual(theme.text.base.toInts())
    expect(footer.spans.find((span) => span.text.trim() === "p")?.fg.toInts()).toEqual(theme.text.base.toInts())
    expect(footer.spans.every((span) => span.bg.toInts().join() === title!.bg.toInts().join())).toBe(true) // No button background.

    expect(dialogKeys().has("add")).toBe(true)
    expect(dialogKeys().has("remove")).toBe(true)
    expect(commands().find((item) => item.id === "dir-tree.ignore.close")?.bind).toBe("escape")
    dialogKeys().get("j")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("❯ *.log")
    dialogKeys().get("up")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("❯ node_modules/")

    await clickText("*.log")
    expect(view.captureCharFrame()).toContain("❯ *.log")
    await clickText("Settings")
    await clickText("Ignore Rules")
    expect(view.captureCharFrame()).toContain("❯ *.log")
    expect(configText()).toBe(initialConfig)

    // Preview shows the stored JSON, including rule comments, blanks and
    // wrapped long lines. It has no editing commands and performs no writes.
    const previewConfig = initialConfig.replace("config header", "externally changed")
    await replaceConfig(previewConfig)
    await clickText("p preview")
    assertHeader()
    expect(view.captureCharFrame()).toContain("Config preview · read-only")
    expect(view.captureCharFrame()).toContain("p back")
    expect(view.captureCharFrame()).not.toContain("d delete")
    expect(view.captureCharFrame()).toContain("externally changed")
    expect(view.captureCharFrame()).not.toContain("(empty line)")
    expect(dialogKeys().has("add")).toBe(false)
    expect(dialogKeys().has("remove")).toBe(false)
    let sawComment = false
    for (let i = 0; i < 40; i++) {
      sawComment ||= view.captureCharFrame().includes("# keep this comment")
      if (sawComment && view.captureCharFrame().includes("end-rule/")) break
      dialogKeys().get("j")!()
      await view.renderOnce()
    }
    expect(sawComment).toBe(true)
    expect(view.captureCharFrame()).toContain("end-rule/")
    expect(readFileSync(rulesFile, "utf8")).toBe(original)
    expect(configText()).toBe(previewConfig)
    await clickText("back") // Descriptions remain clickable, not just the key.
    assertHeader()
    expect(view.captureCharFrame()).toContain("❯ *.log")
    expect(dialogKeys().has("add")).toBe(true)
    dialogKeys().get("preview")!()
    dialogKeys().get("next-tab")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Appearance")
    expect(view.captureCharFrame()).not.toContain("read-only")
    dialogKeys().get("previous-tab")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("❯ *.log")
    expect(view.captureCharFrame()).toContain("a add · d delete · p preview")

    // Keyboard paging keeps the selected rule visible rather than clipped.
    for (let i = 0; i < 30; i++) dialogKeys().get("j")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("❯ build-19/")
    dialogKeys().get("next-tab")!()
    await view.renderOnce()
    await clickText("Ignore Rules")
    expect(view.captureCharFrame()).toContain("❯ build-19/") // Switching back reveals a selection below the first page.

    // Add a new rule: prompt resolves, only host storage changes, tree refreshes.
    promptValue = "dist/"
    const pendingPrompt = Promise.withResolvers<string | undefined>()
    delayPrompt = pendingPrompt.promise
    const listCallsBefore = listCalls
    await clickText("a add")
    expect(dialogKeys().has("remove")).toBe(false) // prompt replaces and disposes the manager
    expect(dialogKeys().has("next-tab")).toBe(false) // Settings keys must not intercept prompt typing.
    const concurrentLines = [...originalLines, "external/"]
    await setProjectRules(project, concurrentLines) // Another terminal saves while the prompt is open.
    pendingPrompt.resolve(promptValue)
    delayPrompt = undefined
    await Bun.sleep(100)
    expect(readProjectRules(project).lines).toEqual([...concurrentLines, "dist/"])
    expect(readFileSync(rulesFile, "utf8")).toBe(original)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("❯ dist/")
    assertHeader()
    dialogKeys().get("preview")!()
    await view.renderOnce()
    for (let i = 0; i < 4 && !view.captureCharFrame().includes("dist/"); i++) {
      dialogKeys().get("page-down")!()
      await view.renderOnce()
    }
    expect(view.captureCharFrame()).toContain("dist/")
    dialogKeys().get("preview")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("❯ dist/")
    expect(toasts.some(({ variant, message }) => variant === "success" && message === "Rule added")).toBe(true)
    await Bun.sleep(300)
    expect(listCalls).toBeGreaterThan(listCallsBefore) // scheduleRefresh fired

    // Adding the exact same line is a no-op with an informational toast.
    promptValue = "dist/"
    dialogKeys().get("add")!()
    await Bun.sleep(100)
    expect(readProjectRules(project).lines).toEqual([...concurrentLines, "dist/"])
    expect(toasts.some(({ variant, message }) => variant === "info" && message === "Rule already exists")).toBe(true)

    // The freshly added line is selected; delete removes exactly that line.
    await clickText("delete")
    await Bun.sleep(50)
    expect(readProjectRules(project).lines).toEqual(concurrentLines)
    expect(readFileSync(rulesFile, "utf8")).toBe(original)
    expect(toasts.some(({ variant, message }) => variant === "success" && message === "Rule deleted")).toBe(true)
    if (config === ".dirtreeignore") expect(existsSync(join(project, ".opencode", ".dirtreeignore"))).toBe(false)
    await setProjectRules(project, [...concurrentLines, "later-external/"])
    await clickText("delete")
    await Bun.sleep(50)
    expect(readProjectRules(project).lines).toEqual([...concurrentLines, "later-external/"])
    expect(toasts.some(({ variant, message }) => variant === "error" && message.includes("another terminal"))).toBe(true)
    await view.renderOnce()
    dialogKeys().get("j")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("❯ later-external/")
    await clickText("delete") // Retry from the refreshed list, without reopening.
    await Bun.sleep(50)
    expect(readProjectRules(project).lines).toEqual(concurrentLines)
    // The empty-file view from the reported screenshot uses the same header.
    await setProjectRules(project, [])
    command.run()
    await Bun.sleep(50)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Appearance")
    await clickText("Ignore Rules")
    assertHeader()
    const emptyRows = view.captureCharFrame().trimEnd().split("\n")
    const emptyTitle = emptyRows.findIndex((row) => row.includes("No ignore rules"))
    expect(emptyTitle).toBeGreaterThan(2)
    expect(emptyRows[emptyTitle]!.indexOf("No ignore rules")).toBeGreaterThan(2) // Centered, not pinned to a border.
    expect(emptyRows.findIndex((row) => row.includes("a add"))).toBe(actionsRow) // Both tabs keep the footer in the same place.
    expect(emptyRows.find((row) => row.includes("a add"))!.trim()).toBe("a add · d delete · p preview")
    expect(emptyRows.join("\n")).toContain("Press a to add a rule")
    expect(emptyRows.join("\n")).not.toContain("PgUp/PgDn")
    const disabledDelete = view.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("delete"))
    expect(disabledDelete?.fg.toInts()).toEqual(theme.text.muted.toInts())
    expect(disabledDelete?.bg.toInts()).toEqual(title!.bg.toInts())
    await setProjectRules(project, ["visible-after-navigation/"])
    const navigationConfig = configText()
    dialogKeys().get("j")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("❯ visible-after-navigation/")
    expect(configText()).toBe(navigationConfig)
    await setProjectRules(project, ["visible-after-click/"])
    await clickText("visible-after-navigation/")
    expect(view.captureCharFrame()).toContain("❯ visible-after-click/")
    const cancelledPrompt = Promise.withResolvers<string | undefined>()
    delayPrompt = cancelledPrompt.promise
    dialogKeys().get("add")!()
    await view.renderOnce()
    await setProjectRules(project, ["changed-while-cancelled/"])
    cancelledPrompt.resolve(undefined)
    delayPrompt = undefined
    await Bun.sleep(100)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("changed-while-cancelled/")
    const replacedPrompt = Promise.withResolvers<string | undefined>()
    delayPrompt = replacedPrompt.promise
    dialogKeys().get("add")!()
    await view.renderOnce()
    context.ui.dialog.show(() => <text>Another dialog</text>)
    await Bun.sleep(50)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Another dialog")
    expect(view.captureCharFrame()).not.toContain("Dir Tree Sidebar")
    expect(readProjectRules(project).lines).toEqual(["changed-while-cancelled/"])
    replacedPrompt.resolve("must-not-save/")
    delayPrompt = undefined
    command.run()
    await Bun.sleep(50)
    await view.renderOnce()
    await clickText("Ignore Rules")
    const validConfig = configText()
    await setProjectRules(project, [1] as never)
    dialogKeys().get("add")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Dir Tree Sidebar") // A bad read must not open the prompt.
    expect(toasts.some(({ message }) => message.includes("Could not read configuration") && message.includes("single-line strings"))).toBe(true)
    expect((durable.get(CONFIG_STORAGE_KEY)![0] as any).projects[projectKey(project)].ignore).toEqual([1])
    dialogKeys().get("next-tab")!()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("a add · d delete · p preview") // Bad config blocks tab commands, but never Escape.
    await clickText("esc")
    expect(dialogKeys().has("add")).toBe(false)
    expect(view.captureCharFrame()).not.toContain("Dir Tree Sidebar")
    expect((durable.get(CONFIG_STORAGE_KEY)![0] as any).projects[projectKey(project)].ignore).toEqual([1])
    await replaceConfig(validConfig)
    await setProjectRules(project, [])
    command.run()
    await Bun.sleep(50)
    await view.renderOnce()
    await clickText("Ignore Rules")
    const closedSave = Promise.withResolvers<void>()
    const closedSaveStarted = Promise.withResolvers<void>()
    delayConfigSave = closedSave.promise
    configSaveStarted = () => closedSaveStarted.resolve()
    promptValue = "confirmed-before-close/"
    dialogKeys().get("add")!()
    await closedSaveStarted.promise
    delayConfigSave = undefined
    configSaveStarted = undefined
    command.run() // A new manager in the same directory owns the dialog now.
    await Bun.sleep(50)
    await view.renderOnce()
    await clickText("esc")
    closedSave.resolve()
    await Bun.sleep(50)
    await view.renderOnce()
    expect(readProjectRules(project).lines).toEqual(["confirmed-before-close/"])
    expect(view.captureCharFrame()).not.toContain("Dir Tree Sidebar")
    await setProjectRules(project, [])
    // A prompt from the old project can finish after a different project's
    // manager opened. Its save must not replace that manager's view state.
    context.client.location.get = async () => {
      const directory = context.location!.directory
      return { directory, project: { id: "test-project", directory, canonical: directory } }
    }
    command.run()
    await Bun.sleep(50)
    await view.renderOnce()
    await clickText("Ignore Rules")
    const oldSave = Promise.withResolvers<void>()
    const saveStarted = Promise.withResolvers<void>()
    delayConfigSave = oldSave.promise
    configSaveStarted = () => saveStarted.resolve()
    promptValue = "old-project-only/"
    dialogKeys().get("add")!()
    await saveStarted.promise
    delayConfigSave = undefined
    configSaveStarted = undefined
    const nextProject = join(project, "another-project")
    mkdirSync(nextProject)
    Object.assign(context, { location: { directory: nextProject } })
    command.run()
    await Bun.sleep(50)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Appearance")
    const sharedBindings = { ...liveSettings().mouse }
    for (const { id, label } of MOUSE_ACTIONS) {
      expect(view.captureCharFrame().split("\n").find((row) => row.includes(label))!.trimEnd().endsWith(`${sharedBindings[id]}-click`)).toBe(true)
    }
    const beforeOtherProjectBinding = configText()
    await clickText("Open file")
    await settleSettings()
    expect(liveSettings().mouse.openFile).not.toBe(sharedBindings.openFile)
    expect(configText()).toBe(beforeOtherProjectBinding)
    expect(readProjectRules(nextProject).configured).toBe(false)
    await clickText("Ignore Rules")
    expect(view.captureCharFrame()).toContain("No ignore rules")
    oldSave.resolve()
    await Bun.sleep(100)
    await view.renderOnce()
    expect(readProjectRules(project).lines).toEqual(["old-project-only/"])
    expect(readProjectRules(nextProject).configured).toBe(false)
    expect(view.captureCharFrame()).toContain("No ignore rules")
    expect(view.captureCharFrame()).not.toContain("old-project-only/")
    expect(dialogKeys().has("add")).toBe(true)
    dialogKeys().get("close")!()
    await view.renderOnce()
    const finalConfig = configText()
    context.client.location.get = async () => { throw new Error("root probe failed") }
    command.run()
    await Bun.sleep(50)
    expect(toasts.at(-1)?.message).toContain("Could not determine project root")
    expect(configText()).toBe(finalConfig)
    expect(view.captureCharFrame()).not.toContain("Dir Tree Sidebar")
    const delayedRoot = Promise.withResolvers<any>()
    context.client.location.get = () => delayedRoot.promise
    command.run()
    cleanup()
    cleanup = () => {}
    delayedRoot.resolve({ project: { directory: nextProject } })
    await Bun.sleep(50)
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("Dir Tree Sidebar")
  } finally {
    cleanup()
    view?.renderer.destroy()
    rmSync(project, { recursive: true, force: true })
  }
})
