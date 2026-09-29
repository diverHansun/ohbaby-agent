// Run from repository root with: pnpm exec tsx docs/problem-lists/2026-09-19-execution-reliability/improve-4.1/evidence/2026-09-29/research-probe.mts
// Synthetic events call production functions; no service, model request, or product writes.
import {
  replaceSnapshot,
  reduceUiEvent,
} from "../../../../../../apps/ohbaby-web/src/api/daemon/eventReducer.ts";
import { sanitizePromptForSessionTitle } from "../../../../../../packages/ohbaby-agent/src/services/session/prompt-sanitizer.ts";
const t = "2026-09-29T00:00:00.000Z";
const snapshot = {
  activeSessionId: "s1",
  permission: { level: "default", mode: "auto", sessionRules: [] },
  permissions: [],
  runs: [],
  sessions: [
    { createdAt: t, id: "s1", messages: [], title: "Session", updatedAt: t },
  ],
  status: { kind: "idle" },
};
let state = replaceSnapshot(snapshot as any, 0);
let seq = 0;
const send = (e: any) => {
  state = reduceUiEvent(state, e, ++seq);
  return structuredClone(state.commandNotices);
};
const start = (id: string, path: string) => ({
  type: "command.started",
  timestamp: Date.parse(t),
  command: {
    clientInvocationId: id,
    commandId: path,
    commandRunId: id,
    path: [path.replace("skill.", "")],
    surface: "tui",
    sessionId: "s1",
  },
});
send(start("c1", "skill.using-superpowers"));
const afterAction = send({
  type: "command.result.delivered",
  timestamp: Date.parse(t),
  clientInvocationId: "c1",
  commandRunId: "c1",
  action: { kind: "skill.submitted", data: { skill: "using-superpowers" } },
});
const afterUserMessage = send({
  type: "message.appended",
  sessionId: "s1",
  message: {
    id: "m1",
    sessionId: "s1",
    role: "user",
    content: "next message",
    createdAt: t,
    updatedAt: t,
    parts: [],
  },
});
const afterRun = send({
  type: "run.updated",
  run: {
    id: "r1",
    sessionId: "s1",
    startedAt: t,
    updatedAt: t,
    status: { kind: "running", runId: "r1" },
  },
});
send(start("c2", "resume"));
const beforeFollowupAction = send({
  type: "command.result.delivered",
  timestamp: Date.parse(t),
  clientInvocationId: "c2",
  commandRunId: "c2",
  output: { kind: "text", text: "Useful command output" },
});
const afterFollowupAction = send({
  type: "command.result.delivered",
  timestamp: Date.parse(t),
  clientInvocationId: "c2",
  commandRunId: "c2",
  action: { kind: "session.selected", data: { sessionId: "s1" } },
});
const originalUserRequest = "请修复会话切换时的恢复横幅";
const expandedSkill =
  "# Skill instructions\n" +
  "General workflow guidance. ".repeat(150) +
  "\n\nUser request:\n" +
  originalUserRequest;
const namingInput = sanitizePromptForSessionTitle(expandedSkill);
const result = {
  kind: "pure-production-function-diagnostics",
  realLlmRequests: 0,
  notice: {
    afterAction,
    afterUserMessage,
    afterRun,
    beforeFollowupAction,
    afterFollowupAction,
  },
  titleInput: {
    expandedLength: expandedSkill.length,
    sanitizedLength: namingInput.length,
    preservesUserRequest: namingInput.includes(originalUserRequest),
    prefix: namingInput.slice(0, 80),
  },
};
console.log(JSON.stringify(result, null, 2));
