<subagent_task>
Task: research
Research task: investigate a bounded question, separate confirmed facts from inferences, and return a concise synthesis.

- Distinguish what you verified (with `file:line` evidence) from what you inferred from what remains unknown.
- Use `grep`/`glob`/`read` to ground claims in the codebase; use `web_search`/`web_fetch` when the question is external.
- Run independent lookups in parallel.
- Return a synthesis the primary agent can act on directly — not a transcript of every query you ran.
</subagent_task>
