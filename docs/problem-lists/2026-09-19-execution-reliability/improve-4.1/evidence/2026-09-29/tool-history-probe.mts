// Synthetic props rendered through production components; no service or model requests.
import { createRequire } from "node:module";
import {
  ToolCard,
  OrphanToolResultCard,
} from "../../../../../../apps/ohbaby-web/src/ui/conversation/tool-card.tsx";
import { ConversationPresentation } from "../../../../../../apps/ohbaby-web/src/ui/conversation/ConversationPresentation.tsx";
const require = createRequire(
  new URL("../../../../../../apps/ohbaby-web/package.json", import.meta.url),
);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const execution = {
  phase: "ended",
  createdAt: 0,
  phaseStartedAt: 2000,
  executionStartedAt: 1000,
  endedAt: 2000,
  outcome: "success",
};
const call = {
  id: "c1",
  name: "web_fetch",
  status: "completed",
  input: { url: "https://example.invalid" },
};
const result = { callId: "c1", output: "fixture output", execution };
const render = (C: any, props: any) =>
  renderToStaticMarkup(
    createElement(
      ConversationPresentation.Provider,
      { value: { tools: new Map([["c1", true]]) } },
      createElement(C, props),
    ),
  );
for (const [name, html] of [
  [
    "legacy_call",
    render(ToolCard, {
      call,
      result: { callId: "c1", output: "fixture output" },
    }),
  ],
  ["modern_call", render(ToolCard, { call, result })],
  ["modern_orphan_result", render(OrphanToolResultCard, { result })],
])
  console.log(
    JSON.stringify({
      name,
      missingNotice: html.includes("Execution stage history is unavailable"),
      executionSection: html.includes(">Execution<"),
      outputVisible: html.includes("fixture output"),
    }),
  );
