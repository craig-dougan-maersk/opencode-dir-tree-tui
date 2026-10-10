/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import { spawn } from "node:child_process"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { MouseButton, RGBA, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core"
import type { MouseEvent } from "@opentui/core"
import type { GitStatus, TreeStore, TreeNode } from "../tree"
import { MOUSE_ACTIONS } from "../config"

/** Nested semantic tokens replaced V1's flat TuiThemeCurrent. */
type Theme = Plugin.Context["theme"]
/** VS Code-derived palette: one green and one red, fixed across themes/modes. */
const GIT_STATUS_COLORS: Record<GitStatus, RGBA> = {
  added: RGBA.fromHex("#73c991"),
  untracked: RGBA.fromHex("#73c991"),
  renamed: RGBA.fromHex("#73c991"),
  modified: RGBA.fromHex("#e2c08d"),
  deleted: RGBA.fromHex("#c74e39"),
  conflicting: RGBA.fromHex("#c74e39"),
  ignored: RGBA.fromHex("#8c8c8c"),
}

/** Resolve when the launcher starts, or reject if it cannot be spawned. */
function openPath(absolutePath: string): Promise<void> {
  const cmd =
    process.platform === "win32"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), absolutePath.replaceAll("/", "\\")]
      : [process.platform === "darwin" ? "open" : "xdg-open", absolutePath]
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "ignore" })
      child.once("error", reject)
      child.once("spawn", () => {
        child.unref()
        resolve()
      })
    } catch (error) {
      reject(error)
    }
  })
}

interface DirTreePanelProps {
  store: TreeStore
  theme: Accessor<Theme>
  collapsed: Accessor<boolean>
  onToggle: () => void
}

export function DirTreePanel(props: DirTreePanelProps) {
  const rows = createMemo(() => props.store.visibleRows())
  const clipboard = createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(props.store.context.renderer),
  })
  onCleanup(() => { void clipboard.dispose() })

  /** indent + expand marker, then the name in one colored run. */
  const rowText = (node: TreeNode, depth: number): string => {
    const indent = "  ".repeat(depth)
    const marker = node.isDir ? (props.store.isExpanded(node.path) ? "▾ " : "▸ ") : "  "
    return indent + marker + node.name
  }

  const rowColor = (node: TreeNode): RGBA => {
    if (node.isDir) return props.theme().text.formfield.selected
    const status = props.store.gitStatus(node)
    return status ? GIT_STATUS_COLORS[status] : props.theme().text.base
  }

  const showError = (message: string, error: unknown) => props.store.context.ui.toast.show({
    variant: "error",
    title: "Dir Tree",
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
    duration: 5000,
  })

  const showSuccess = (message: string) => props.store.context.ui.toast.show({
    variant: "success",
    title: "Dir Tree",
    message,
    duration: 1500,
  })

  const open = (node: TreeNode) => {
    void openPath(node.absolute).then(
      () => showSuccess(node.isDir ? "Opening folder" : "Opening file"),
      (error: unknown) => showError(`Could not open ${node.name}`, error),
    )
  }

  const openProject = async (copy = false) => {
    try {
      const location = props.store.context.location
      if (!location) throw new Error("Workspace is not available")
      const info = await props.store.context.client.location.get({ location })
      if (copy) {
        await copyPath({
          name: "project folder", path: "", isDir: true,
          absolute: process.platform === "win32" ? info.project.directory.replaceAll("\\", "/") : info.project.directory,
        })
      } else {
        await openPath(info.project.directory)
        showSuccess("Opening project folder")
      }
    } catch (error) {
      showError(copy ? "Could not copy project directory" : "Could not open project directory", error)
    }
  }

  const copyPath = async (node: TreeNode) => {
    try {
      const result = await clipboard.writeText(node.absolute, { destination: "best-available" })
      if (result.host.status !== "written" && result.terminal.status !== "attempted") {
        throw result.host.status === "failed" ? result.host.error : new Error("Clipboard is not available")
      }
      showSuccess(result.host.status === "written" ? "Path copied" : "Copy request sent")
    } catch (error) {
      showError(`Could not copy ${node.name}`, error)
    }
  }

  const mouseActions = (event: MouseEvent, isDir: boolean) => {
    const button = event.button === MouseButton.LEFT ? "left"
      : event.button === MouseButton.MIDDLE ? "middle"
        : event.button === MouseButton.RIGHT ? "right" : undefined
    if (!button) return []
    const bindings = props.store.mouseBindings()
    return MOUSE_ACTIONS.filter(({ id, target }) => target === (isDir ? "folder" : "file") && bindings[id] === button)
  }

  const onRowMouseDown = (event: MouseEvent, node: TreeNode) => {
    // Keep tree clicks from triggering the global text-selection system.
    event.preventDefault()
    for (const { id } of mouseActions(event, node.isDir)) {
      if (id === "openFile" || id === "openFolder") open(node)
      else if (id === "copyFilePath" || id === "copyFolderPath") void copyPath(node)
      else if (id === "toggleFolder") props.store.toggle(node.path)
    }
  }

  const title = () => (props.collapsed() ? "▶ Dir Tree" : "▼ Dir Tree")

  return (
    <box flexDirection="column">
      <box flexDirection="row" onMouseDown={(event) => {
        event.preventDefault()
        if (event.button === MouseButton.LEFT || event.button === MouseButton.RIGHT) {
          props.onToggle()
          return
        }
        for (const { id } of mouseActions(event, true)) {
          if (id === "openFolder") void openProject()
          else if (id === "copyFolderPath") void openProject(true)
          else if (id === "toggleFolder") props.onToggle()
        }
      }}>
        <text style={{ fg: props.theme().text.base }}>
          <strong>{title()}</strong>
        </text>
      </box>

      <Show when={!props.collapsed()}>
        <Show when={props.store.loadError()}>
          {(error) => <text style={{ fg: props.theme().text.feedback.error.base }}>{error()}</text>}
        </Show>

        <For each={rows()} fallback={<text style={{ fg: props.theme().text.muted }}>No files listed</text>}>
          {(row) => (
            <box onMouseDown={(event) => onRowMouseDown(event, row.node)} flexDirection="row">
              <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate style={{ fg: rowColor(row.node) }}>
                {rowText(row.node, row.depth)}
              </text>
              <Show when={!row.node.isDir && props.store.gitStatusCode(row.node)}>
                {(code) => <text width={2} flexShrink={0} marginLeft={1} textAlign="right" wrapMode="none" style={{ fg: rowColor(row.node) }}>
                  {code()}
                </text>}
              </Show>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
