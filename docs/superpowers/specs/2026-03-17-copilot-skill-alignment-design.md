# Copilot Skill Alignment Design

## Problem

The current Copilot integration fixed a real loading failure, but it did so by introducing simplified Copilot-only skills that no longer match the canonical FreeFSM skills used by Claude Code and the rest of the project.

The user wants a stricter compatibility boundary:

- FreeFSM usage in Copilot should match Claude Code as closely as possible.
- The only intentional Copilot exceptions should be:
  - skill naming and invocation syntax required by Copilot
  - the `preToolUse` hook behavior used to surface FSM reminders
- Any other Copilot-specific behavior differences should be removed.

## Goals

1. Make Copilot skill behavior match the canonical FreeFSM skills.
2. Keep Copilot-specific changes to the minimum required by the platform.
3. Preserve the existing Copilot hook model centered on `preToolUse`.
4. Avoid adding new generation/build complexity.

## Non-Goals

- Replacing the current `preToolUse` reminder design in this step.
- Introducing a skill-generation pipeline.
- Adding extra install-time validation logic beyond what Copilot itself already enforces.
- Changing the canonical Claude/Codex skill content as part of this alignment work, unless a directly related mismatch is discovered.

## Approved Compatibility Boundary

The compatibility boundary is:

1. `freefsm/skills/*/SKILL.md` remains the canonical source for FreeFSM skill behavior.
2. `freefsm/copilot/skills/*/SKILL.md` remains a Copilot-only copy, maintained manually.
3. Copilot skill copies may differ only where Copilot requires it:
   - frontmatter `name:`
   - explicit skill invocation strings in the body
4. Skill behavior must otherwise stay aligned:
   - usage
   - process steps
   - execution model
   - error handling
   - user-facing guidance
5. Runtime behavioral differences must stay isolated to the Copilot hook layer, specifically `preToolUse`.

## Chosen Approach

Use manually maintained Copilot skill copies, aligned as closely as possible to the canonical skills.

### Why this approach

- It minimizes new machinery.
- It satisfies the user’s preference to avoid wrapper/generation complexity.
- It keeps the compatibility story easy to understand: one canonical skill set, one Copilot-compatible mirror with only necessary naming adaptations.

### Alternatives considered

#### A. Generated Copilot wrappers from canonical skills

Pros:

- lowest risk of future drift
- clean “single source of truth” story

Cons:

- adds tooling/build complexity
- increases maintenance surface
- rejected by user as heavier than necessary

#### B. Install-time generation only

Pros:

- avoids committed generated files

Cons:

- pushes complexity into install
- harder to debug and test
- violates the user’s preference to minimize changes

#### C. No Copilot-specific skills

Pros:

- least code

Cons:

- does not work with Copilot skill-name restrictions
- fails the “same usage as Claude Code, except where strictly necessary” requirement

## File-Level Design

### Canonical skills

Keep these files as the canonical FreeFSM skills:

- `freefsm/skills/create/SKILL.md`
- `freefsm/skills/start/SKILL.md`
- `freefsm/skills/current/SKILL.md`
- `freefsm/skills/finish/SKILL.md`

These files continue to define the intended FreeFSM behavior.

### Copilot skills

Keep Copilot-specific copies under:

- `freefsm/copilot/skills/create/SKILL.md`
- `freefsm/copilot/skills/start/SKILL.md`
- `freefsm/copilot/skills/current/SKILL.md`
- `freefsm/copilot/skills/finish/SKILL.md`

Each of these should be manually updated to match its canonical counterpart, except for required naming substitutions.

The Copilot skill set must stay in 1:1 parity with the canonical skill set for this feature:

- `create` ↔ `create`
- `start` ↔ `start`
- `current` ↔ `current`
- `finish` ↔ `finish`

Missing, renamed, or extra Copilot skills should be treated as a regression.

### Allowed substitutions

The allowed substitutions are:

- `name: freefsm:create` → `name: create`
- `name: freefsm:start` → `name: start`
- `name: freefsm:current` → `name: current`
- `name: freefsm:finish` → `name: finish`

No other intentional content simplification should remain in the Copilot copies.

## Alignment Test Contract

The alignment test should compare each Copilot skill against its canonical counterpart after applying a deterministic normalization step to the Copilot file.

Normalization should convert:

- `name: create` → `name: freefsm:create`
- `name: start` → `name: freefsm:start`
- `name: current` → `name: freefsm:current`
- `name: finish` → `name: freefsm:finish`

After normalization, the Copilot file content should match the canonical file content exactly.

This gives a precise, testable contract:

- same file set
- same behavior text
- same process and error-handling content
- only the approved Copilot naming substitutions differ

## Plugin and Install Surface

### `plugin.json`

Keep `plugin.json` pointing at `copilot/skills`, because Copilot cannot load the canonical skill names that use colons.

This is a necessary platform-level exception, not a behavioral one.

### `freefsm install copilot`

Minimize install logic changes by narrowing the installer to the baseline Copilot flow:

- invoke `copilot plugin install <package-root>`
- keep only generic command-level failure handling
- do not proactively validate Copilot skill metadata before install
- do not add new Copilot-specific preflight checks in this alignment step
- rely on real Copilot loading and tests to catch compatibility regressions

This keeps install behavior narrow and avoids adding extra Copilot-specific exceptions outside the hook and naming layers.

## Testing Design

### 1. Alignment tests

Add or update tests so that each Copilot skill is compared against its canonical counterpart.

The test should enforce all of the following:

- the Copilot skill set is exactly the expected mirrored set
- each Copilot skill maps to the correct canonical skill
- after normalization, each Copilot skill matches its canonical file byte-for-byte

This is the core regression guard against future drift.

### 2. Copilot e2e

Keep the real Copilot e2e coverage and ensure it still proves:

- the plugin installs
- Copilot starts successfully
- skill metadata does not fail to load
- the `preToolUse` reminder path still works

### 3. Scope check

The implementation should avoid adding new Copilot-only behavior outside:

- `copilot/skills` name adaptation
- `preToolUse` hook handling

## Acceptance Criteria

This work is complete when all of the following are true:

1. Every Copilot skill matches its canonical skill except for allowed naming substitutions.
2. Copilot no longer uses simplified FreeFSM skill instructions.
3. `plugin.json` still loads Copilot-compatible skills successfully.
4. Real Copilot e2e passes without skill-load failures.
5. No new install-time validation layer is added for Copilot skill metadata.
6. `freefsm install copilot` stays limited to the baseline plugin install path rather than custom Copilot preflight validation.

## Risks and Mitigations

### Risk: manual copies drift again

Mitigation:

- add explicit alignment tests
- document the compatibility boundary clearly

### Risk: a canonical skill changes and Copilot copy is forgotten

Mitigation:

- alignment test should fail immediately

### Risk: over-correcting and introducing extra Copilot-specific exceptions again

Mitigation:

- keep acceptance criteria explicit
- treat any non-name, non-hook divergence as a regression unless the user approves it explicitly
