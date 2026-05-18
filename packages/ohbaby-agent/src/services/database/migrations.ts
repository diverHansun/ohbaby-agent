import type { MigrationDefinition } from "./types.js";

export const INITIAL_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: "001_initial",
    sql: `
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        agent TEXT,
        parent_id TEXT,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER,
        data TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_session_project_updated ON session(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_session_parent ON session(parent_id);

      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        agent TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_session_time ON message(session_id, created_at);

      CREATE TABLE IF NOT EXISTS part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        order_index INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (message_id, session_id)
          REFERENCES message(id, session_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id, order_index);
      CREATE INDEX IF NOT EXISTS idx_part_session ON part(session_id);

      CREATE TABLE IF NOT EXISTS run_ledger (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        error TEXT,
        UNIQUE (run_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_ledger_session ON run_ledger(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_run_ledger_status ON run_ledger(status);

      CREATE TABLE IF NOT EXISTS snapshot_checkpoint (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        run_id TEXT,
        turn_id TEXT NOT NULL,
        workdir TEXT NOT NULL,
        workspace_source TEXT,
        message_cursor_before TEXT,
        message_cursor_after TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (run_id, session_id)
          REFERENCES run_ledger(run_id, session_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_snapshot_session ON snapshot_checkpoint(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_snapshot_run_turn ON snapshot_checkpoint(session_id, run_id, turn_id);

      CREATE TABLE IF NOT EXISTS snapshot_patch (
        patch_id TEXT PRIMARY KEY,
        checkpoint_id TEXT NOT NULL REFERENCES snapshot_checkpoint(checkpoint_id) ON DELETE CASCADE,
        artifact_path TEXT,
        file_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduler_job (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
        next_run_at INTEGER NOT NULL,
        cron_expr TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scheduler_next_run ON scheduler_job(next_run_at, status);
      CREATE INDEX IF NOT EXISTS idx_scheduler_kind_status ON scheduler_job(kind, status);
    `,
  },
  {
    version: "002_part_order_unique",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_part_message_order_unique
        ON part(message_id, order_index);
    `,
  },
  {
    version: "003_app_state",
    sql: `
      CREATE TABLE IF NOT EXISTS app_state (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
    `,
  },
];
