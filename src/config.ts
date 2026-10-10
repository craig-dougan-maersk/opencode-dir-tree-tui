import { posix, resolve, win32 } from "node:path"
import type { Plugin } from "@opencode/plugin/tui"

const RULE_LIMIT = 65_536
export const CONFIG_STORAGE_KEY = "dir-tree.config"

export const MOUSE_BUTTONS = ["left", "middle", "right"] as const
export type MouseBinding = typeof MOUSE_BUTTONS[number] | "off"
export const MOUSE_ACTIONS = [
  { id: "openFile", label: "Open file", target: "file" },
  { id: "copyFilePath", label: "Copy file path", target: "file" },
  { id: "openFolder", label: "Open folder", target: "folder" },
  { id: "copyFolderPath", label: "Copy folder path", target: "folder" },
  { id: "toggleFolder", label: "Expand/collapse folder", target: "folder" },
] as const
export type MouseAction = typeof MOUSE_ACTIONS[number]["id"]
export type MouseBindings = Record<MouseAction, MouseBinding>
export const DEFAULT_MOUSE_BINDINGS: MouseBindings = {
  openFile: "right", copyFilePath: "middle", openFolder: "right", copyFolderPath: "middle", toggleFolder: "left",
}
export interface ProjectSettings {
  visible: boolean
}
export const DEFAULT_SETTINGS: ProjectSettings = { visible: true }

interface ProjectConfig {
  ignore?: string[]
  visible?: boolean
  [key: string]: unknown
}
export interface StoredConfig {
  projects: Record<string, ProjectConfig>
  [key: string]: unknown
}

/** Keep POSIX backslashes literal; Windows path spelling is case-insensitive. */
function normalizeKey(path: string): string {
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/i.test(path)
  const normalized = windows ? win32.normalize(path).replaceAll("\\", "/") : posix.normalize(path)
  const key = /^[a-z]:\/$/i.test(normalized) ? normalized : normalized.replace(/\/+$/, "") || "/"
  return windows && process.platform === "win32" ? key.toLowerCase() : key
}

export const projectKey = (root: string) => normalizeKey(resolve(root))
export const rulesText = (lines: readonly string[]) => lines.length ? `${lines.join("\n")}\n` : ""

function validateRules(lines: unknown): asserts lines is string[] {
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string" || /[\r\n\0]/.test(line))) {
    throw new Error("ignore must be an array of single-line strings (no NUL)")
  }
  if (Buffer.byteLength(rulesText(lines)) > RULE_LIMIT) throw new Error("Project ignore rules exceed 64 KiB")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validateConfig(data: StoredConfig): void {
  if (!isObject(data) || !isObject(data.projects)) throw new Error("Stored configuration projects must be an object")
  const keys = new Set<string>()
  for (const [key, project] of Object.entries(data.projects)) {
    const normalized = normalizeKey(key)
    if (keys.has(normalized)) throw new Error(`Duplicate stored project path: ${key}`)
    keys.add(normalized)
    if (!isObject(project)) throw new Error(`Project ${key} must be an object`)
    if (project.ignore !== undefined) validateRules(project.ignore)
    if (project.visible !== undefined && typeof project.visible !== "boolean") throw new Error("Project visible must be a boolean")
  }
}

function entry(data: StoredConfig, root: string) {
  const normalized = projectKey(root)
  const key = Object.keys(data.projects).find((key) => normalizeKey(key) === normalized) ?? normalized
  return { key, project: data.projects[key] }
}

function snapshot(data: StoredConfig, root: string) {
  const { project } = entry(data, root)
  return {
    lines: [...(project?.ignore ?? [])],
    text: JSON.stringify(data, null, 2),
    configured: project !== undefined,
    settings: { visible: project?.visible ?? true },
  }
}

export type ProjectRules = ReturnType<typeof snapshot>
export type SettingsChange = { kind: "visibility"; value?: boolean } | { kind: "mouse"; action: MouseAction; delta: -1 | 1 }
type RuleChange = { kind: "add"; line: string } | { kind: "remove"; index: number; expected: readonly string[] } | Extract<SettingsChange, { kind: "visibility" }>

export class ConfigStore {
  private readonly data: StoredConfig
  private readonly save: (mutation: (draft: StoredConfig) => void) => Promise<void>

  constructor(storage: Plugin.Context["storage"]) {
    const [data, save] = storage.store<StoredConfig>(CONFIG_STORAGE_KEY, { initial: { projects: {} } })
    this.data = data
    this.save = save
  }

  read(root: string): ProjectRules {
    validateConfig(this.data)
    return snapshot(this.data, root)
  }

  async update(root: string, change: RuleChange): Promise<ProjectRules & { changed: boolean }> {
    if (!["add", "remove", "visibility"].includes(change.kind)) throw new Error("Invalid project configuration change")
    if (change.kind === "add") validateRules([change.line])
    if (change.kind === "visibility" && change.value !== undefined && typeof change.value !== "boolean") throw new Error("visible must be a boolean")
    this.read(root)

    let saved!: ProjectRules & { changed: boolean }
    await this.save((draft) => {
      // The host locks and reloads storage before invoking this callback.
      validateConfig(draft)
      const current = snapshot(draft, root)
      const { key, project } = entry(draft, root)
      const next = { ...project }
      if (change.kind === "visibility") {
        next.visible = change.value ?? !current.settings.visible
        if (next.visible === current.settings.visible) {
          saved = { ...current, changed: false }
          return
        }
      } else {
        next.ignore = [...current.lines]
        if (change.kind === "add") {
          if (!next.ignore.includes(change.line)) next.ignore.push(change.line)
        } else {
          if (change.expected.length !== current.lines.length || change.expected.some((line, index) => line !== current.lines[index])) {
            throw new Error("Rules changed in another terminal; review the list before deleting")
          }
          if (!Number.isInteger(change.index) || change.index < 0 || change.index >= next.ignore.length) throw new Error("No rule selected")
          next.ignore.splice(change.index, 1)
        }
        validateRules(next.ignore)
      }
      const changed = JSON.stringify(next) !== JSON.stringify(project)
      if (changed) draft.projects[key] = next
      saved = { ...snapshot(draft, root), changed }
    })
    return saved
  }
}
