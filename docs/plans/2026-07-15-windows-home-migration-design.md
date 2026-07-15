# Windows Home Migration Design

## Context

The home-unification work moved user-visible configuration to `~/.ohbaby`
and runtime data to the platform data directory named `ohbaby`. macOS and
Linux behavior is already implemented. Running the affected tests on Windows
exposed platform-specific assumptions in migration reports, POSIX permission
assertions, and CLI path assertions. The repository CI currently runs only on
Ubuntu, so these regressions were not detected before merge.

## Decision

Keep the existing path facade and migration architecture. Add the smallest
platform-aware corrections and test the actual Windows filesystem behavior
instead of introducing a second migration implementation.

- Windows configuration remains `%USERPROFILE%\.ohbaby`.
- Windows runtime data remains `%LOCALAPPDATA%\ohbaby`.
- Legacy Windows data is read from `%APPDATA%\ohbaby-agent`.
- macOS keeps `~/Library/Application Support/ohbaby`.
- Linux keeps `$XDG_DATA_HOME/ohbaby` or `~/.local/share/ohbaby`.
- Migration retains the legacy source on Windows for rollback and writes only
  to the unified destination.

## Components and Data Flow

1. `paths/ohbaby-home.ts` resolves native roots for the selected platform.
2. `migration/ohbaby-home.ts` copies configuration and data into those roots,
   normalizes report paths, and skips POSIX permission operations on Windows.
3. CLI and server startup continue invoking the same idempotent migration
   entry points before configuration or database initialization.
4. Tests exercise both pure path selection and real filesystem migration.
5. CI runs the unit suite on Ubuntu, Windows, and macOS.

## Error and Conflict Handling

Existing safety behavior remains authoritative: target files are not silently
overwritten, `.env` and MCP settings merge additively with new values winning,
SQLite database/WAL/SHM move as one group, a live daemon blocks data migration,
and migration markers make restarts idempotent. Tests must not log secret file
contents.

## Verification

- Reproduce and fix the Windows migration and CLI failures using TDD.
- Add native Windows configuration and Roaming-to-Local migration coverage.
- Retain Linux and macOS path tests.
- Run targeted tests, typecheck, lint, and the full test suite.
- Only after code verification, migrate this machine's global and project
  configuration and compare file inventories/database hashes without exposing
  secrets.
