import type { Message, Part, Session, ToolPart } from "@opencode-ai/sdk"

export const FIXED_MS = 1753000000000

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_test",
    projectID: "proj_1",
    directory: "/tmp/proj",
    title: "Test session",
    version: "1",
    time: { created: FIXED_MS, updated: FIXED_MS },
    ...overrides,
  } as Session
}

export function makeUserMessage(
  id: string,
  sessionId: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    sessionID: sessionId,
    role: "user",
    time: { created: FIXED_MS },
    agent: "build",
    model: { providerID: "prov", modelID: "mdl" },
    ...overrides,
  } as Message
}

export function makeAssistantMessage(
  id: string,
  sessionId: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    sessionID: sessionId,
    role: "assistant",
    time: { created: FIXED_MS, completed: FIXED_MS + 1000 },
    parentID: "msg_parent",
    modelID: "mdl",
    providerID: "prov",
    mode: "normal",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  } as Message
}

let partCounter = 0
function nextPartId(): string {
  partCounter += 1
  return `part_${partCounter}`
}

export function makeTextPart(text: string, synthetic = false): Part {
  return {
    id: nextPartId(),
    sessionID: "ses_test",
    messageID: "msg_1",
    type: "text",
    text,
    synthetic,
  } as Part
}

export function makeToolPart(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    id: "part_tool",
    sessionID: "ses_test",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state: { status: "pending", input: {}, raw: "" } as never,
    ...overrides,
  } as ToolPart
}
