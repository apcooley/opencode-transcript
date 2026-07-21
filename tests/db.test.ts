import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  openDb,
  recordSession,
  recordMessage,
  recordToolCall,
  recordToolResult,
} from "../src/index.ts"
import {
  makeSession,
  makeUserMessage,
  makeAssistantMessage,
  makeToolPart,
  FIXED_MS,
} from "./fixtures.ts"
import type { Database as DB } from "bun:sqlite"

let dir: string
let db: DB

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transcript-db-"))
})

afterEach(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

function tables(db: DB): string[] {
  return (db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>).map((r) => r.name)
}

test("openDb creates logDir if missing", () => {
  const nested = join(dir, "a", "b", "c")
  db = openDb(nested)
  expect(existsSync(nested)).toBe(true)
  expect(existsSync(join(nested, "transcripts.db"))).toBe(true)
})

test("openDb sets WAL journal mode", () => {
  db = openDb(dir)
  expect(
    (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
  ).toBe("wal")
})

test("openDb creates all four tables idempotently", () => {
  db = openDb(dir)
  expect(tables(db).sort()).toEqual(
    ["messages", "sessions", "tool_calls", "tool_results"].sort(),
  )
  // reopen on existing db — safe, no error
  db.close()
  db = openDb(dir)
  expect(tables(db).sort()).toEqual(
    ["messages", "sessions", "tool_calls", "tool_results"].sort(),
  )
})

test("recordSession inserts a row", () => {
  db = openDb(dir)
  recordSession(db, makeSession({ id: "ses_1", title: "hello" }))
  const row = db
    .prepare("SELECT id, title FROM sessions WHERE id = ?")
    .get("ses_1") as { id: string; title: string }
  expect(row).toEqual({ id: "ses_1", title: "hello" })
})

test("recordSession dedup via INSERT OR IGNORE", () => {
  db = openDb(dir)
  recordSession(db, makeSession({ id: "ses_1" }))
  recordSession(db, makeSession({ id: "ses_1", title: "changed" }))
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?")
    .get("ses_1") as { n: number }
  expect(count.n).toBe(1)
})

test("recordMessage inserts a user message with content and role", () => {
  db = openDb(dir)
  const info = makeUserMessage("msg_u1", "ses_1")
  recordMessage(db, "ses_1", info, "hello world")
  const row = db
    .prepare("SELECT id, session_id, role, content, agent FROM messages WHERE id = ?")
    .get("msg_u1") as Record<string, string>
  expect(row).toEqual({
    id: "msg_u1",
    session_id: "ses_1",
    role: "user",
    content: "hello world",
    agent: "build",
  })
})

test("recordMessage inserts an assistant message with model fields", () => {
  db = openDb(dir)
  const info = makeAssistantMessage("msg_a1", "ses_1")
  recordMessage(db, "ses_1", info, "response")
  const row = db
    .prepare(
      "SELECT id, role, content, model_provider, model_id FROM messages WHERE id = ?",
    )
    .get("msg_a1") as Record<string, string>
  expect(row).toEqual({
    id: "msg_a1",
    role: "assistant",
    content: "response",
    model_provider: "prov",
    model_id: "mdl",
  })
})

test("recordMessage dedup via INSERT OR IGNORE on repeat", () => {
  db = openDb(dir)
  const info = makeUserMessage("msg_u1", "ses_1")
  recordMessage(db, "ses_1", info, "hello")
  recordMessage(db, "ses_1", info, "hello")
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?")
    .get("msg_u1") as { n: number }
  expect(count.n).toBe(1)
})

test("recordMessage inserts even when content is empty (tool-only assistant msg)", () => {
  db = openDb(dir)
  const info = makeAssistantMessage("msg_a1", "ses_1")
  recordMessage(db, "ses_1", info, "")
  const row = db
    .prepare("SELECT id, content FROM messages WHERE id = ?")
    .get("msg_a1") as { id: string; content: string }
  expect(row).toEqual({ id: "msg_a1", content: "" })
})

test("tool_calls inserted when includeToolCalls=true", () => {
  db = openDb(dir)
  const part = makeToolPart({ id: "pt_1", callID: "c_1", tool: "bash" })
  recordToolCall(db, "ses_1", part, true)
  const row = db
    .prepare("SELECT id, session_id, call_id, tool, state FROM tool_calls WHERE id = ?")
    .get("pt_1") as Record<string, string>
  expect(row).toEqual({
    id: "pt_1",
    session_id: "ses_1",
    call_id: "c_1",
    tool: "bash",
    state: "pending",
  })
})

test("tool_calls NOT inserted when includeToolCalls=false", () => {
  db = openDb(dir)
  const part = makeToolPart({ id: "pt_1" })
  recordToolCall(db, "ses_1", part, false)
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM tool_calls")
    .get() as { n: number }
  expect(count.n).toBe(0)
})

test("tool_call state updates via upsert (pending → completed)", () => {
  db = openDb(dir)
  recordToolCall(db, "ses_1", makeToolPart({ id: "pt_1" }), true)
  recordToolCall(
    db,
    "ses_1",
    makeToolPart({
      id: "pt_1",
      state: {
        status: "completed",
        input: {},
        output: "done",
        title: "ran",
        metadata: {},
        time: { start: FIXED_MS, end: FIXED_MS + 1 },
      } as never,
    }),
    true,
  )
  const row = db
    .prepare("SELECT state FROM tool_calls WHERE id = ?")
    .get("pt_1") as { state: string }
  expect(row.state).toBe("completed")
})

test("tool_calls metadata column stores JSON of part.metadata", () => {
  db = openDb(dir)
  const part = makeToolPart({ id: "pt_1", metadata: { foo: "bar" } })
  recordToolCall(db, "ses_1", part, true)
  const row = db
    .prepare("SELECT metadata FROM tool_calls WHERE id = ?")
    .get("pt_1") as { metadata: string }
  expect(JSON.parse(row.metadata)).toEqual({ foo: "bar" })
})

test("tool_results NOT inserted when includeToolResults=false", () => {
  db = openDb(dir)
  const part = makeToolPart({
    id: "pt_1",
    state: {
      status: "completed",
      input: {},
      output: "done",
      title: "ran",
      metadata: {},
      time: { start: FIXED_MS, end: FIXED_MS + 1 },
    } as never,
  })
  recordToolResult(db, "ses_1", part, false)
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM tool_results")
    .get() as { n: number }
  expect(count.n).toBe(0)
})

test("tool_results inserted with output when state=completed and flag true", () => {
  db = openDb(dir)
  const part = makeToolPart({
    id: "pt_1",
    callID: "c_1",
    state: {
      status: "completed",
      input: {},
      output: "done it",
      title: "ran",
      metadata: {},
      time: { start: FIXED_MS, end: FIXED_MS + 1 },
    } as never,
  })
  recordToolResult(db, "ses_1", part, true)
  const row = db
    .prepare("SELECT id, call_id, output FROM tool_results WHERE id = ?")
    .get("pt_1") as Record<string, string>
  expect(row).toEqual({ id: "pt_1", call_id: "c_1", output: "done it" })
})

test("tool_results stores error in output when state=error", () => {
  db = openDb(dir)
  const part = makeToolPart({
    id: "pt_1",
    callID: "c_1",
    state: {
      status: "error",
      input: {},
      error: "boom",
      metadata: {},
      time: { start: FIXED_MS, end: FIXED_MS + 1 },
    } as never,
  })
  recordToolResult(db, "ses_1", part, true)
  const row = db
    .prepare("SELECT output FROM tool_results WHERE id = ?")
    .get("pt_1") as { output: string }
  expect(row.output).toBe("boom")
})

test("tool_results skipped when state=pending", () => {
  db = openDb(dir)
  const part = makeToolPart({ id: "pt_1", state: { status: "pending", input: {}, raw: "" } as never })
  recordToolResult(db, "ses_1", part, true)
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM tool_results")
    .get() as { n: number }
  expect(count.n).toBe(0)
})

test("tool_results skipped when state=running", () => {
  db = openDb(dir)
  const part = makeToolPart({
    id: "pt_1",
    state: {
      status: "running",
      input: {},
      title: "going",
      metadata: {},
      time: { start: FIXED_MS },
    } as never,
  })
  recordToolResult(db, "ses_1", part, true)
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM tool_results")
    .get() as { n: number }
  expect(count.n).toBe(0)
})
