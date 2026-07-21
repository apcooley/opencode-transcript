import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("bun + bun:sqlite interop smoke test", () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-sqlite-"))
  const db = new Database(join(dir, "test.db"))
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)")
  const ins = db.prepare("INSERT OR IGNORE INTO t (id, v) VALUES (?, ?)")
  ins.run(1, "a")
  ins.run(1, "a")
  const rows = db.prepare("SELECT * FROM t ORDER BY id").all() as Array<{ id: number; v: string }>
  expect(rows).toEqual([{ id: 1, v: "a" }])
  db.close()
})
