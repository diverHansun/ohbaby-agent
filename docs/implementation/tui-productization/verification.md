# TUI Productization Verification

## Scope

This document records the verification gates for the npm packaging and TUI productization slice.

## Automated Checks

- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm exec vitest run tests/integration/cli/packaging-smoke.integration.test.ts --testTimeout=240000`
- Touched-file Prettier checks for changed package, TUI, integration, and implementation-doc files

## Packaging Checks

The packed smoke verifies that local tarballs for `ohbaby-sdk`, `ohbaby-tui`, and `ohbaby-agent` can be installed into a temporary npm global prefix and expose:

- `ohbaby --help`
- `ohbaby --version`

The pack assertion also rejects `node_modules`, parent-directory paths, `.tsbuildinfo`, and generated test declaration files.

## Known Repository Gate

Full `pnpm run format:check` still reports existing formatting drift outside this slice. This round formats and checks only the files it changes to avoid unrelated churn.
