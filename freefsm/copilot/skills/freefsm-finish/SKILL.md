---
name: freefsm-finish
description: Abort an active FreeFSM workflow run with `freefsm finish` and present the terminal summary.
---

# Abort a FreeFSM run

Use this skill when the user wants to stop the active workflow before it reaches `done`.

## Process

1. Use the remembered `run_id` from the active workflow in this conversation.
2. Run:

```bash
freefsm finish --run-id <run_id>
```

3. Show the terminal summary and note that the run is now aborted.

## Error handling

- `RUN_NOT_FOUND`: explain that the run does not exist.
- `RUN_NOT_ACTIVE`: explain that the run is already completed or aborted.
- If there is no remembered `run_id`, ask the user which run to finish.
