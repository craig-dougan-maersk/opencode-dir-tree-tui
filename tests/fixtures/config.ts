import { createStore, reconcile } from "solid-js/store"
import type { Plugin } from "@opencode/plugin/tui"
import { CONFIG_STORAGE_KEY, projectKey } from "../../src/config"
import type { StoredConfig } from "../../src/config"

export function makeStorage(_key: string, options: { initial: object }) {
  let saved = structuredClone(options.initial)
  const [state, setState] = createStore(structuredClone(saved))
  return [state, async (mutation: (draft: object) => void) => {
    const draft = structuredClone(saved)
    mutation(draft)
    saved = structuredClone(draft)
    setState(reconcile(structuredClone(saved)))
  }] as const
}

export function makeDurableStorage(entries = new Map<string, ReturnType<typeof makeStorage>>()) {
  return (key: string, options: { initial: object }) => {
    if (!entries.has(key)) entries.set(key, makeStorage(key, options))
    return entries.get(key)!
  }
}

/** Simulate another TUI saving rules through the same host storage. */
export async function setRules(storage: Plugin.Context["storage"], root: string, lines: readonly string[]): Promise<void> {
  const [, save] = storage.store<StoredConfig>(CONFIG_STORAGE_KEY, { initial: { projects: {} } })
  await save((draft) => {
    const project = draft.projects[projectKey(root)] ??= {}
    project.ignore = [...lines]
  })
}
