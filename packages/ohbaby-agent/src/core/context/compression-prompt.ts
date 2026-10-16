export const COMPRESSION_PROMPT = `Read the conversation history above and create a compact checkpoint that another coding agent can use to continue the work. That agent will see only this checkpoint and the most recent messages, so the checkpoint must stand on its own.

Output only the summary, without tools or continuing the conversation. Keep the entire summary under 16384 tokens; this is a ceiling, not a target. Write in the language of the latest substantive user instructions.

Use this exact format:

## Goal
- [single-sentence task summary]

## Current State
- Done: [completed work, or "(none)"]
- In progress: [current work, or "(none)"]
- Blocked: [blockers, failing tests, unresolved risks, or "(none)"]

## Key Decisions
- [decision]: [reason]

## User Intent & Feedback
- [preserve important user requirements, corrections, preferences, and approvals]
- [if the user's latest question or request is still unanswered, quote it verbatim]

## Relevant Files
- [exact file paths, functions, tests, or commands, most important first, at most 15; or "(none)"]

## Next Steps
1. [next concrete action, directly in line with the user's most recent request]

Rules:
- Merge all previous checkpoints into this checkpoint, preserving still-relevant constraints, decisions, unfinished work, and risks.
- Preserve exact file paths, function names, command names, errors, model names, and numbers.
- Preserve all user intent, but summarize long pasted logs or code instead of copying them wholesale.
- Keep bullets terse and factual; prefer short references over restating code the next agent can reread.
- Never include credentials, tokens, passwords, secret values, or private keys.
- Do not mention summarization, compression, compacting, or that this is a summary.
- Do not invent completed work or test results.`;
