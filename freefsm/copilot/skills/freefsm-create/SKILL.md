---
name: freefsm-create
description: Create a FreeFSM workflow file through interactive discovery, then save a valid YAML workflow for later use with `freefsm start`.
---

# Create a FreeFSM workflow

Use this skill when the user wants to design a new FreeFSM workflow.

## Process

1. Ask one focused question at a time to understand the workflow outcome, the main phases, and any human approval points.
2. Draft a practical FSM with a small number of states, clear prompts, and explicit transitions.
3. Save the workflow to the user-requested path, or default to `./workflows/<name>.fsm.yaml`.
4. Validate the YAML before finishing.

## Authoring rules

- Keep prompts self-contained and portable across agents.
- Prefer 3-7 states plus `done` unless the user asks for more.
- Include at least one realistic rework or failure path when appropriate.
- Transition labels should be concise and meaningful.

## Validation checklist

- `version: 1`
- `guide` is present
- `initial` references an existing state
- terminal `done` state exists
- every non-terminal state has transitions
- transition targets refer to existing states
- state names match `[A-Za-z_-][A-Za-z0-9_-]*`
