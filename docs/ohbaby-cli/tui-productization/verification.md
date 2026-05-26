# TUI Productization Verification

## Scope

This document records the verification gates for the npm packaging and TUI productization slice.

## Automated Checks

- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm exec vitest run tests/integration/cli/packaging-smoke.integration.test.ts --testTimeout=240000`
- `pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx --testTimeout=360000` with opt-in real-provider environment variables
- Touched-file Prettier checks for changed package, TUI, integration, and implementation-doc files

## Opt-In Real Smokes

Real API smoke tests are skipped by default so normal local and CI runs stay
fake-only and deterministic.

Use these only when you intentionally want to spend real provider/Tavily quota:

```bash
OHBABY_RUN_REAL_TUI_SMOKE=1 \
ZAI_API_KEY=... \
pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx --testTimeout=360000
```

```bash
OHBABY_RUN_REAL_TUI_SMOKE=1 \
OHBABY_RUN_REAL_TUI_TAVILY_SMOKE=1 \
ZAI_API_KEY=... \
TAVILY_API_KEY=... \
pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx --testTimeout=360000
```

The real TUI smoke writes a temporary `~/.ohbaby-agent/model.json`, uses the
Zhipu OpenAI-compatible base URL, renders `OhbabyTerminalApp`, submits through
the TUI prompt, and verifies the backend returns to idle. The Tavily variant
also switches to ask mode from the TUI and verifies a completed `web_search`
tool call is visible.

## Packaging Checks

The packed smoke verifies that local tarballs for `ohbaby-sdk`, `ohbaby-cli`, and `ohbaby-agent` can be installed into a temporary npm global prefix and expose:

- `ohbaby --help`
- `ohbaby --version`

The pack assertion also rejects `node_modules`, parent-directory paths, `.tsbuildinfo`, and generated test declaration files.

## Known Repository Gate

Full `pnpm run format:check` still reports existing formatting drift outside this slice. This round formats and checks only the files it changes to avoid unrelated churn.
