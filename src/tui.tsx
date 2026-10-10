/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { TreeStore } from "./tree"
import { DirTreePanel } from "./components/dir-tree-panel"
import { openIgnoreDialog } from "./components/ignore-dialog"

const STORAGE_PANEL = "dir-tree.panel"
const AUTO_REFRESH_MS = 10_000

export default Plugin.define({
  id: "opencode-dir-tree-tui",
  setup(context: Plugin.Context) {
    const store = new TreeStore(context)
    // storage.store synchronizes across every TUI instance (per V2 docs), so
    // collapsing in one terminal used to fold the panel in all of them.
    // Collapse is per-terminal view state: keep it in memory, which the host
    // scopes to this TUI (it survives plugin reloads, dies with the TUI).
    const [panel, updatePanel] = context.storage.memory(STORAGE_PANEL, {
      initial: { collapsed: false },
    })
    const collapsed = () => panel.collapsed
    const togglePanel = () => {
      const next = !collapsed()
      updatePanel((draft) => { draft.collapsed = next })
      // Collapsed panels skip polling; reopening refreshes immediately.
      if (!next) store.scheduleRefresh(0)
    }

    const unregisters = [
      // V2 replaced V1's workspace.ready/worktree.ready with server.connected;
      // project.updated kept its name and file.watcher.updated became
      // filesystem.changed ({ file, event: "add"|"change"|"unlink" }).
      context.data.on("server.connected", () => store.scheduleRefresh(0)),
      context.data.on("project.updated", () => store.scheduleRefresh(400)),
      context.data.on("filesystem.changed", () => store.scheduleRefresh(400)),
    ]

    // `/dirtree-sidebar` opens settings with a separate ignore-rules tab. The keymap layer's
    // lifetime follows the plugin (no unregister to keep, per V2 docs).
    context.keymap.layer(() => ({
      mode: "global", // Slash completion and the palette are not in base mode.
      commands: [{
        id: "dir-tree.ignore",
        title: "Open Dir Tree Sidebar settings",
        group: "Dir Tree",
        palette: true,
        slash: { name: "dirtree-sidebar" },
        run: () => void openIgnoreDialog(context, store),
      }],
    }))

    // Fallback: poll regularly so external changes (e.g. files removed or
    // edited outside opencode) surface even when watchers miss them. Skipped
    // while a visible panel is collapsed; hidden panels reload config only.
    // Goes straight
    // to refreshAll (not scheduleRefresh): the debouncer has no max-wait, so
    // a steady event stream would starve an indirect poll; refreshAll itself
    // coalesces overlapping passes.
    const autoRefresh = setInterval(() => {
      if (!collapsed() || !store.settings().visible) void store.refreshAll()
    }, AUTO_REFRESH_MS)

    // Initial load. The location may not be synced yet; the events above
    // re-schedule.
    void store.refreshAll()

    // A session switch is client-local: no server event fires for it, so the
    // slot's reactive sessionID prop is the only signal. context.location is
    // also reactive in render: a workspace move re-renders the slot even
    // without a session change. Either can land first, so track both — the
    // TreeStore's location generation does the actual swap and isolates late responses.
    let lastSessionID: string | undefined
    let lastDirectory: string | undefined
    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const sessionID = props?.sessionID
        const directory = context.location?.directory
        if (lastSessionID !== sessionID || lastDirectory !== directory) store.scheduleRefresh(0)
        lastSessionID = sessionID
        lastDirectory = directory
        return (
          <Show when={store.settings().visible}>
            <DirTreePanel
              store={store}
              theme={() => context.theme}
              collapsed={collapsed}
              onToggle={togglePanel}
            />
          </Show>
        )
      },
    })

    return () => {
      clearInterval(autoRefresh)
      store.dispose()
      unregisterSlot()
      for (const unregister of unregisters) unregister()
    }
  },
})
