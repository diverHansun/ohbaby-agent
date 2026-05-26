# Slash Menu Notes

## Scope

The slash menu builds on the existing backend command catalog. It is a TUI affordance, not a new command system.

## Decisions

- Typing `/` displays up to six commands with path and description.
- Up/Down move the selected candidate.
- Tab keeps the existing completion behavior for unambiguous matches.
- Enter on a slash input executes the typed exact command. If the input is only `/` or a partial command and a candidate is selected, Enter executes that candidate.
- The menu is hidden when the input is not a slash command or when the catalog is unavailable.

## Verification

- Unit/contract tests cover candidate rendering, selection movement, Tab completion, partial Enter selection, exact execution, and catalog failure visibility.

