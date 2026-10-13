export const COMPRESSION_PROMPT = `Read the conversation history above and create a compact checkpoint that another coding agent can use to continue the work.

Output only the summary, without tools or continuing the conversation. Keep the entire summary under 16384 tokens; this is a ceiling, not a target. Write in the language of the latest substantive user instructions.

Use this exact format:

## Goal
- [single-sentence task summary]

## Current State
- Done: [completed work, or "(none)"]
- In progress: [current work, or "(none)"]
- Blocked: [blockers, or "(none)"]

## Key Decisions
- [decision]: [reason]

## User Intent & Feedback
- [preserve important user requirements, corrections, preferences, and approvals]

## Relevant Files
- [exact file paths, functions, tests, commands, or "(none)"]

## Next Steps
1. [next concrete action]

## Risks
- [known risks, failing tests, uncertainties, or "(none)"]

Rules:
- Preserve exact file paths, function names, command names, errors, model names, and numbers.
- Preserve all user intent, but summarize long pasted logs or code instead of copying them wholesale.
- Keep bullets terse and factual.
- Never include credentials, tokens, passwords, secret values, or private keys.
- Do not mention summarization, compression, compacting, or that this is a summary.
- Do not invent completed work or test results.`;
