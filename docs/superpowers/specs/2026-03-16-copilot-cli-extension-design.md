# FreeFSM Copilot CLI Plugin Design

> Supersedes the earlier SDK-extension design. Copilot CLI support must be implemented as a real plugin (`plugin.json` + `hooks.json`), not as a standalone `extension.mjs` process.

## Problem

FreeFSM already works well with Claude Code because Claude exposes a hook model that can inject reminder text back into the agent loop. Our original Copilot design assumed Copilot CLI exposed an equivalent long-lived SDK extension process (`joinSession()`, `additionalContext`, `session.log()`), so we added `copilot/extension.mjs` and installed it via `~/.copilot/extensions`.

Live verification disproved that assumption:

- `copilot --help` and `copilot plugin --help` expose a **plugin** model, not an `extensions/` loading model.
- Official docs require a plugin to contain at least `plugin.json`, with hooks registered through `hooks.json`.
- Official hook docs state that `sessionStart`, `postToolUse`, and `userPromptSubmitted` outputs are ignored; only `preToolUse` can affect agent behavior by returning a deny decision.
- A/B probes showed that neither `~/.copilot/extensions/freefsm` nor `--plugin-dir <existing-copilot-dir>` causes `extension.mjs` to load.
- A minimal real-hook experiment showed the practical feedback boundary:
  - `postToolUse` hooks do run, but hook stdout does **not** appear in the agent transcript.
  - `preToolUse` deny reasons **do** appear in the transcript verbatim and are visible to the agent.
  - Real hook payloads include `sessionId`, even though the short docs examples omit it.

So the current Copilot implementation is architecturally invalid even though the TypeScript/JS is syntactically fine.

## Goals

1. Make Copilot CLI support real and supportable by following the documented plugin surface.
2. Preserve as much of the existing `freefsm` CLI and `skills/` content as possible.
3. Keep installation ergonomic (`freefsm install copilot`).
4. Replace the old soft “inject additionalContext every 5 tools” idea with a Copilot-native enforcement mechanism that still drives the agent back into the FSM.
5. Support automated, default-off e2e verification without touching the real `~/.copilot`.

## Non-Goals

- Preserving the `@github/copilot-sdk/extension` implementation model.
- Relying on undocumented `session.log()` capture behavior.
- Achieving perfect Claude parity for “silent reminder injection”; Copilot’s documented hooks do not support it.
- Building a design that depends solely on undocumented `sessionId` behavior. The implementation should prefer `sessionId` when present and fall back safely when it is absent.

## Proposed Approach

Implement Copilot support as a **plugin rooted at the package root**:

- Add `plugin.json` to the `freefsm/` package root.
- Add a Copilot-specific `copilot/skills/` directory with Copilot-compatible skill names, and point the plugin manifest at it explicitly.
- Add `copilot/hooks.json` that invokes compiled Node hook scripts from `dist/copilot-hooks/*.js`, and wire it explicitly from the manifest with `"hooks": "copilot/hooks.json"`.
- Move Copilot hook logic into TypeScript modules under `src/copilot-hooks/`, then compile them into `dist/`.
- Change `freefsm install copilot` to call `copilot plugin install <package-root>` instead of creating `~/.copilot/extensions` symlinks.

This keeps the package self-contained, lets Copilot manage plugin installation/caching the documented way, and gives us testable Node entrypoints instead of an opaque SDK-only runtime.

## Key Insight: Copilot Hooks Can Enforce, But Not Inject Context

Copilot’s documented hooks are shell-command based:

- `sessionStart`: runs command, ignores output
- `postToolUse`: runs command, ignores output
- `preToolUse`: runs command, can deny a tool execution via JSON output

That means the old design’s “return `{ additionalContext: reminder }` every 5 tool calls” is not available on the supported surface.

The approved replacement design is intentionally lightweight:

1. `preToolUse` is both the bookkeeping hook and the only agent-facing reminder channel.
2. Only `bash` and `view` are counted and denied; `edit`/`create` remain untouched to avoid expensive interruption.
3. Every 10th counted `bash`/`view` call, `preToolUse` runs `freefsm current` itself, compresses the result, denies only that triggering call, then immediately resets the counter.
4. There is **no unlock step**. The deny is a one-shot reminder, not a sticky gate.

This is weaker than a sticky enforcement loop, but it matches the user's priority: frequent reminders with minimal agent penalty.

## Architecture

```text
freefsm/
  plugin.json                    ← NEW: Copilot plugin manifest at package root
  skills/                        ← EXISTING: shared by Claude/Codex
    create/SKILL.md
    current/SKILL.md
    finish/SKILL.md
    start/SKILL.md
  copilot/
    skills/                      ← NEW: Copilot-only skill wrappers
      freefsm-create/SKILL.md
      freefsm-current/SKILL.md
      freefsm-finish/SKILL.md
      freefsm-start/SKILL.md
    hooks.json                   ← NEW: Copilot hook registration
  src/
    copilot-hooks/               ← NEW: TypeScript hook implementation
      bindings.ts                ← persisted session/workspace binding + gated-tool counter
      reminder.ts                ← formats state reminder from `freefsm current -j`
      parse.ts                   ← extracts run/root/command intent from tool args
      trace.ts                   ← default-off e2e trace file helper
      pre-tool-use.ts            ← optimistic bookkeeping + deny decision logic
    commands/
      install.ts                 ← MODIFIED: plugin install flow for Copilot
    __tests__/
      install.test.ts            ← MODIFIED: install command expectations
      copilot-hooks.test.ts      ← NEW: pure unit tests for hook logic
      copilot-e2e.test.ts        ← NEW/UPDATED: real Copilot plugin e2e
  dist/
    copilot-hooks/*.js           ← compiled hook entrypoints used by hooks.json
```

## Data Model

Because real hook payloads include `sessionId`, FreeFSM will persist Copilot tracking state **per session when available**, with a workspace-path fallback for safety.

### Binding file

Store a binding under `~/.copilot/state/freefsm/<session-id-or-cwd-hash>.json`:

```json
{
  "sessionId": "24967736-fe52-4634-8a00-40f309bcfe9b",
  "cwd": "/repo/path",
  "runId": "e2e-run",
  "rootDir": "/tmp/root",
  "gatedToolCount": 3,
  "updatedAt": "2026-03-16T12:34:56.000Z"
}
```

### Why this is acceptable

- Hooks run as separate processes, so in-memory state is impossible.
- Real `preToolUse` / `postToolUse` payloads include `sessionId`, which gives us proper per-session isolation.
- The workspace path is always present in hook payloads and provides a safe fallback key.
- FreeFSM already assumes a single “active run” in many agent flows.
- This is sufficient for the user’s main goal: a lightweight periodic reminder loop in normal single-session usage.

### Known limitation

If `sessionId` ever disappears from runtime payloads, the fallback `cwd` key could allow two Copilot sessions in the same repository to contend for the same binding file. Also, because the design no longer uses `postToolUse`, binding updates are optimistic: a failed `freefsm start` or `finish` command can temporarily leave stale state behind until the next `freefsm current` refresh clears it.

## Hook Flow

### `preToolUse`

Purpose:

- convert the old “periodic reminder” idea into a low-penalty Copilot-native one-shot reminder

Behavior:

1. Parse the incoming hook payload.
2. Load the session/workspace binding (if any) and perform lazy cleanup.
   - prefer `sessionId`
   - fall back to `cwd` only if needed
3. If the binding exists but a quick refresh shows the run is completed/aborted/missing, clear it before any other logic.
4. If the tool is `bash` running `freefsm start ... --run-id ... --root ...`, optimistically persist `{ sessionId, runId, rootDir, gatedToolCount: 0 }`, then allow.
5. If the tool is `bash` running `freefsm current`, `freefsm goto`, or `freefsm finish`, optimistically reset `gatedToolCount` to `0`, then allow.
6. If the tool is neither `bash` nor `view`, allow without touching the counter.
7. If there is no active binding, allow.
8. Increment `gatedToolCount`.
9. If `gatedToolCount < 10`, persist and allow.
10. On the 10th counted `bash`/`view` call:
   - run `freefsm current --run-id <runId> --root <rootDir> -j`
   - if the run is missing/completed/aborted, clear the binding and allow
   - otherwise compress the current state into a short reminder
   - deny only this triggering call
   - immediately reset `gatedToolCount` to `0`
11. If the refresh fails unexpectedly, deny with a very short fallback reminder and still reset the counter to `0`.

Example output:

```json
{
  "permissionDecision": "deny",
  "permissionDecisionReason": "[FSM plan] Plan the work. Next: next → done."
}
```

This gives the agent actionable context using the only supported feedback channel. The real experiment showed this deny reason is surfaced verbatim to the agent transcript, unlike `postToolUse` stdout. Because the hook already executed `freefsm current`, the deny does not require a follow-up unlock command.

## Installation Model

### `freefsm install copilot`

Replace the current symlink-based install with:

```bash
copilot plugin install <package-root>
```

Implementation details:

- resolve `<package-root>` with the existing `getPackageRoot()`
- validate `plugin.json`, `copilot/hooks.json`, and compiled hook entrypoints exist
- shell out to `copilot plugin install <package-root>`
- print a concise summary of what the plugin provides

Why this is better:

- uses Copilot’s documented installation path
- allows Copilot to manage cache/state
- avoids reverse-engineering internal directories like `~/.copilot/extensions`

## Skills Strategy

Existing `skills/` remain reusable for Claude/Codex. Copilot should instead load `copilot/skills/`, which provides compatible identifiers such as `/freefsm-start` and `/freefsm-current`.

Because session-start hook output is ignored, Copilot-specific cost guidance can no longer be injected dynamically. The first rework should therefore:

- keep the shared Claude/Codex skills unchanged unless testing proves they need tuning
- add a thin Copilot skill compatibility layer instead of forcing Claude/Codex naming conventions onto Copilot
- treat “Copilot-specific ask_user emphasis” as optional follow-up work, not part of the architectural repair

This keeps the rework focused on the broken compatibility layer first.

## Testing Strategy

### Unit tests

Add pure tests for the new hook helper modules:

- command parsing (`start`, `current`, `goto`, `finish`)
- real Copilot payload parsing where `toolArgs` arrives as a JSON string
- binding persistence and cleanup
- reminder formatting
- pre-tool deny decisions at threshold
- stale-run cleanup

### Install tests

Update `install.test.ts` to validate the new behavior:

- `freefsm install copilot` shells out to `copilot plugin install <package-root>`
- missing `plugin.json` / `hooks.json` / compiled hook scripts produce explicit errors

### E2E

Run the real `copilot` CLI with:

- temp `HOME`
- temp `--config-dir`
- low-cost model (`gpt-5-mini` by default)
- default-off trace env vars enabled only for the test

Validate:

- `freefsm install copilot` installs a plugin that appears in `copilot plugin list`
- hooks write trace markers when the test explicitly enables tracing
- `preToolUse` denial text is what the agent actually sees and reacts to
- a real run started outside Copilot plus a seeded `cwd` fallback binding with `gatedToolCount: 9` triggers a real one-shot deny on the first counted tool call, keeping the test bounded in time/cost
- `goto done → complete` succeeds in the same real session after the deny
- no real `~/.copilot` data is touched

The live “10 counted `bash`/`view` calls” cadence remains covered by unit tests; the bounded e2e focuses on validating the real Copilot transcript, hook execution, and end-to-end recovery path.

## Error Handling

- Hook scripts must fail open unless they are intentionally returning a deny decision.
- If a binding references a missing or completed run, clear it immediately.
- If reminder refresh/formatting fails, deny once with a short fallback reason, then reset the counter.
- Install must surface missing build artifacts explicitly instead of pretending Copilot support is available.

## Migration Notes

The existing `copilot/extension.mjs` implementation should be treated as obsolete once the plugin rework lands.

Migration path:

1. add the real plugin manifest + hook scripts
2. update install flow
3. update tests/e2e
4. delete or explicitly deprecate the old `copilot/extension.mjs` path so the repository does not appear to support both architectures

Do not try to support both architectures in parallel unless testing proves it is necessary.

## Future Work

- per-state tool allow/deny rules derived from workflow metadata
- Copilot-specific skill variants if shared skills prove insufficient
- stronger session identity if future hook payloads expose a stable session id
- nicer denial wording tuned for Copilot’s planner behavior
