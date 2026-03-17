---
name: freefsm-current
description: Show the current state of an active FreeFSM workflow run with `freefsm current`, including the prompt, todos, and available transitions.
---

# Show the current FreeFSM state

Use this skill when the user wants to inspect workflow progress or re-sync with the current state card.

## Process

1. Use the remembered `run_id` from the active workflow in this conversation.
2. Run:

```bash
freefsm current --run-id <run_id>
```

3. Present the current state, prompt, todos, and available transitions.

## Error handling

- `RUN_NOT_FOUND`: explain that the run does not exist and suggest starting a workflow first with `/freefsm-start`.
- If there is no remembered `run_id`, ask the user which run to inspect.
