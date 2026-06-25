# Bus Event Catalog

Bus is the internal domain event bus. This catalog records scope, required context, and UI visibility decisions for the current internal events.

| Event | Owner | Scope | Audience | Frequency | Required context | Context status | UI visible | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| commands.started | Commands | app | ui-projection, daemon, tests | medium | commandRunId, clientInvocationId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| commands.result.delivered | Commands | app | ui-projection, daemon, tests | medium | commandRunId, clientInvocationId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| commands.failed | Commands | app | ui-projection, daemon, tests | low | commandRunId, clientInvocationId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| commands.catalog.updated | Commands | app | ui-projection, daemon, tests | low | version, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| interaction.requested | Interaction | app | ui-projection, daemon, tests | medium | request.interactionId, request.commandRunId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| interaction.resolved | Interaction | app | ui-projection, daemon, tests | medium | interactionId, commandRunId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| permission.mode.changed | Permission | app | ui-projection, tests | low | current, previous | complete | yes | Stateful in-process projection publishes permission.updated. |
| permission.level.changed | Permission | app | ui-projection, tests | low | current, previous | complete | yes | Stateful in-process projection publishes permission.updated. |
| permission.rule.added | Permission | session | ui-projection, tests | low | sessionId, rule | complete | yes | Stateful in-process projection publishes permission.updated. |
| permission.updated | Permission | run | ui-projection, tests | medium | info.sessionId, info.messageId, info.callId, info.id, projector.activeRunId | complete | yes | Stateful in-process projection supplies active run context for permission.requested; no-active-run callId fallback remains legacy and is not bus payload scope. |
| permission.replied | Permission | run | ui-projection, tests | medium | sessionId, permissionId, callId | complete | yes | Stateful in-process projection publishes permission.resolved. |
| message.updated | Message | session | domain, tests | medium | info.sessionId, info.id | complete | no | Do not project directly because SDK has a different message.updated payload. |
| message.removed | Message | session | domain, tests | low | sessionId, messageId | complete | no | Internal domain event only. |
| message.part-updated | Message | session | domain, tests | high | part.sessionId, part.messageId, part.id | complete | no | Do not project directly because run stream owns message.part.delta. |
| message.part-removed | Message | session | domain, tests | low | sessionId, messageId, partId | complete | no | Internal domain event only. |
| context.compressed | Context | session | domain, tests | low | sessionId, result | complete | no | Internal domain event only. |
| context.pruned | Context | session | domain, tests | low | sessionId, result | complete | no | Internal domain event only. |
| context.turn-prepared | Context | session | domain, tests | medium | sessionId, usage, tookMs | complete | no | Run stream owns user-visible run context events. |
| context.compact-skipped | Context | session | domain, tests | low | sessionId, reason, usage | complete | no | Internal domain event only. |
| context.masked | Context | session | domain, tests | medium | sessionId, enabled, maskedPartIds, maskedTokens, cutoff, usageRatio | complete | no | Internal projection telemetry; run stream owns user-visible context updates. |
| memory.added | Memory | project | domain, tests | low | scope, text | known-gap | no | Project memory lacks directory/projectRoot; keep internal until payload decision. |
| memory.updated | Memory | project | domain, tests | low | scope, index, newText | known-gap | no | Project memory lacks directory/projectRoot; keep internal until payload decision. |
| memory.removed | Memory | project | domain, tests | low | scope, index | known-gap | no | Project memory lacks directory/projectRoot; keep internal until payload decision. |
| memory.refreshed | Memory | project | domain, tests | low | directory, memory | complete | no | Internal domain event only. |
| tool-scheduler.status-changed | ToolScheduler | run | domain, tests | high | callId, toolName, timestamp | known-gap | no | Missing runId/sessionId/messageId; run stream owns visible tool events. |
| tool-scheduler.execution-started | ToolScheduler | run | domain, tests | high | callId, toolName, timestamp | known-gap | no | Missing runId/sessionId/messageId; run stream owns visible tool events. |
| tool-scheduler.execution-completed | ToolScheduler | run | domain, tests | high | callId, toolName, timestamp | known-gap | no | Missing runId/sessionId/messageId; run stream owns visible tool events. |
| session.created | Session | project | domain, tests | low | session.id, session.projectRoot | complete | no | Domain event; UI session projection remains separate. |
| session.updated | Session | project | domain, tests | low | session.id, session.projectRoot | complete | no | Domain event; UI session projection remains separate. |
| session.removed | Session | project | domain, tests | low | sessionId | complete | no | Domain event; UI session projection remains separate. |
