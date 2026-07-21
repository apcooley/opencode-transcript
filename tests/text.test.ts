import { test, expect } from "bun:test"
import { extractText } from "../src/index.ts"
import { makeTextPart, makeToolPart } from "./fixtures.ts"
import type { Part } from "@opencode-ai/sdk"

test("empty parts produces empty string", () => {
  expect(extractText([])).toBe("")
})

test("all-synthetic parts filtered to empty string", () => {
  const parts = [makeTextPart("thinking…", true), makeTextPart("more", true)] as Part[]
  expect(extractText(parts)).toBe("")
})

test("mixed synthetic and real text joins only non-synthetic", () => {
  const parts = [
    makeTextPart("ignored", true),
    makeTextPart("hello"),
    makeTextPart("ignored2", true),
    makeTextPart("world"),
  ] as Part[]
  expect(extractText(parts)).toBe("helloworld")
})

test("trims outer whitespace after join", () => {
  const parts = [makeTextPart(" a "), makeTextPart(" b ")] as Part[]
  expect(extractText(parts)).toBe("a  b")
})

test("ignores non-text parts (tool parts contribute nothing)", () => {
  const parts = [makeTextPart("hello"), makeToolPart(), makeTextPart("world")] as Part[]
  expect(extractText(parts)).toBe("helloworld")
})
