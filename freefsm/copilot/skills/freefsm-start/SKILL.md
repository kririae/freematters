---
name: freefsm-start
description: Start a FreeFSM workflow run with `freefsm start`, remember the generated run ID, and continue following the workflow until it reaches a terminal state or needs user input.
---

# Start a FreeFSM run

Use this skill when the user wants to begin a workflow from a YAML file or bundled workflow name.

## Process

1. Resolve the workflow path. If the user supplied a bare name, first check `./workflows/<name>.fsm.yaml`, then the bundled FreeFSM workflows.
2. Generate a descriptive run ID with lowercase letters, numbers, and hyphens, and always pass `--run-id`.
3. Run:

```bash
freefsm start <PATH> --run-id <run_id>
```

4. Remember the `run_id` for later `freefsm current`, `freefsm goto`, and `freefsm finish` calls in this conversation.
5. Follow the state card. After each transition, continue the workflow immediately unless the current state clearly requires user input.
6. Before ending your turn, run `freefsm current --run-id <run_id>` to confirm there is no remaining actionable work in the current state.

## Error handling

- `RUN_EXISTS`: generate a different run ID and retry.
- `SCHEMA_INVALID`: show the validation error and suggest using `/freefsm-create` to build a valid workflow.
