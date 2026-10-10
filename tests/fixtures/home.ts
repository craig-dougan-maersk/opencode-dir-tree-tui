// Refuse tests that bypass the isolated process created by scripts/test.ts.
import { homedir } from "node:os"

const home = process.env.DIR_TREE_TEST_HOME
if (!home || process.env.HOME !== home || process.env.USERPROFILE !== home || homedir() !== home) {
  throw new Error("Test home isolation failed; use bun run test")
}
