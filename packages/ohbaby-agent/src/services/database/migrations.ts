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
  {
    version: "004_drop_scheduler_job",
    sql: `
      DROP TABLE IF EXISTS scheduler_job;
    `,
  },
  {
    version: "005_snapshot_git_sidecar",
    sql: `
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

      ALTER TABLE snapshot_checkpoint ADD COLUMN pre_tree_ref TEXT;
      ALTER TABLE snapshot_patch ADD COLUMN post_tree_ref TEXT;
    `,
  },
  {
    version: "006_run_owner",
    sql: `
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

      CREATE TABLE IF NOT EXISTS app_state (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );

      ALTER TABLE run_ledger ADD COLUMN owner_id TEXT;
      ALTER TABLE run_ledger ADD COLUMN owner_pid INTEGER;

      DELETE FROM app_state
        WHERE scope = 'global' AND key = 'persistentUiBackendLease';
    `,
  },
  {
    version: "007_goal_record",
    sql: `
      CREATE TABLE IF NOT EXISTS goal_record (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `,
  },
  {
    version: "008_subagent_instance",
    sql: `
      CREATE TABLE IF NOT EXISTS subagent_instance (
        subagent_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        context_scope_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT,
        description TEXT,
        initial_prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        output TEXT,
        error TEXT,
        pending_queue TEXT NOT NULL DEFAULT '[]',
        current_run_id TEXT,
        last_run_id TEXT,
        timeout_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        interrupted_at INTEGER,
        closed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_subagent_instance_parent
        ON subagent_instance(parent_session_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_subagent_instance_status
        ON subagent_instance(status);
      CREATE INDEX IF NOT EXISTS idx_subagent_instance_session
        ON subagent_instance(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_instance_scope
        ON subagent_instance(session_id, context_scope_id);
    `,
  },
  {
    version: "009_run_ledger_context_scope",
    sql: `
      ALTER TABLE run_ledger ADD COLUMN context_scope_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_run_ledger_session_scope_status
        ON run_ledger(session_id, context_scope_id, status, created_at);
    `,
  },
  {
    version: "010_message_context_scope",
    sql: `
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

      ALTER TABLE message ADD COLUMN context_scope_id TEXT;

      UPDATE message
        SET context_scope_id = json_extract(data, '$.contextScopeId')
        WHERE json_valid(data)
          AND json_extract(data, '$.contextScopeId') IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_message_session_scope_time
        ON message(session_id, context_scope_id, created_at);
    `,
  },
  {
    version: "011_subagent_instance_owner",
    sql: `
      CREATE TABLE IF NOT EXISTS subagent_instance (
        subagent_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        context_scope_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT,
        description TEXT,
        initial_prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        output TEXT,
        error TEXT,
        pending_queue TEXT NOT NULL DEFAULT '[]',
        current_run_id TEXT,
        last_run_id TEXT,
        timeout_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        interrupted_at INTEGER,
        closed_at INTEGER
      );

      ALTER TABLE subagent_instance ADD COLUMN owner_id TEXT;
      ALTER TABLE subagent_instance ADD COLUMN owner_pid INTEGER;

      CREATE INDEX IF NOT EXISTS idx_subagent_instance_owner_status
        ON subagent_instance(owner_id, owner_pid, status, updated_at);
    `,
  },
  {
    version: "012_subagent_instance_current_input",
    sql: `
      ALTER TABLE subagent_instance ADD COLUMN current_input TEXT;
    `,
  },
  {
    version: "013_workspace_registry",
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_registry (
        scope_key TEXT PRIMARY KEY,
        visibility TEXT NOT NULL CHECK (visibility IN ('visible', 'hidden')),
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_registry_position
        ON workspace_registry(position);
    `,
  },
  {
    version: "014_prompt_submission",
    sql: `
      CREATE TABLE IF NOT EXISTS prompt_submission (
        prompt_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'queued', 'starting', 'running',
            'succeeded', 'failed', 'cancelled', 'interrupted'
          )
        ),
        run_id TEXT,
        owner_id TEXT,
        owner_pid INTEGER,
        error_data TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_submission_scope_status_order
        ON prompt_submission(scope_key, status, created_at, prompt_id);
      CREATE INDEX IF NOT EXISTS idx_prompt_submission_session_status_order
        ON prompt_submission(session_id, status, created_at, prompt_id);

      ALTER TABLE run_ledger ADD COLUMN error_data TEXT;
    `,
  },
  {
    version: "015_prompt_submission_idempotency_lease",
    sql: `
      ALTER TABLE prompt_submission
        ADD COLUMN client_request_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE prompt_submission ADD COLUMN edit_lease_id TEXT;
      ALTER TABLE prompt_submission ADD COLUMN edit_lease_owner_id TEXT;
      ALTER TABLE prompt_submission ADD COLUMN edit_lease_expires_at INTEGER;

      UPDATE prompt_submission
      SET client_request_id = 'legacy:' || prompt_id
      WHERE client_request_id = '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_submission_scope_client_request
        ON prompt_submission(scope_key, client_request_id)
        WHERE client_request_id <> '';
    `,
  },
  {
    version: "016_prompt_submission_reasoning",
    sql: `ALTER TABLE prompt_submission ADD COLUMN reasoning_data TEXT;`,
  },
  {
    version: "017_message_recovery_pages",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_message_session_page
        ON message(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_message_session_scope_page
        ON message(session_id, context_scope_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_message_session_run_page
        ON message(session_id, json_extract(data, '$.runId'), created_at, id);
    `,
  },
  {
    version: "018_subagent_execution",
    sql: `
      CREATE TABLE subagent_execution (
        execution_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        requester_scope_id TEXT NOT NULL,
        requester_run_id TEXT NOT NULL,
        root_session_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL,
        root_prompt_id TEXT,
        subagent_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('foreground', 'background')),
        prompt TEXT NOT NULL,
        timeout_ms INTEGER,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'timed_out')),
        child_session_id TEXT,
        child_scope_id TEXT,
        child_run_id TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        reason TEXT,
        output TEXT,
        error TEXT,
        artifact TEXT NOT NULL,
        delivery TEXT NOT NULL,
        late_result TEXT,
        UNIQUE(requester_run_id, request_id)
      );
      CREATE INDEX idx_subagent_execution_root
        ON subagent_execution(root_run_id, created_at, execution_id);
      CREATE INDEX idx_subagent_execution_history
        ON subagent_execution(parent_session_id, subagent_id, created_at, execution_id);
      CREATE INDEX idx_subagent_execution_scope_history
        ON subagent_execution(parent_session_id, requester_scope_id, created_at, execution_id);
    `,
  },
  {
    version: "019_current_run_input",
    sql: `
      ALTER TABLE run_ledger ADD COLUMN inputs_closed_at INTEGER;
      ALTER TABLE run_ledger ADD COLUMN inputs_close_reason TEXT;
      CREATE TABLE prompt_submission_next (
        prompt_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','starting','running','succeeded','failed','cancelled','interrupted','steered')),
        run_id TEXT, owner_id TEXT, owner_pid INTEGER, error_data TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        started_at INTEGER, ended_at INTEGER, client_request_id TEXT NOT NULL DEFAULT '',
        edit_lease_id TEXT, edit_lease_owner_id TEXT, edit_lease_expires_at INTEGER,
        reasoning_data TEXT, steer_receipt TEXT
      );
      INSERT INTO prompt_submission_next
        (prompt_id,scope_key,session_id,user_message_id,text,status,run_id,owner_id,owner_pid,error_data,created_at,updated_at,started_at,ended_at,client_request_id,edit_lease_id,edit_lease_owner_id,edit_lease_expires_at,reasoning_data)
      SELECT prompt_id,scope_key,session_id,user_message_id,text,status,run_id,owner_id,owner_pid,error_data,created_at,updated_at,started_at,ended_at,client_request_id,edit_lease_id,edit_lease_owner_id,edit_lease_expires_at,reasoning_data FROM prompt_submission;
      DROP TABLE prompt_submission;
      ALTER TABLE prompt_submission_next RENAME TO prompt_submission;
      CREATE INDEX idx_prompt_submission_scope_status_order ON prompt_submission(scope_key,status,created_at,prompt_id);
      CREATE INDEX idx_prompt_submission_session_status_order ON prompt_submission(session_id,status,created_at,prompt_id);
      CREATE UNIQUE INDEX idx_prompt_submission_scope_client_request ON prompt_submission(scope_key,client_request_id) WHERE client_request_id <> '';
      CREATE UNIQUE INDEX idx_prompt_steer_request ON prompt_submission(scope_key,json_extract(steer_receipt,'$.clientRequestId')) WHERE steer_receipt IS NOT NULL;
      CREATE TABLE current_run_input (
        input_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES run_ledger(run_id),
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('user-steer','subagent-result','subagent-status')),
        source_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE REFERENCES message(id) ON DELETE CASCADE,
        accepted_at INTEGER NOT NULL, data TEXT NOT NULL,
        UNIQUE(run_id,source,source_id)
      );
      CREATE INDEX idx_current_run_input_run ON current_run_input(run_id,accepted_at,input_id);
    `,
  },
  {
    version: "020_final_step_steer_admission",
    sql: `
      ALTER TABLE run_ledger ADD COLUMN steer_closed_at INTEGER;
      CREATE TABLE current_run_request_owner (
        request_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE
      );
      INSERT INTO current_run_request_owner(request_id,message_id)
      SELECT json_extract(request.value,'$.requestId'),message.id
      FROM message, json_each(message.data,'$.modelRequests') request
      WHERE json_extract(request.value,'$.requestId') IS NOT NULL;
    `,
  },
];
