import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import type { Message, Part, Session, TextPart, ToolPart } from "@opencode-ai/sdk"

export type { Database } from "bun:sqlite"

export type Options = {
  logDir?: string
  timezone?: string
  includeToolCalls?: boolean
  includeToolResults?: boolean
}

export type ResolvedOptions = {
  logDir: string
  timezone: string
  includeToolCalls: boolean
  includeToolResults: boolean
}

const DEFAULT_LOG_DIR = `${homedir()}/.local/share/opencode/transcripts`

const ENV = {
  logDir: "OPENCODE_TRANSCRIPT_LOG_DIR",
  timezone: "OPENCODE_TRANSCRIPT_TIMEZONE",
  includeToolCalls: "OPENCODE_TRANSCRIPT_INCLUDE_TOOL_CALLS",
  includeToolResults: "OPENCODE_TRANSCRIPT_INCLUDE_TOOL_RESULTS",
} as const

function envOr(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw !== undefined && raw !== "" ? raw : fallback
}

function boolOr(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const lower = raw.toLowerCase()
  if (lower === "true" || lower === "1" || lower === "yes") return true
  if (lower === "false" || lower === "0" || lower === "no") return false
  return fallback
}

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return homedir() + p.slice(1)
  return p
}

export function resolveOptions(options: Options = {}): ResolvedOptions {
  const logDir = expandHome(envOr(ENV.logDir, options.logDir ?? DEFAULT_LOG_DIR))
  const timezone = envOr(ENV.timezone, options.timezone ?? "UTC")
  const includeToolCalls = boolOr(ENV.includeToolCalls, options.includeToolCalls ?? true)
  const includeToolResults = boolOr(ENV.includeToolResults, options.includeToolResults ?? false)
  return { logDir, timezone, includeToolCalls, includeToolResults }
}

export function formatTimestamp(epochMs: number, timezone: string): string {
  if (timezone === "UTC") return new Date(epochMs).toISOString()
  const zone =
    timezone === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  const parts = formatter.formatToParts(new Date(epochMs))
  const map: Record<string, string> = {}
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value
  // Reinterpret the zone's wall-clock parts as UTC; the delta from the real epoch is the zone's offset.
  const asUTC = Date.UTC(
    +map.year,
    +map.month - 1,
    +map.day,
    +map.hour,
    +map.minute,
    +map.second,
  )
  const offsetMin = Math.round((asUTC - Math.floor(epochMs / 1000) * 1000) / 60000)
  const sign = offsetMin >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMin)
  const oh = String(Math.floor(abs / 60)).padStart(2, "0")
  const om = String(abs % 60).padStart(2, "0")
  const ms = String(epochMs % 1000).padStart(3, "0")
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}.${ms}${sign}${oh}:${om}`
}

export function extractText(parts: Part[]): string {
  return parts
    .filter((part): part is TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("")
    .trim()
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_ts TEXT,
    updated_ts TEXT,
    directory TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    agent TEXT,
    model_provider TEXT,
    model_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    call_id TEXT,
    tool TEXT NOT NULL,
    state TEXT,
    metadata TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tool_results (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    output TEXT,
    metadata TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id)`,
]

export function openDb(logDir: string): Database {
  mkdirSync(logDir, { recursive: true })
  const db = new Database(join(logDir, "transcripts.db"))
  db.exec("PRAGMA journal_mode = WAL")
  for (const stmt of SCHEMA) db.exec(stmt)
  return db
}

export function recordSession(db: Database, session: Session): void {
  db.prepare(
    "INSERT INTO sessions (id, title, created_ts, updated_ts, directory) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, created_ts = excluded.created_ts, updated_ts = excluded.updated_ts, directory = excluded.directory",
  ).run(
    session.id,
    session.title,
    formatTimestamp(session.time.created, "UTC"),
    formatTimestamp(session.time.updated, "UTC"),
    session.directory,
  )
}

export function recordMessage(
  db: Database,
  sessionId: string,
  info: Message,
  content: string,
  timezone = "UTC",
): void {
  const ts = formatTimestamp(info.time.created, timezone)
  const { agent, modelProvider, modelId } =
    info.role === "user"
      ? { agent: info.agent, modelProvider: info.model.providerID, modelId: info.model.modelID }
      : { agent: null, modelProvider: info.providerID, modelId: info.modelID }
  db.prepare(
    "INSERT OR IGNORE INTO messages (id, session_id, ts, role, content, agent, model_provider, model_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(info.id, sessionId, ts, info.role, content, agent, modelProvider, modelId)
}

export function recordToolCall(
  db: Database,
  sessionId: string,
  part: ToolPart,
  includeToolCalls: boolean,
): void {
  if (!includeToolCalls) return
  const metadata = JSON.stringify(part.metadata ?? {})
  db.prepare(
    `INSERT INTO tool_calls (id, session_id, message_id, call_id, tool, state, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, metadata = excluded.metadata, call_id = excluded.call_id, tool = excluded.tool`,
  ).run(part.id, sessionId, part.messageID, part.callID, part.tool, part.state.status, metadata)
}

export function recordToolResult(
  db: Database,
  sessionId: string,
  part: ToolPart,
  includeToolResults: boolean,
  timezone = "UTC",
): void {
  if (!includeToolResults) return
  const state = part.state
  if (state.status !== "completed" && state.status !== "error") return
  const output = state.status === "completed" ? state.output : state.error
  const metadata = JSON.stringify(state.metadata ?? {})
  const ts = formatTimestamp(state.time.end, timezone)
  db.prepare(
    "INSERT OR IGNORE INTO tool_results (id, session_id, call_id, ts, output, metadata) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(part.id, sessionId, part.callID, ts, output, metadata)
}

export const OpencodeTranscript: Plugin = async (input, options) => {
  const resolved = resolveOptions(options as Options)
  let db: Database | undefined
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      try {
        const { sessionID } = event.properties
        if (!db) db = openDb(resolved.logDir)
        try {
          const result = await input.client.session.get({ path: { id: sessionID } })
          if (result.data) recordSession(db, result.data)
          else console.warn(`[opencode-transcript] session.get returned no data for ${sessionID}`)
        } catch (e) {
          console.warn(`[opencode-transcript] session.get failed for ${sessionID}: ${e}`)
        }
        let messages: Array<{ info: Message; parts: Part[] }> = []
        try {
          const result = await input.client.session.messages({ path: { id: sessionID } })
          messages = result.data ?? []
        } catch (e) {
          console.warn(`[opencode-transcript] messages fetch failed for ${sessionID}: ${e}`)
          return
        }
        for (const { info, parts } of messages) {
          const content = extractText(parts)
          recordMessage(db, sessionID, info, content, resolved.timezone)
          for (const part of parts) {
            if (part.type !== "tool") continue
            recordToolCall(db, sessionID, part, resolved.includeToolCalls)
            recordToolResult(db, sessionID, part, resolved.includeToolResults, resolved.timezone)
          }
        }
      } catch (e) {
        console.warn(`[opencode-transcript] error handling session.idle: ${e}`)
      }
    },
  }
}

export default { id: "opencode-transcript", server: OpencodeTranscript } satisfies PluginModule
