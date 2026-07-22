import { test, expect } from "bun:test"
import { OpencodeTranscript } from "../src/index.ts"
import mod from "../src/index.ts"

test("default export is a V1 PluginModule with id and server", () => {
  expect(mod).toBeDefined()
  expect(typeof mod).toBe("object")
  expect(mod.id).toBe("opencode-transcript")
  expect(typeof mod.server).toBe("function")
})

test("default.server is the OpencodeTranscript plugin function", () => {
  expect(mod.server).toBe(OpencodeTranscript)
})

test("default.server returns Hooks with an event function", async () => {
  const input = {
    client: {},
    project: {},
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://localhost"),
    $: {},
  } as never
  const hooks = await mod.server(input, {})
  expect(typeof hooks).toBe("object")
  expect(typeof hooks.event).toBe("function")
})
