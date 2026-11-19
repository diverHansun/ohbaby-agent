import { expect, it } from "vitest";
import { INITIAL_MIGRATIONS } from "./migrations.js";

it("retains every published migration identifier", () => {
  const published = [
    "001_initial",
    "002_part_order_unique",
    "003_app_state",
    "004_drop_scheduler_job",
    "005_snapshot_git_sidecar",
    "006_run_owner",
    "007_goal_record",
    "008_subagent_instance",
    "009_run_ledger_context_scope",
    "010_message_context_scope",
    "011_subagent_instance_owner",
    "012_subagent_instance_current_input",
    "013_workspace_registry",
    "014_prompt_submission",
    "015_prompt_submission_idempotency_lease",
    "016_prompt_submission_reasoning",
    "017_message_recovery_pages",
    "018_subagent_execution",
    "019_current_run_input",
    "020_final_step_steer_admission",
    "021_subagent_delegation_identity",
    "022_retained_prompt_admission",
    "023_prompt_naming_source",
    "024_prompt_resend_parent",
    "025_session_project_binding",
    "026_session_workspace_naming",
    "027_prompt_submission_model_entry",
    "028_subagent_message_input",
    "029_message_rewind",
    "030_subagent_goal_ownership",
    "031_shell_job",
    "032_background_task_input",
    "033_shell_job_promoted_at",
  ];
  expect(INITIAL_MIGRATIONS.map(({ version }) => version)).toEqual(
    expect.arrayContaining(published),
  );
});
