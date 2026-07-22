# opencode-transcript

An [OpenCode](https://opencode.ai) plugin that logs session transcripts to a SQLite database. On each `session.idle` event it fetches the session's messages through the opencode SDK client and writes user/assistant text, tool calls, and tool results into a single `transcripts.db` file via [`bun:sqlite`](https://bun.sh/docs/api/sqlite).

## Requirements

- **bun runtime** (uses the built-in `bun:sqlite` module).

## Install

```sh
npm install opencode-transcript
```

Register it in your `opencode.jsonc` using the `[name, options]` tuple form:

```jsonc
{
  "plugin": [
    ["opencode-transcript", { "timezone": "America/Toronto", "includeToolResults": true }]
  ]
}
```

### Local development

Before this package is published, load it from a local checkout by pointing the plugin entry at the repo path (opencode resolves a `file:` or absolute-path spec as a file plugin and reads `package.json` for the entrypoint):

```jsonc
{
  "plugin": [
    ["/absolute/path/to/opencode-transcript", { "timezone": "America/Toronto" }]
  ]
}
```

Rebuild after source changes (`npm run build`) — opencode loads `dist/index.js` as declared in `package.json`.

## Options

| Option               | Type      | Default                                       | Description                                                              |
| -------------------- | --------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| `logDir`             | `string`  | `~/.local/share/opencode/transcripts`         | Directory holding `transcripts.db`. `~` expands to the home directory.   |
| `timezone`           | `string`  | `"UTC"`                                       | Timezone for stored timestamps: `"UTC"`, `"local"`, or an IANA zone.     |
| `includeToolCalls`   | `boolean` | `true`                                        | Record tool-call invocations and their state transitions.                |
| `includeToolResults` | `boolean` | `false`                                       | Record tool outputs (`completed`) and errors (`error`) into `tool_results`. |

### Environment overrides

Environment variables take precedence over plugin options, which take precedence over defaults. Empty-string env values fall through to the option/default.

| Variable                                     | Maps to              |
| -------------------------------------------- | -------------------- |
| `OPENCODE_TRANSCRIPT_LOG_DIR`                | `logDir`             |
| `OPENCODE_TRANSCRIPT_TIMEZONE`               | `timezone`           |
| `OPENCODE_TRANSCRIPT_INCLUDE_TOOL_CALLS`     | `includeToolCalls`   |
| `OPENCODE_TRANSCRIPT_INCLUDE_TOOL_RESULTS`   | `includeToolResults` |

Boolean env values are parsed case-insensitively: `true` / `1` / `yes` are truthy, `false` / `0` / `no` are falsy, and an empty string (or unset) falls through to the option/default.

## SQLite schema

`transcripts.db` is opened in WAL mode (`journal_mode = WAL`) and created idempotently with `IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_ts TEXT,
  updated_ts TEXT,
  directory TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  agent TEXT,
  model_provider TEXT,
  model_id TEXT
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  call_id TEXT,
  tool TEXT NOT NULL,
  state TEXT,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS tool_results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  output TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
```

### Column semantics

- `messages.content` — joined, trimmed text of non-synthetic text parts.
- `messages.ts` — `info.time.created` formatted with `timezone`.
- `tool_calls.metadata` — `JSON.stringify(part.metadata ?? {})`.
- `tool_calls.state` — tool-state status: `pending` / `running` / `completed` / `error`.
- `tool_results.output` — `state.output` (completed) or `state.error` (error). Rows written only for `completed` / `error` states.

### Dedup behavior

- `sessions` — upserts `title` / `created_ts` / `updated_ts` / `directory` on conflict (`id` immutable).
- `messages` — `INSERT OR IGNORE` on primary key.
- `tool_calls` — upserts `state` / `metadata` / `call_id` / `tool` on conflict.
- `tool_results` — `INSERT OR IGNORE` on primary key.

## Sample queries

```sh
bun -e 'import { Database } from "bun:sqlite";
const db = new Database(process.env.HOME + "/.local/share/opencode/transcripts/transcripts.db", { readonly: true });
for (const r of db.prepare("SELECT ts, role, content FROM messages WHERE session_id = ? ORDER BY ts").all("ses_abc123")) console.log(r);'
```

```sql
SELECT ts, role, content FROM messages ORDER BY ts DESC LIMIT 50;

SELECT c.tool, c.state, r.output
FROM tool_calls c LEFT JOIN tool_results r ON r.id = c.id
WHERE c.session_id = ? ORDER BY c.id;
```

## Error handling

Failures are soft and logged via `console.warn`:

- `session.get` failure — session row skipped, messages still recorded.
- `session.messages` failure — nothing recorded for that event.
