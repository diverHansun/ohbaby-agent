# Final independent review — LLM package extraction

Reviewed 2026-10-21 against `73e065e7`, committed stages through `e58a0a1a`, and the current uncommitted Stage 3 delivery. Inputs: `final-review.diff`, task-3 brief/report, progress ledger, actual source/manifests/configuration, and retained verification artifacts. Review was read-only except this report. No build, test suite, paid request, or implementation edit was performed.

## Stage 3 SPEC

**PASS — all reviewed Stage 3 specification requirements are satisfied.** The one low-severity documentation finding is now closed:

- **P3, CLOSED — Current test ownership pointed to a deleted directory.** `docs/core/llm-client/test.md:27` and `docs/services/providers/test.md:19` place `prompt-cache-wire.contract.test.ts` and `openai-responses.integration.test.ts` under `packages/ohbaby-agent/src/services/interface-providers/`. That directory was removed. The actual files are `packages/ohbaby-agent/src/core/context/prompt-cache-wire.contract.test.ts` and `packages/ohbaby-agent/src/core/lifecycle/openai-responses.integration.test.ts`. This contradicts Stage 3 D1/D2's current-location requirement and prevents maintainers from locating the documented cross-module checks. Both references now name those actual paths. The targeted follow-up confirmed both target files exist and continued ownership by agent is correct.

Otherwise the specified scripts retain the agent configuration factory/reloader while importing the migrated provider API, release docs cover all five packages in dependency order, release status is explicitly unpublished, and the package README describes the root-only synchronous factory boundary accurately. The module documentation now agrees with actual SDK `maxRetries: 0` and the unchanged application retry budget.

## Stage 3 QUALITY

**PASS — no open quality finding.** The documentation-only correction introduced no new issue. Documentation describes existing behavior without introducing a new retry policy, protocol abstraction, configuration store, or API. Package README sample matches the owned config/message contract. The closed finding above affected documentation accuracy, not runtime behavior.

## Whole-branch review

**APPROVE — no open review findings.** No blocking runtime, public API, build, or package-boundary defect found. The sole P3 is closed after one targeted follow-up; parent still owns completion of the final acceptance record and real-Web evidence.

- Compared every relocated non-test client/provider/config file with its original counterpart. Most are byte-identical or import-only moves. The substantive differences are the planned explicit-config factory extraction, identical scoped-key encoding moved locally, UI reasoning view relocation, and single-source protocol kind type.
- Verified agent wrapper retains the original configuration options/default project `.env` path and identical diagnostic fields. The pure factory preserves returned config fields and omits plaintext API key as before.
- Verified `ohbaby-llm` has only OpenAI, Anthropic SDK, and Zod runtime dependencies, a sole root export, independent TypeScript project, and no escaping relative imports. Agent explicitly externalizes the new package. Consumer references, test aliases, lockfile, and pack/build lists include it.
- Independently compared retained compiled declaration export lists with baseline: agent **567**, server **40**, sdk **260**, all exact equality. Agent explicitly preserves old exports without adding the pure factory to its public surface.
- Read packing evidence: all five tarballs have rewritten version dependencies and no test declarations; agent depends on `ohbaby-llm: 0.1.16`; standalone CLI version/help and public LLM import succeeded. The refreshed LLM tarball contains README.
- Prior Stage 2 fixes for the two standalone CLI build lists and diagnostic stack filters are present. No reopening is warranted.

## Verification interpretation and limits

Existing evidence reports full preflight **6841 passed / 17 skipped**, four follow-up clean-dist CLI cases, server E2E **6 passed / 4 skipped**, compiled Web/TUI validation, and standalone five-package install. These were read as evidence and not rerun by this reviewer.

The real-provider report correctly records **14 of 15 original configurations passed**. Zhipu rejected `thinking: { type: disabled }` with HTTP 400 / code 1210; a separate diagnostic request omitting that control succeeded. That supports transport/parser operation with provider-default reasoning, not reasoning-off support or a claim that all original configurations passed. Source move equivalence does not establish an extraction regression here. Parent owns ongoing real-Web validation and final `05-implementation-acceptance.md` updates; this review does not predeclare those complete.

## Targeted follow-up

Reviewed `/tmp/ohbaby-llm-extraction-20261021/final-doc-fix.diff`, `final-fix-report.md`, and the current two affected passages. `docs/core/llm-client/test.md:27` and `docs/services/providers/test.md:19` now point to the existing context and lifecycle test files. This closes the only finding. Scope was limited to this correction and new issues it could introduce; no broad review was reopened and no test/build was run. Final conclusions: **Stage 3 SPEC PASS; Stage 3 QUALITY PASS; whole branch APPROVE**. Real-provider qualification remains the same; no all-original-configurations-pass claim is made.
