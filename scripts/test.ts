import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Bun on Linux resolves homedir before preloads can change HOME.
const temporary = join(tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const home = await mkdtemp(join(temporary, "dir-tree-test-home-"))
try {
  const test = Bun.spawn([process.execPath, "test", "--conditions=browser", "--preload", "./tests/fixtures/home.ts", ...process.argv.slice(2)], {
    env: { ...process.env, HOME: home, USERPROFILE: home, DIR_TREE_TEST_HOME: home },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exitCode = await test.exited
} finally {
  await rm(home, { recursive: true, force: true })
}
