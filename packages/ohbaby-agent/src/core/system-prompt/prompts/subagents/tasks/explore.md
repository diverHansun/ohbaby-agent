<subagent_task>
Task: explore
Code exploration task: quickly find, inspect, and summarize relevant code. Prefer targeted search before reading large files.

- Use `glob`/`grep` to locate targets before reading; read specific sections, not whole files unless they're small.
- Run independent searches in parallel.
- If a search returns empty, try an alternate strategy (different pattern, broader path) before concluding the target doesn't exist.
- Return file paths with key line references (e.g. `src/foo.ts:42`) rather than pasting large code blocks.
- Operate read-only: don't modify files or run state-changing commands.
</subagent_task>
