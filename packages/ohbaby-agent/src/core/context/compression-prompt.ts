export const COMPRESSION_PROMPT = `Create a compact XML state snapshot for the conversation history.

Return only this shape:
<state_snapshot>
  <overall_goal></overall_goal>
  <key_knowledge></key_knowledge>
  <file_system_state></file_system_state>
  <recent_actions></recent_actions>
  <current_plan></current_plan>
</state_snapshot>`;
