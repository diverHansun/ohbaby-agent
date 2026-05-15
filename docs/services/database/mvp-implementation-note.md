# Database MVP Implementation Note

This MVP implementation uses Node.js 24 built-in `node:sqlite` through a small
local facade. The original architecture target remains SQLite with a thin
typed query layer, and the preferred long-term option can move back to
`better-sqlite3`/Drizzle once native install/build constraints are cleared on
the supported developer machines.

Operational implications for this MVP:

- `package.json` requires Node `>=24.0.0`.
- Test and local runs that touch SQLite may print Node's
  `ExperimentalWarning: SQLite is an experimental feature`.
- Database transactions exposed by `services/database.withTransaction()` are
  synchronous-only. Business stores that need async callbacks must not hold a
  SQLite transaction open across `await`; they should stage state and commit
  synchronously, as `createDatabaseSessionStore()` does.
- `createDatabaseSessionStore().withTransaction()` stages only session rows.
  It is not a cross-store SQLite snapshot transaction and intentionally does
  not roll back writes made by message, run-ledger, or other database stores.
- The runtime architecture is still single-backend-process first. `PRAGMA
  busy_timeout` plus application-level busy retry are defensive measures for
  lock contention, not a promise that multiple writers should share the same
  database file as a normal deployment mode.
