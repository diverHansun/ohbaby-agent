# tool-scheduler improve-1 review and improvements

Date: 2026-05-29

## Review Summary

The pre-implementation review found four concrete mismatches between design intent and code:

- Skill tools were reported as `source: "module"` even though they are owned by the skill system.
- Scheduler carried MCP-specific trust logic through `untrustedMcp` and `tool.isTrusted`.
- MCP adapters exposed trust metadata but did not map it to a generic scheduler approval field.
- `composition.ts` contained stream bridge event conversion and generic formatting helpers that can be tested independently.

## Improvement Decisions

### Tool source semantics

`ToolSource` now has four origins:

```ts
type ToolSource = "builtin" | "module" | "skill" | "mcp";
```

Skill behavior remains `category: "skill"`, but skill origin is no longer folded into `module`.

### Explicit approval

Scheduler no longer owns an MCP-specific trust path. Any tool can set:

```ts
requireExplicitApproval: true
```

When present, scheduler asks permission with `reason: "explicit-approval-required"` and `rememberable: false`.

MCP keeps `isTrusted` as MCP-local metadata and maps trust to `requireExplicitApproval`.

### Composition boundary

`composition.ts` remains the composition root. improve-1 only extracts:

- stream bridge run event conversion
- unknown-value formatting for runtime notices

This avoids a broad factory split while making the extracted behavior directly testable.

## Acceptance Checks

- Skill and skill resource tools list as `source: "skill"`.
- `source: "mcp"` alone does not force extra approval.
- `requireExplicitApproval: true` forces a non-rememberable ask for both MCP and non-MCP tools.
- `mcp_resource` and `mcp_prompt` are explicitly approval-gated.
- Extracted UI runtime helpers have focused unit tests.
