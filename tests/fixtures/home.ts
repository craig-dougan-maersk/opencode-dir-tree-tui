// Every test process (including package tests) gets a private user directory.
// Filesystem regressions must never touch the developer's real home.
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"

const temporary = join(tmpdir(), "opencode")
mkdirSync(temporary, { recursive: true })
const home = mkdtempSync(join(temporary, "dir-tree-test-home-"))
process.env.HOME = home
process.env.USERPROFILE = home
if (homedir() !== home) throw new Error("Test home isolation failed")
process.once("exit", () => rmSync(home, { recursive: true, force: true }))
