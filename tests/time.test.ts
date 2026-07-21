import { test, expect } from "bun:test"
import { formatTimestamp } from "../src/index.ts"
import { FIXED_MS } from "./fixtures.ts"

test("UTC produces Z-suffixed ISO matching Date.toISOString", () => {
  expect(formatTimestamp(FIXED_MS, "UTC")).toBe(new Date(FIXED_MS).toISOString())
})

test("UTC preserves milliseconds", () => {
  expect(formatTimestamp(FIXED_MS + 288, "UTC")).toBe(new Date(FIXED_MS + 288).toISOString())
  expect(formatTimestamp(FIXED_MS + 288, "UTC")).toMatch(/\.288Z$/)
})

test("IANA timezone America/Toronto in July is -04:00 offset", () => {
  const out = formatTimestamp(FIXED_MS, "America/Toronto")
  expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-04:00$/)
})

test("IANA timezone preserves milliseconds", () => {
  const out = formatTimestamp(FIXED_MS + 288, "America/Toronto")
  expect(out).toMatch(/\.288-04:00$/)
})

test("local timezone produces a valid offset or Z suffix", () => {
  const out = formatTimestamp(FIXED_MS, "local")
  expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/)
})

test("invalid timezone throws RangeError", () => {
  expect(() => formatTimestamp(FIXED_MS, "Bogus/Zone")).toThrow(RangeError)
})
