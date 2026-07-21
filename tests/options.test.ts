import { test, expect, beforeEach, afterEach } from "bun:test"
import { homedir } from "node:os"
import { resolveOptions } from "../src/index.ts"

const ENV_KEYS = [
  "OPENCODE_TRANSCRIPT_LOG_DIR",
  "OPENCODE_TRANSCRIPT_TIMEZONE",
  "OPENCODE_TRANSCRIPT_INCLUDE_TOOL_CALLS",
  "OPENCODE_TRANSCRIPT_INCLUDE_TOOL_RESULTS",
]

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test("defaults when no options or env", () => {
  const o = resolveOptions()
  expect(o.logDir).toBe(`${homedir()}/.local/share/opencode/transcripts`)
  expect(o.timezone).toBe("UTC")
  expect(o.includeToolCalls).toBe(true)
  expect(o.includeToolResults).toBe(false)
})

test("options override defaults", () => {
  const o = resolveOptions({
    logDir: "/tmp/logs",
    timezone: "America/Toronto",
    includeToolCalls: false,
    includeToolResults: true,
  })
  expect(o).toEqual({
    logDir: "/tmp/logs",
    timezone: "America/Toronto",
    includeToolCalls: false,
    includeToolResults: true,
  })
})

test("env overrides options", () => {
  process.env.OPENCODE_TRANSCRIPT_LOG_DIR = "/env/dir"
  process.env.OPENCODE_TRANSCRIPT_TIMEZONE = "Europe/London"
  process.env.OPENCODE_TRANSCRIPT_INCLUDE_TOOL_CALLS = "false"
  process.env.OPENCODE_TRANSCRIPT_INCLUDE_TOOL_RESULTS = "true"
  const o = resolveOptions({
    logDir: "/opt/dir",
    timezone: "America/Toronto",
    includeToolCalls: true,
    includeToolResults: false,
  })
  expect(o).toEqual({
    logDir: "/env/dir",
    timezone: "Europe/London",
    includeToolCalls: false,
    includeToolResults: true,
  })
})

test("env overrides defaults when no options", () => {
  process.env.OPENCODE_TRANSCRIPT_TIMEZONE = "Asia/Tokyo"
  const o = resolveOptions()
  expect(o.timezone).toBe("Asia/Tokyo")
  expect(o.includeToolCalls).toBe(true)
})

test("expands ~ in logDir", () => {
  const o = resolveOptions({ logDir: "~/org/my-org/cos/transcripts" })
  expect(o.logDir).toBe(`${homedir()}/org/my-org/cos/transcripts`)
})

test("boolean env parsing: true/1/yes are truthy, false/0/no are falsy, empty falls through", () => {
  const cases: Array<[string, boolean]> = [
    ["true", true],
    ["1", true],
    ["yes", true],
    ["TRUE", true],
    ["false", false],
    ["0", false],
    ["no", false],
  ]
  for (const [val, expected] of cases) {
    process.env.OPENCODE_TRANSCRIPT_INCLUDE_TOOL_CALLS = val
    expect(resolveOptions().includeToolCalls).toBe(expected)
  }
  delete process.env.OPENCODE_TRANSCRIPT_INCLUDE_TOOL_CALLS
  process.env.OPENCODE_TRANSCRIPT_INCLUDE_TOOL_CALLS = ""
  expect(resolveOptions().includeToolCalls).toBe(true)
})
