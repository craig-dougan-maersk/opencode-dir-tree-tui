/** @jsxImportSource @opentui/solid */

import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import { MouseButton } from "@opentui/core"
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { TreeStore } from "../tree"
import { MOUSE_ACTIONS } from "../config"
import type { ProjectRules, ProjectSettings, SettingsChange } from "../config"

type Tab = "settings" | "rules"
const dialogs = new WeakMap<Plugin.Context, object>()

interface DialogProps {
  store: TreeStore
  state: { tab: Tab; settings: ProjectSettings; lines: string[]; selected: number; previewLines: string[]; busy: boolean }
  onTab: (tab: Tab) => void
  onReload: () => boolean
  onMove: (delta: number) => void
  onSelect: (index: number) => void
  onRemove: () => void
  onAdd: () => void
  onChange: (change: SettingsChange) => void
}

function DirTreeSettingsDialog(props: DialogProps) {
  const context = props.store.context
  const theme = () => context.theme
  const dimensions = useTerminalDimensions()
  const [preview, setPreview] = createSignal(false)
  const [settingIndex, setSettingIndex] = createSignal(0)
  const settings = [
    { id: "visible" as const, label: "Show file tree", category: "Appearance" },
    ...MOUSE_ACTIONS.map((action) => ({ ...action, category: "Mouse bindings" })),
  ]
  let row = 0
  let category = ""
  const settingRows = settings.map((setting, index) => {
    const heading = setting.category !== category
    const gap = heading && index > 0 ? 1 : 0
    if (heading) row += 1 + gap
    category = setting.category
    return { ...setting, heading, gap, row: row++ }
  })
  const buttonLabels = { left: "left-click", middle: "middle-click", right: "right-click", off: "off" }
  const rulesTab = () => props.state.tab === "rules"
  const rows = () => preview() ? props.state.previewLines : props.state.lines
  const viewportHeight = () => Math.max(3, Math.min(14, dimensions().height - 7))
  const digits = () => String(rows().length || 1).length
  let scroll: ScrollBoxRenderable | undefined
  onCleanup(() => { scroll?.viewport.off("resize", revealSelected) })
  const revealSelected = () => {
    if (preview() || !scroll) return
    // Row offsets avoid stale child coordinates after tab switches or wrapped previews.
    const selected = rulesTab() ? props.state.selected : settingRows[settingIndex()]?.row ?? 0
    const top = selected < scroll.scrollTop ? selected
      : selected >= scroll.scrollTop + viewportHeight() ? selected - viewportHeight() + 1 : scroll.scrollTop
    const length = rulesTab() ? props.state.lines.length : settingRows.at(-1)!.row + 1
    scroll.scrollTo(Math.max(0, Math.min(top, length - viewportHeight())))
  }
  createEffect(() => {
    props.state.selected
    props.state.tab
    settingIndex()
    revealSelected()
  })
  const move = (delta: number) => {
    if (!props.onReload()) return
    if (preview()) scroll?.scrollBy(delta)
    else if (rulesTab()) props.onMove(delta)
    else {
      const count = settingRows.length
      setSettingIndex((index) => (index + delta % count + count) % count)
    }
  }
  const jump = (last: boolean) => {
    if (!props.onReload()) return
    if (preview()) scroll?.scrollTo(last ? scroll.scrollHeight : 0)
    else if (rulesTab()) props.onMove(last ? props.state.lines.length : -props.state.lines.length)
    else setSettingIndex(last ? settingRows.length - 1 : 0)
  }
  const togglePreview = () => {
    if (!props.onReload()) return
    setPreview((value) => !value)
    if (preview()) scroll?.scrollTo(0)
  }
  const selectTab = (tab: Tab) => {
    if (!props.onReload()) return
    setPreview(false)
    props.onTab(tab)
    if (tab === "settings") revealSelected()
  }
  const switchTab = () => selectTab(rulesTab() ? "settings" : "rules")
  const selectSetting = (index: number) => {
    if (props.onReload()) setSettingIndex(index)
  }
  const changeSetting = (delta: -1 | 1, index = settingIndex()) => {
    const setting = settingRows[index]
    if (!setting) return
    props.onChange(setting.id === "visible"
      ? { kind: "visibility" }
      : { kind: "mouse", action: setting.id, delta })
  }
  const click = (event: MouseEvent, action: () => void) => {
    if (event.button !== MouseButton.LEFT) return
    event.preventDefault()
    action()
  }
  const close = () => {
    props.onReload()
    context.ui.dialog.clear() // Closing must still work with an invalid config.
  }
  const actions = [
    { key: "a", label: "add", run: props.onAdd, enabled: () => !props.state.busy },
    { key: "d", label: "delete", run: props.onRemove, enabled: () => !!props.state.lines.length && !props.state.busy },
    { key: "p", label: "preview", run: togglePreview, enabled: () => true },
  ]
  // Created here, the keymap layer dies with the dialog — including when a
  // nested dialog.prompt replaces this one, so prompt typing stays untouched.
  context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { id: "dir-tree.ignore.up", bind: "up,ctrl+p", title: "Previous item", run: () => move(-1) },
      { id: "dir-tree.ignore.down", bind: "down,ctrl+n", title: "Next item", run: () => move(1) },
      { id: "dir-tree.ignore.j", bind: "j", title: "Next rule", enabled: rulesTab, run: () => move(1) },
      { id: "dir-tree.ignore.k", bind: "k", title: "Previous rule", enabled: rulesTab, run: () => move(-1) },
      { id: "dir-tree.ignore.page-up", bind: "pageup", title: "Page up", run: () => move(rulesTab() ? -viewportHeight() : -10) },
      { id: "dir-tree.ignore.page-down", bind: "pagedown", title: "Page down", run: () => move(rulesTab() ? viewportHeight() : 10) },
      { id: "dir-tree.ignore.home", bind: "home", title: "First item", run: () => jump(false) },
      { id: "dir-tree.ignore.end", bind: "end", title: "Last item", run: () => jump(true) },
      { id: "dir-tree.ignore.next-tab", bind: "tab", title: "Next settings tab", run: switchTab },
      { id: "dir-tree.ignore.previous-tab", bind: "shift+tab", title: "Previous settings tab", run: switchTab },
      { id: "dir-tree.ignore.setting-previous", bind: "left", title: "Previous value", enabled: () => !rulesTab() && !props.state.busy, run: () => changeSetting(-1) },
      { id: "dir-tree.ignore.setting-next", bind: "right", title: "Next value", enabled: () => !rulesTab() && !props.state.busy, run: () => changeSetting(1) },
      { id: "dir-tree.ignore.setting-change", bind: "enter", title: "Change value", enabled: () => !rulesTab() && !props.state.busy, run: () => changeSetting(1) },
      { id: "dir-tree.ignore.preview", bind: "p", title: "Preview configuration", enabled: rulesTab, run: togglePreview },
      { id: "dir-tree.ignore.add", bind: "a", title: "Add ignore rule", enabled: () => rulesTab() && !preview() && !props.state.busy, run: () => void props.onAdd() },
      { id: "dir-tree.ignore.remove", bind: "d", title: "Delete ignore rule", enabled: () => rulesTab() && !preview() && !props.state.busy, run: () => props.onRemove() },
      { id: "dir-tree.ignore.close", bind: "escape", title: "Close", run: close },
    ],
  }))

  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" paddingX={2} gap={1}>
        <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
          <text flexShrink={0} fg={theme().text.base}><strong>{preview() ? "Config preview" : "Dir Tree Sidebar"}</strong></text>
          <Show when={preview()}>
            <text flexShrink={1} minWidth={0} wrapMode="none" truncate fg={theme().text.muted}> · read-only</text>
          </Show>
        </box>
        <text flexShrink={0} textAlign="right" fg={theme().text.muted} selectable={false} onMouseUp={(event) => click(event, close)}>esc</text>
      </box>
      <box flexDirection="row" paddingX={2} marginTop={1} gap={2} height={1} flexShrink={0}>
        <For each={[
          { id: "settings" as const, label: "Settings" },
          { id: "rules" as const, label: "Ignore Rules" },
        ]}>
          {(tab) => <text
            flexShrink={0} selectable={false}
            fg={props.state.tab === tab.id ? theme().text.formfield.selected : theme().text.muted}
            onMouseUp={(event) => click(event, () => selectTab(tab.id))}
          >
            <Show when={props.state.tab === tab.id} fallback={tab.label}><strong>{tab.label}</strong></Show>
          </text>}
        </For>
        <text flexGrow={1} textAlign="right" fg={theme().text.muted} selectable={false} onMouseUp={(event) => click(event, switchTab)}>tab</text>
      </box>
      <scrollbox
        ref={(value) => {
          scroll = value
          value.viewport.on("resize", revealSelected) // After the native scrollbar sizes are recalculated.
        }}
        onSizeChange={revealSelected}
        marginTop={1} height={viewportHeight()} flexShrink={0}
        scrollX={false}
        scrollbarOptions={{ visible: false }}
      >
        <Show when={rulesTab()} fallback={
          <For each={settingRows}>
            {(setting, index) => {
              const selected = () => index() === settingIndex()
              return <box flexDirection="column" flexShrink={0}>
                <Show when={setting.heading}>
                  <text marginX={2} marginTop={setting.gap} fg={theme().text.formfield.selected}>
                    <strong>{setting.category}</strong>
                  </text>
                </Show>
                <box
                  id={`dir-tree-setting-${index()}`}
                  flexDirection="row" paddingX={2} gap={1} height={1} flexShrink={0}
                  onSizeChange={() => { if (selected()) revealSelected() }}
                  backgroundColor={selected() ? theme().background.action.primary.focused : undefined}
                  onMouseMove={() => { if (!selected()) selectSetting(index()) }}
                  onMouseDown={(event) => click(event, () => selectSetting(index()))}
                  onMouseUp={(event) => click(event, () => changeSetting(1, index()))}
                >
                  <text flexGrow={1} minWidth={0} wrapMode="none" truncate fg={selected() ? theme().text.action.primary.focused : theme().text.base} selectable={false}>{setting.label}</text>
                  <text flexShrink={0} textAlign="right" fg={selected() ? theme().text.action.primary.focused : theme().text.muted} selectable={false}>
                    {setting.id === "visible" ? props.state.settings.visible ? "on" : "off" : buttonLabels[props.store.mouseBindings()[setting.id]]}
                  </text>
                </box>
              </box>
            }}
          </For>
        }>
          <For each={rows()} fallback={
            <box height={viewportHeight()} justifyContent="center">
              <text textAlign="center" fg={theme().text.base}>
                {preview() ? "No configuration yet" : "No ignore rules"}
              </text>
              <text textAlign="center" fg={theme().text.muted}>
                {preview() ? "Change visibility or add a rule" : "Press a to add a rule"}
              </text>
            </box>
          }>
            {(line, index) => {
              const selected = () => !preview() && index() === props.state.selected
              return (
                <box
                  id={`dir-tree-ignore-line-${index()}`}
                  flexDirection="row"
                  paddingX={2}
                  flexShrink={0}
                  height={preview() ? undefined : 1}
                  onSizeChange={() => { if (selected()) revealSelected() }}
                  backgroundColor={selected() ? theme().background.action.primary.focused : undefined}
                  onMouseDown={(event) => {
                    if (!preview()) click(event, () => props.onSelect(index()))
                  }}
                >
                  <text width={digits() + 1} textAlign="right" fg={selected() ? theme().text.action.primary.focused : theme().text.muted} selectable={false}>
                    {index() + 1}{" "}
                  </text>
                  <Show when={!preview()}>
                    <text width={2} fg={theme().text.action.primary.focused} selectable={false}>{selected() ? "❯ " : "  "}</text>
                  </Show>
                  <text
                    flexGrow={1} minWidth={0}
                    wrapMode={preview() ? "char" : "none"}
                    truncate={!preview()}
                    selectable={preview()}
                    fg={selected() ? theme().text.action.primary.focused : line.startsWith("#") ? theme().text.muted : theme().text.base}
                  >
                    {line || (preview() ? " " : "(empty line)")}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </scrollbox>
      <box flexDirection="row" paddingX={2} height={1} flexShrink={0} marginTop={1}>
        <Show when={rulesTab()} fallback={<text fg={theme().text.base}><strong>←/→</strong><span style={{ fg: theme().text.muted }}> change</span></text>}>
          <For each={actions}>
            {(action, index) => <Show when={!preview() || action.key === "p"}>
              <Show when={!preview() && index() > 0}>
                <text fg={theme().text.muted} selectable={false}> · </text>
              </Show>
              <text
                flexShrink={0} wrapMode="none" selectable={false}
                fg={action.enabled() ? theme().text.base : theme().text.muted}
                onMouseUp={(event) => click(event, action.run)}
              >
                {action.key}{" "}<span style={{ fg: theme().text.muted }}>{preview() ? "back" : action.label}</span>
              </text>
            </Show>}
          </For>
        </Show>
      </box>
    </box>
  )
}

/** Open settings, with the current project's stored rules in their own tab. */
export async function openIgnoreDialog(context: Plugin.Context, store: TreeStore): Promise<void> {
  if (store.isDisposed()) return
  const instance = {}
  dialogs.set(context, instance)
  const directory = context.location?.directory
  if (!directory) {
    context.ui.toast.show({ variant: "error", title: "Dir Tree Sidebar", message: "Workspace is not available yet", duration: 5000 })
    return
  }
  let root: string
  try {
    const info = await context.client.location.get({ location: { directory } })
    root = info.project.directory
  } catch (error) {
    context.ui.toast.show({ variant: "error", title: "Dir Tree Sidebar", message: `Could not determine project root: ${error instanceof Error ? error.message : String(error)}`, duration: 5000 })
    return // Never create a subdirectory's entry when project discovery failed.
  }
  if (store.isDisposed() || context.location?.directory !== directory || dialogs.get(context) !== instance) return
  let config: ProjectRules
  try {
    config = store.config.read(root)
  } catch (error) {
    context.ui.toast.show({ variant: "error", title: "Dir Tree Sidebar", message: `Could not read configuration: ${error instanceof Error ? error.message : String(error)}`, duration: 5000 })
    return
  }
  if (context.location?.directory !== directory) return
  // A pending save from a closed dialog must not mutate a newly opened
  // project's view. This TSX module shares the host's Solid runtime.
  const [state, setState] = createStore({ tab: "settings" as Tab, settings: config.settings, lines: [] as string[], selected: 0, previewLines: [] as string[], busy: false })
  let prompting = false
  const update = (mutation: (draft: typeof state) => void) => setState(produce(mutation))
  const apply = (next: ProjectRules, selected = state.selected) => {
    config = next
    store.applySettings(directory, next.settings)
    update((draft) => {
      draft.settings = next.settings
      draft.lines = next.lines
      draft.selected = Math.max(0, Math.min(next.lines.length - 1, selected))
      draft.previewLines = next.text.split("\n")
    })
  }
  apply(config, 0)

  const toast = (variant: "success" | "info" | "error", message: string) =>
    context.ui.toast.show({ variant, title: "Dir Tree Sidebar", message, duration: variant === "error" ? 5000 : 1500 })

  const reload = () => {
    try {
      const fresh = store.config.read(root)
      if (fresh.text !== config.text || fresh.configured !== config.configured) {
        apply(fresh)
        store.scheduleRefresh(0)
      }
      return true
    } catch (error) {
      toast("error", `Could not read configuration: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  const move = (delta: number) => update((draft) => {
    if (!draft.lines.length) return
    draft.selected = Math.max(0, Math.min(draft.lines.length - 1, draft.selected + delta))
  })

  const changeSettings = async (change: SettingsChange) => {
    if (state.busy || !reload()) return
    update((draft) => { draft.busy = true })
    try {
      if (change.kind === "mouse") {
        await store.changeMouseBinding(change.action, change.delta)
      } else {
        const saved = await store.config.update(root, change)
        apply(saved)
        if (saved.changed) store.scheduleRefresh(0)
      }
    } catch (error) {
      reload()
      toast("error", `Could not save settings: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      update((draft) => { draft.busy = false })
    }
  }

  const remove = async () => {
    if (state.busy) return
    const index = state.selected
    const expected = [...state.lines]
    if (!reload()) return
    if (expected.length !== state.lines.length || expected.some((line, index) => line !== state.lines[index])) {
      toast("error", "Ignore rules changed in another terminal; review the refreshed list and retry deletion")
      return // Never delete a different line just because the list was reloaded.
    }
    if (index >= state.lines.length) return
    update((draft) => { draft.busy = true })
    try {
      const saved = await store.config.update(root, { kind: "remove", index, expected })
      apply(saved, index)
      store.scheduleRefresh(0)
      toast("success", "Rule deleted")
    } catch (error) {
      reload() // A change while waiting for the write lock also refreshes the view.
      toast("error", `Could not save ignore rules: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      update((draft) => { draft.busy = false })
    }
  }

  const add = async () => {
    if (state.busy || dialogs.get(context) !== instance || !reload()) return
    update((draft) => { draft.busy = true })
    prompting = true
    let restore = false
    // The prompt replaces the custom dialog (one shared channel); the panel
    // is rebuilt from live state after it settles.
    try {
      const value = await context.ui.dialog.prompt({
        title: "Add ignore rule",
        description: ".gitignore pattern — e.g. node_modules/ or *.log",
        placeholder: "node_modules/",
      })
      restore = context.keymap.mode.current() !== "modal"
      if (value?.trim()) {
        const saved = await store.config.update(root, { kind: "add", line: value })
        apply(saved, saved.lines.indexOf(value))
        store.scheduleRefresh(0)
        toast(saved.changed ? "success" : "info", saved.changed ? "Rule added" : "Rule already exists")
      }
    } catch (error) {
      toast("error", `Could not save ignore rules: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      prompting = false
      update((draft) => { draft.busy = false })
      const here = !store.isDisposed() && context.location?.directory === directory
      if (here) reload() // Includes cancelled or replaced prompts and changes made while typing.
      if (here && dialogs.get(context) === instance && restore && context.keymap.mode.current() !== "modal") {
        show()
      } else if (dialogs.get(context) === instance) {
        dialogs.delete(context)
      }
    }
  }

  const show = () => {
    context.ui.dialog.show(() => (
      <DirTreeSettingsDialog
        store={store}
        state={state}
        onTab={(tab) => update((draft) => { draft.tab = tab })}
        onReload={reload}
        onMove={move}
        onSelect={(index) => { if (reload()) update((draft) => { draft.selected = Math.min(index, Math.max(0, draft.lines.length - 1)) }) }}
        onRemove={() => void remove()}
        onAdd={add}
        onChange={(change) => void changeSettings(change)}
      />
    ), () => {
      if (!prompting && dialogs.get(context) === instance) dialogs.delete(context)
    })
    // Released hosts reset presentation when show() replaces the dialog.
    context.ui.dialog.set({ size: "large", centered: true })
  }
  show()
}
