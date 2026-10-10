import "./fixtures/home"
import { expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { CONFIG_STORAGE_KEY, ConfigStore, DEFAULT_SETTINGS, projectKey } from "../src/config"
import type { StoredConfig } from "../src/config"
import { makeDurableStorage } from "./fixtures/config"

function fixture() {
  const storage = { store: makeDurableStorage() } as Plugin.Context["storage"]
  const config = new ConfigStore(storage)
  const [, save] = storage.store<StoredConfig>(CONFIG_STORAGE_KEY, { initial: { projects: {} } })
  return { config, storage, save }
}

test("test process starts with an isolated home directory", () => {
  const home = homedir()
  expect(home).toBe(process.env.DIR_TREE_TEST_HOME)
  expect(process.env.HOME).toBe(home)
  expect(process.env.USERPROFILE).toBe(home)
  expect(dirname(home)).toBe(join(tmpdir(), "opencode"))
  expect(basename(home)).toStartWith("dir-tree-test-home-")
})

test("project settings use durable host storage; reads and the default visibility create no project entry", async () => {
  const { config, storage } = fixture()
  expect(config.read(".")).toEqual({ lines: [], text: '{\n  "projects": {}\n}', configured: false, settings: DEFAULT_SETTINGS })
  expect((await config.update(".", { kind: "visibility", value: true })).changed).toBe(false)
  expect(config.read(".").configured).toBe(false)
  await config.update(".", { kind: "add", line: "node_modules/" })
  await config.update(".", { kind: "visibility", value: false })
  const restarted = new ConfigStore(storage)
  expect(restarted.read(".").lines).toEqual(["node_modules/"])
  expect(restarted.read(".").settings).toEqual({ visible: false })
  expect(JSON.parse(restarted.read(".").text).projects[projectKey(".")]).toEqual({ ignore: ["node_modules/"], visible: false })
})

test("saves preserve rule order, blank/comment lines, unknown fields and other projects", async () => {
  const { config, save } = fixture()
  const root = projectKey(".")
  const other = projectKey("../other")
  const lines = ["# build", "", "*.log", "!keep.log", "\\#literal", "space\\ ", " leading"]
  await save((draft) => {
    draft.future = { keep: 42 }
    draft.projects[root] = { ignore: lines, future: true, mouse: { openFile: "left" } }
    draft.projects[other] = { ignore: ["other/"], visible: false }
  })
  expect(config.read(".").settings).toEqual(DEFAULT_SETTINGS) // Old mouse fields never become global bindings.
  await config.update(".", { kind: "visibility", value: false })
  await config.update(".", { kind: "add", line: "new/" })
  const expected = config.read(".").lines
  await config.update(".", { kind: "remove", index: 2, expected })
  expect(config.read(".").lines).toEqual([...lines.slice(0, 2), ...lines.slice(3), "new/"])
  const saved = JSON.parse(config.read(".").text)
  expect(saved.future).toEqual({ keep: 42 })
  expect(saved.projects[root].future).toBe(true)
  expect(saved.projects[root].mouse).toEqual({ openFile: "left" })
  expect(saved.projects[other]).toEqual({ ignore: ["other/"], visible: false })
})

test("path aliases address the same stored entry and additions are exactly deduplicated", async () => {
  const { config, save } = fixture()
  const root = projectKey(".")
  const spelling = process.platform === "win32" ? root.toUpperCase() : `${root}/`
  await save((draft) => { draft.projects[spelling] = { ignore: ["*.log"] } })
  await config.update("./child/..", { kind: "add", line: "!keep.log" })
  expect(config.read(".").lines).toEqual(["*.log", "!keep.log"])
  expect((await config.update(".", { kind: "add", line: "*.log" })).changed).toBe(false)
  expect(Object.keys(JSON.parse(config.read(".").text).projects)).toEqual([spelling])
  if (process.platform === "win32") expect(projectKey("C:/")).toBe("c:/")
})

test("concurrent rules and visibility saves use the host's live draft, not panel snapshots", async () => {
  const { config, storage } = fixture()
  const second = new ConfigStore(storage)
  await Promise.all([
    config.update(".", { kind: "add", line: "first/" }),
    second.update(".", { kind: "add", line: "second/" }),
    config.update(".", { kind: "visibility", value: false }),
    second.update("../other", { kind: "add", line: "other/" }),
  ])
  expect(config.read(".").lines).toEqual(["first/", "second/"])
  expect(config.read(".").settings.visible).toBe(false)
  expect(config.read("../other").lines).toEqual(["other/"])
  const expected = config.read(".").lines
  await second.update(".", { kind: "remove", index: 0, expected })
  const before = config.read(".").text
  await expect(config.update(".", { kind: "remove", index: 0, expected })).rejects.toThrow("another terminal")
  expect(config.read(".").text).toBe(before)
})

test("changes made while waiting for the host lock cannot be overwritten or incorrectly deleted", async () => {
  const { config, storage } = fixture()
  await config.update(".", { kind: "add", line: "first/" })
  const expected = config.read(".").lines
  const queued = Promise.withResolvers<void>()
  const gated = new ConfigStore({ store: (key, options) => {
    const [data, save] = storage.store(key, options)
    return [data, async (mutation) => { await queued.promise; await save(mutation) }]
  } } as Plugin.Context["storage"])
  const pending = gated.update(".", { kind: "remove", index: 0, expected })
  await config.update(".", { kind: "add", line: "second/" })
  queued.resolve()
  await expect(pending).rejects.toThrow("another terminal")
  expect(config.read(".").lines).toEqual(["first/", "second/"])
})

test.each([
  null, [], { projects: [] }, { projects: { "/a": null } },
  { projects: { "/a": { ignore: [1] } } }, { projects: { "/a": { ignore: "*.log" } } },
  { projects: { "/a": { ignore: ["a\nb"] } } }, { projects: { "/a": { ignore: ["a\0b"] } } },
  { projects: { "/a": { visible: "false" } } }, { projects: { "/a": {}, "/a/": {} } },
])("invalid stored configuration is reported, not overwritten: %j", async (data) => {
  let writes = 0
  const config = new ConfigStore({ store: () => [data, async () => { writes++ }] } as never)
  expect(() => config.read(".")).toThrow()
  await expect(config.update(".", { kind: "add", line: "new/" })).rejects.toThrow()
  await expect(config.update(".", { kind: "visibility", value: false })).rejects.toThrow()
  expect(writes).toBe(0)
})

test("oversized/multiline rules and invalid operations cannot change stored settings", async () => {
  const { config } = fixture()
  await config.update(".", { kind: "add", line: "keep/" })
  const before = config.read(".").text
  for (const line of ["x".repeat(65_537), "a\nb", "a\rb", "a\0b"]) {
    await expect(config.update(".", { kind: "add", line })).rejects.toThrow()
  }
  for (const index of [-1, 1, 0.5, NaN]) {
    await expect(config.update(".", { kind: "remove", index, expected: ["keep/"] })).rejects.toThrow("No rule selected")
  }
  await expect(config.update(".", { kind: "mouse", action: "openFile", delta: 1 } as never)).rejects.toThrow("Invalid project configuration change")
  await expect(config.update(".", { kind: "visibility", value: "false" } as never)).rejects.toThrow("boolean")
  expect(config.read(".").text).toBe(before)
  await config.update(".", { kind: "add", line: "x".repeat(32_764) })
  const withinLimit = config.read(".").text
  await expect(config.update(".", { kind: "add", line: "y".repeat(32_768) })).rejects.toThrow("64 KiB")
  expect(config.read(".").text).toBe(withinLimit)
})

test("a host storage failure leaves the old state intact without a file fallback", async () => {
  const { config, storage } = fixture()
  await config.update(".", { kind: "add", line: "keep/" })
  const before = config.read(".").text
  const failed = new ConfigStore({ store: (key, options) => [storage.store(key, options)[0], async () => { throw new Error("storage denied") }] } as never)
  await expect(failed.update(".", { kind: "add", line: "new/" })).rejects.toThrow("storage denied")
  expect(config.read(".").text).toBe(before)
})
