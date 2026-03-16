# FreeFSM Copilot CLI Extension Design

> Add Copilot CLI support to freefsm via the extension system, reusing existing skills and CLI.

## Problem

FreeFSM is designed primarily for Claude Code. It uses Claude Code's plugin system (`hooks.json` for PostToolUse reminders, `SKILL.md` for slash commands). Copilot CLI has a richer extension system (programmatic hooks, custom tools, session events) but freefsm has no integration for it.

The goal: bring freefsm's FSM enforcement to Copilot CLI with minimal changes, maximum reuse, and merge-friendliness toward upstream.

## Proposed Approach

Create a thin Copilot CLI extension (`extension.mjs`) that provides hook-based FSM enforcement, plus an install command (`freefsm install copilot`) that links both the existing skills and the new extension to the user's Copilot configuration.

### Key Insight: Skills Are Already Compatible

Copilot CLI natively supports `SKILL.md` files with the same format as Claude Code:

- Project level: `.github/skills/` or `.claude/skills/`
- User level: `~/.copilot/skills/` or `~/.claude/skills/`

FreeFSM's existing skills (`/freefsm:start`, `/freefsm:create`, `/freefsm:current`, `/freefsm:finish`) work on Copilot CLI without modification. They just need to be installed to a discoverable location.

### What's Actually New

Only the **hook layer** is platform-specific. Claude Code uses `hooks.json` (command-based, stateless per invocation). Copilot CLI uses extensions (long-lived process, programmatic hooks via `@github/copilot-sdk`).

## Architecture

```
freefsm/
  copilot/                        ← NEW: Copilot CLI extension
    extension.mjs                 ← Extension entry point (ES module)
  skills/                         ← EXISTING: works on both Claude Code and Copilot CLI
    start/SKILL.md
    create/SKILL.md
    current/SKILL.md
    finish/SKILL.md
  hooks/                          ← EXISTING: Claude Code only
    hooks.json
  src/
    commands/
      install.ts                  ← MODIFIED: add "copilot" platform
    cli.ts                        ← MODIFIED: accept "copilot" in install command
  package.json                    ← MODIFIED: add "copilot/" to files array
```

### Data Flow

```
User invokes /freefsm:start
  → Copilot loads SKILL.md, agent calls `freefsm start` via Bash
  → Extension's onPostToolUse detects the command, stores activeRunId
  → Agent works (Bash, edit, create, etc.)
  → Every 5 tool calls, onPostToolUse injects state reminder via additionalContext
  → Agent calls `freefsm goto <state> --on <label>` via Bash
  → CLI validates transition (hard constraint), returns new state card
  → Eventually agent reaches `done` state, extension clears activeRunId
```

## Components

### 1. `copilot/extension.mjs`

A Copilot CLI extension using `@github/copilot-sdk/extension`.

#### Hooks

**`onPostToolUse`** — state reminder (core enforcement hook)

Logic (ported from `src/hooks/post-tool-use.ts`, adapted for in-memory model):

1. If `toolName === "bash"`:
   a. Detect `freefsm start` → extract `run_id` from command flags or tool result, store in `activeRunId`, reset counter to 0
   b. Detect `freefsm finish` or `freefsm goto done` → clear `activeRunId`, reset counter to 0
2. If no `activeRunId` → return (nothing to do)
3. Increment in-memory counter
4. If `counter % 5 !== 0` → return
5. Call `freefsm current --run-id <activeRunId> -j` via `execFile`
6. Parse JSON response, build state reminder text
7. Return `{ additionalContext: reminder }`

**`onSessionStart`** — cost optimization context injection (user-requested)

Copilot CLI charges per premium request (per model turn). The user explicitly requested strong emphasis on using `ask_user` with structured forms to minimize turn count. This is injected as `additionalContext`:

```
COPILOT COST OPTIMIZATION: Each model turn costs a premium request. When you
need user input, ALWAYS use the ask_user tool with requestedSchema (JSON Schema
forms with enum, boolean, array fields) instead of conversational back-and-forth.
Batch related questions into a single ask_user call when possible. Prefer
multiple-choice (enum) and boolean fields over open-ended string fields.
```

Session resume re-binding of `activeRunId` is out of scope (see Future Work). This hook only fires on fresh session start.

#### Differences from Claude Code Hook

| Aspect | Claude Code (`hooks.json`) | Copilot CLI (`extension.mjs`) |
|--------|---------------------------|-------------------------------|
| Process model | Stateless (new process per hook invocation) | Long-lived (extension process = session lifetime) |
| Counter storage | File (`sessions/<id>.counter`) | In-memory variable |
| Session binding | File (`sessions/<id>.json`) | In-memory `activeRunId` |
| Command detection | Parse `tool_input.command` from stdin JSON | Parse `input.toolArgs.command` from hook input |
| Output mechanism | Write JSON to stdout (`hookSpecificOutput`) | Return `{ additionalContext }` from hook |
| Hook types available | PostToolUse only | onPostToolUse, onPreToolUse, onSessionStart, onSessionEnd, onErrorOccurred, onUserPromptSubmitted |

#### No Native Tools Needed

The extension does NOT register custom tools (`fsm_start`, `fsm_goto`, etc.). Rationale:

- Existing skills already guide the agent to call `freefsm` via Bash
- The CLI performs transition validation internally (hard constraint)
- Registering duplicate tools would confuse the agent (Bash CLI vs native tool)
- This minimizes new code and keeps the extension as a pure hook layer

### 2. `freefsm install copilot`

New branch in `src/commands/install.ts` alongside existing `claude` and `codex` platforms.

#### Behavior

```bash
$ freefsm install copilot
Linking skills to ~/.copilot/skills/freefsm/
Linking extension to ~/.copilot/extensions/freefsm/

FreeFSM installed for Copilot CLI.

Skills: /freefsm:create, /freefsm:start, /freefsm:current, /freefsm:finish
Hook: PostToolUse state reminder (every 5 tool calls)

Restart Copilot CLI to activate.
```

#### Implementation

Creates two symlinks:

1. `~/.copilot/skills/freefsm/` → `<package-root>/skills/`
2. `~/.copilot/extensions/freefsm/` → `<package-root>/copilot/`

`<package-root>` is resolved from the running binary's location using the existing `getPackageRoot()` function (based on `import.meta.url`).

#### Edge Cases

| Scenario | Handling |
|----------|----------|
| `~/.copilot/` doesn't exist | `mkdirSync({ recursive: true })` |
| `~/.copilot/skills/` doesn't exist | `mkdirSync({ recursive: true })` |
| `~/.copilot/extensions/` doesn't exist | `mkdirSync({ recursive: true })` |
| Target is already a symlink | Remove old symlink, create new (matches `installCodex` behavior) |
| Target is a real directory | Backup to `.bak`, create symlink (matches `installCodex` behavior) |
| Package `skills/` missing | Error exit: "Skills directory not found" |
| Package `copilot/` missing | Error exit: "Copilot extension not found (upgrade freefsm?)" |
| freefsm running from source (not npm) | Works — `getPackageRoot()` uses file path, not npm metadata |

### 3. File Changes Summary

#### `copilot/extension.mjs` (new file)

~80-120 lines. Imports `@github/copilot-sdk`, `@github/copilot-sdk/extension`, `node:child_process`. Registers `onPostToolUse` and `onSessionStart` hooks. Zero dependencies beyond the SDK (auto-resolved by Copilot CLI runtime).

#### `src/commands/install.ts` (modify)

Add `installCopilot(packageRoot: string)` function (~30 lines) following the existing `installCodex` pattern. Two symlinks + directory creation + user output.

#### `src/cli.ts` (modify)

Change platform validation from `"claude" | "codex"` to `"claude" | "codex" | "copilot"`.

#### `package.json` (modify)

Add `"copilot/"` to the `files` array so it's included in the npm package.

## Testing Strategy

- **Unit tests**: Mock `execFile` to test `onPostToolUse` logic (command detection, counter, reminder generation)
- **Integration test**: `freefsm install copilot` creates correct symlinks on a temp directory
- **Manual verification**: Install on a Copilot CLI instance, run a workflow, verify state reminders appear

## Error Handling

- Extension hooks fail silently (return undefined) — hooks should never break the agent
- `execFile` errors (freefsm not found, run not found) are caught and ignored in hooks
- If `freefsm current` returns a non-active run (completed/aborted externally), clear `activeRunId` and reset counter
- Install command validates source directories exist before creating symlinks

## Future Work (Not in Scope)

- `onPreToolUse` hook for per-state tool restrictions (`allowed_tools` in YAML)
- Native tools as alternative to Bash CLI invocation
- Session resume detection (re-bind `activeRunId` on `onSessionStart` with `source: "resume"`)
- Configurable reminder interval via environment variable
