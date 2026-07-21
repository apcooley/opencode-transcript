import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Database as DB, PluginInput } from "bun:sqlite"
import { OpencodeTranscript } from "../src/index.ts"
import {
  makeSession,
  makeUserMessage,
  makeAssistantMessage,
  makeTextPart,
  makeToolPart,
  FIXED_MS,
} from "./fixtures.ts"
import type { Message, Part, Session } from "@opencode-ai/sdk"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transcript-plugin-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface MockClient {
  session: {
    get: () => Promise<{ data: Session }>
    messages: () => Promise<{ data: Array<{ info: Message; parts: Part[] }> }>
  }
}

function makeClient(opts: {
  session?: Session
  messages?: Array<{ info: Message; parts: Part[] }>
  getFails?: boolean
  messagesFails?: boolean
}): MockClient {
  return {
    session: {
      get: async () => {
        if (opts.getFails) throw new Error("session.get failed")
        return { data: opts.session ?? makeSession({ id: "ses_1" }) }
      },
      messages: async () => {
        if (opts.messagesFails) throw new Error("messages failed")
        return { data: opts.messages ?? [] }
      },
    },
  }
}

function makeInput(client: MockClient): PluginInput {
  return {
    client: client as unknown as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: dir,
    worktree: dir,
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }
}

function openResultDb(): DB {
  return new Database(join(dir, "transcripts.db"), { readonly: true })
}

test("records session and messages on session.idle", async () => {
  const messages = [
    {
      info: makeUserMessage("msg_u1", "ses_1"),
      parts: [makeTextPart("hello")],
    },
    {
      info: makeAssistantMessage("msg_a1", "ses_1"),
      parts: [makeTextPart("hi back")],
    },
  ]
  const hooks = await OpencodeTranscript(
    makeInput(makeClient({ messages })),
    { logDir: dir },
  )
  await hooks.event!({
    event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never,
  })
  const db = openResultDb()
  const sessions = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>
  const msgs = db
    .prepare("SELECT id, role, content FROM messages ORDER BY ts")
    .all() as Array<{ id: string; role: string; content: string }>
  db.close()
  expect(sessions.map((s) => s.id)).toEqual(["ses_1"])
  expect(msgs).toEqual([
    { id: "msg_u1", role: "user", content: "hello" },
    { id: "msg_a1", role: "assistant", content: "hi back" },
  ])
})

test("dedup across multiple idle events (no duplicate rows)", async () => {
  const messages = [
    { info: makeUserMessage("msg_u1", "ses_1"), parts: [makeTextPart("hello")] },
  ]
  const hooks = await OpencodeTranscript(
    makeInput(makeClient({ messages })),
    { logDir: dir },
  )
  const event = {
    event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never,
  }
  await hooks.event!(event)
  await hooks.event!(event)
  const db = openResultDb()
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM messages")
    .get() as { n: number }
  db.close()
  expect(count.n).toBe(1)
})

test("ignores non-session.idle events", async () => {
  const hooks = await OpencodeTranscript(
    makeInput(makeClient({ messages: [] })),
    { logDir: dir },
  )
  await hooks.event!({
    event: { type: "session.created", properties: { session: makeSession() } } as never,
  })
  expect(() => openResultDb()).toThrow()
})

test("session.get failure warns but messages still recorded", async () => {
  const messages = [
    { info: makeUserMessage("msg_u1", "ses_1"), parts: [makeTextPart("hi")] },
  ]
  const hooks = await OpencodeTranscript(
    makeInput(makeClient({ messages, getFails: true })),
    { logDir: dir },
  )
  await hooks.event!({
    event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never,
  })
  const db = openResultDb()
  const msgs = db
    .prepare("SELECT id FROM messages")
    .all() as Array<{ id: string }>
  db.close()
  expect(msgs.map((m) => m.id)).toEqual(["msg_u1"])
})

test("messages fetch failure warns and records nothing, no crash", async () => {
  const hooks = await OpencodeTranscript(
    makeInput(makeClient({ messagesFails: true })),
    { logDir: dir },
  )
  await expect(
    hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never,
    }),
  ).resolves.toBeUndefined()
  const db = openResultDb()
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM messages")
    .get() as { n: number }
  db.close()
  expect(count.n).toBe(0)
})

test("respects includeToolResults option end-to-end", async () => {
  const completedState = {
    status: "completed",
    input: {},
    output: "result text",
    title: "ran",
    metadata: {},
    time: { start: FIXED_MS, end: FIXED_MS + 1 },
  } as never
  const messages = [
    {
      info: makeAssistantMessage("msg_a1", "ses_1"),
      parts: [makeToolPart({ id: "pt_1", callID: "c_1", state: completedState })],
    },
  ]
  const hooks = await OpencodeTranscript(
    makeInput(makeClient({ messages })),
    { logDir: dir, includeToolResults: true },
  )
  await hooks.event!({
    event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never,
  })
  const db = openResultDb()
  const results = db
    .prepare("SELECT output FROM tool_results")
    .all() as Array<{ output: string }>
  db.close()
  expect(results.map((r) => r.output)).toEqual(["result text"])
})
