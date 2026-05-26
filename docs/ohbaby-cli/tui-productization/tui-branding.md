# TUI Branding And Composer Notes

## Scope

This slice keeps the current Ink 6 renderer and improves the visible shell of the MVP TUI. It does not introduce a new terminal framework, mouse support, themes, a full multiline editor, or attachable server behavior.

## Decisions

- Use `ohbaby` as the assistant-facing label in transcripts.
- Use `ohbaby >` as the input prompt so the first interactive affordance matches the installed binary.
- Show a compact ASCII logo only when there are no messages. Restored sessions should prioritize the transcript and avoid pushing useful content down.
- Add lightweight header/footer components inspired by opencode and DeepSeek-TUI, but keep them quiet: brand, current status, active session, and command hints.
- Show the current policy mode in the footer when the backend provides it.
- Keep the existing prompt submission semantics from the main-chain closure work: submit clears immediately, dialog disables typing, and Ctrl+C abort behavior remains in `OhbabyTerminalApp`.

## Verification

- Contract tests cover label rendering, empty-state logo, prompt input text, and no regressions for submit/abort/dialog behavior.
- TUI integration tests continue to cover streaming, tool permission, abort, and post-abort recovery.
