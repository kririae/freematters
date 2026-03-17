# Copilot CLI Plugin Rework Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the invalid SDK-based Copilot compatibility layer with a documented Copilot plugin (`plugin.json` + `hooks.json` + Node hook scripts), then restore automated installation and e2e verification.

**Architecture:** The `freefsm/` package root becomes the Copilot plugin root, so the existing `skills/` directory can be reused directly. The approved hook design uses a single `preToolUse` hook: it tracks only `bash`/`view`, performs lazy stale-state cleanup, auto-runs `freefsm current` on every 10th counted call, denies only that triggering call with a compact reminder, then immediately resets the counter. `freefsm install copilot` shells out to `copilot plugin install <package-root>`.

**Tech Stack:** TypeScript, Node.js child processes/filesystem APIs, Copilot CLI plugin system, Vitest, real `copilot` prompt-mode e2e.

**Spec:** `docs/superpowers/specs/2026-03-16-copilot-cli-extension-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `freefsm/plugin.json` | Create | Copilot plugin manifest rooted at the package root |
| `freefsm/copilot/hooks.json` | Create | Register Copilot hook commands |
| `freefsm/copilot/extension.mjs` | Delete or deprecate | Remove the obsolete SDK-style Copilot implementation path |
| `freefsm/src/copilot-hooks/parse.ts` | Create | Parse bash commands and extract run/root metadata |
| `freefsm/src/copilot-hooks/bindings.ts` | Create | Persist session-scoped hook state under `~/.copilot/state/freefsm/`, preferring `sessionId` with `cwd` fallback |
| `freefsm/src/copilot-hooks/reminder.ts` | Create | Build deny/re-sync reminder text from `freefsm current -j` |
| `freefsm/src/copilot-hooks/trace.ts` | Create | Default-off e2e trace file helper |
| `freefsm/src/copilot-hooks/pre-tool-use.ts` | Create | Optimistic binding + one-shot deny for `bash`/`view` |
| `freefsm/src/commands/install.ts` | Modify | Switch Copilot install flow to `copilot plugin install <package-root>` |
| `freefsm/package.json` | Modify | Publish plugin manifest + Copilot hook assets |
| `freefsm/src/__tests__/install.test.ts` | Modify | Update install tests for plugin install behavior |
| `freefsm/src/__tests__/copilot-hooks.test.ts` | Create | Unit tests for hook helpers/entrypoints |
| `freefsm/src/__tests__/copilot-e2e.test.ts` | Modify | Real Copilot plugin e2e against temp HOME/config |
| `freefsm/vitest.integration.config.ts` | Modify | Include the Copilot e2e test and timeout budget |

## Chunk 1: Package the real Copilot plugin

### Task 1: Write failing tests for the new install surface

**Files:**
- Modify: `freefsm/src/__tests__/install.test.ts`
- Test: `freefsm/src/__tests__/install.test.ts`

- [ ] **Step 1: Add a failing Copilot install test for plugin installation**

Add a test that expects `install copilot` to invoke `copilot plugin install <package-root>` instead of creating `~/.copilot/extensions` symlinks.

The assertion should cover:
- the command name (`copilot`)
- the subcommand/args (`plugin install`)
- the exact local path passed to Copilot (`PACKAGE_ROOT`)
- a user-facing success string mentioning plugin installation

- [ ] **Step 2: Add failing tests for missing plugin assets**

Add tests that temporarily hide one asset at a time and expect explicit failures for:
- `freefsm/plugin.json`
- `freefsm/copilot/hooks.json`
- compiled hook entrypoints in `freefsm/dist/copilot-hooks/`

- [ ] **Step 3: Run the install test file to verify RED**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && \
npm run build && \
npx vitest run src/__tests__/install.test.ts
```

Expected: FAIL because the current implementation still symlinks `~/.copilot/extensions`.

### Task 2: Add plugin manifest and hook registration files

**Files:**
- Create: `freefsm/plugin.json`
- Create: `freefsm/copilot/hooks.json`
- Modify: `freefsm/package.json`

- [ ] **Step 1: Add `plugin.json` at the package root**

Create:

```json
{
  "name": "freefsm",
  "description": "Finite-state workflow tooling for GitHub Copilot CLI",
  "skills": "skills/",
  "hooks": "copilot/hooks.json"
}
```

Keep metadata minimal unless an existing package field is needed for clarity.

- [ ] **Step 2: Add `copilot/hooks.json`**

Register the compiled hook entrypoints:

```json
{
  "version": 1,
    "hooks": {
      "preToolUse": [
        { "type": "command", "bash": "node dist/copilot-hooks/pre-tool-use.js", "timeoutSec": 10 }
      ]
  }
}
```

- [ ] **Step 3: Publish the new plugin assets**

Update `freefsm/package.json` so the npm package includes:
- `plugin.json`
- `copilot/`
- compiled hook entrypoints in `dist/`

- [ ] **Step 4: Run `npm run build`**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm run build
```

Expected: build succeeds and leaves room for `dist/copilot-hooks/*.js` in the next chunk.

## Chunk 2: Implement hook logic with TDD

### Task 3: Add pure failing tests for hook logic

**Files:**
- Create: `freefsm/src/__tests__/copilot-hooks.test.ts`
- Test: `freefsm/src/__tests__/copilot-hooks.test.ts`

- [ ] **Step 1: Write a failing parse test**

Cover:
- `freefsm start ... --run-id e2e-run --root /tmp/root`
- `freefsm current`
- `freefsm goto done --on next`
- unrelated bash commands
- hook payload parsing with `sessionId`

- [ ] **Step 2: Write a failing binding persistence test**

Cover:
- save/load/remove binding
- `sessionId`-scoped isolation with `cwd` fallback
- `gatedToolCount` persistence
- stale-run cleanup when `freefsm current -j` reports missing/completed/aborted state

- [ ] **Step 3: Write a failing pre-tool deny test**

Cover:
- no binding → allow
- only `bash` and `view` are counted/gated
- `edit/create` are neither counted nor denied
- the 10th counted call triggers a deny with compact reminder text
- the deny is one-shot and immediately resets `gatedToolCount` to `0`
- `freefsm start/current/goto/finish` update bookkeeping optimistically in `preToolUse`
- reminder generation failure falls back to a short deny reason

- [ ] **Step 4: Run the new test file to verify RED**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && \
npm run build && \
npx vitest run src/__tests__/copilot-hooks.test.ts
```

Expected: FAIL because the hook helper modules do not exist yet.

### Task 4: Implement minimal hook helpers and entrypoints

**Files:**
- Create: `freefsm/src/copilot-hooks/parse.ts`
- Create: `freefsm/src/copilot-hooks/bindings.ts`
- Create: `freefsm/src/copilot-hooks/reminder.ts`
- Create: `freefsm/src/copilot-hooks/trace.ts`
- Create: `freefsm/src/copilot-hooks/pre-tool-use.ts`

- [ ] **Step 1: Implement `parse.ts`**

Add helpers to:
- parse stdin hook payloads
- decode `toolArgs` JSON strings
- identify relevant `freefsm` bash commands
- extract `runId` and `rootDir`
- extract `sessionId`, with a safe fallback key derived from `cwd`
- classify counted tools (`bash`/`view`) versus ignored tools

- [ ] **Step 2: Implement `bindings.ts`**

Persist binding files under `~/.copilot/state/freefsm/`, keyed by `sessionId` when present and by a stable hash of `cwd` otherwise.

State shape:

```ts
type CopilotBinding = {
  sessionId?: string;
  cwd: string;
  runId: string;
  rootDir: string;
  gatedToolCount: number;
  updatedAt: string;
};
```

- [ ] **Step 3: Implement `reminder.ts`**

Call:

```bash
freefsm current --run-id <runId> --root <rootDir> -j
```

Then build a compact deny message from the JSON payload:
- state name
- one-line prompt
- short transition summary

Do not include full todos unless the prompt cannot be meaningfully compressed.

- [ ] **Step 4: Implement `trace.ts`**

Support:
- `FREEFSM_COPILOT_E2E_TRACE=1`
- `FREEFSM_COPILOT_E2E_TRACE_FILE=<path>`

Trace markers should be file-based, not `session.log()`-based.

- [ ] **Step 5: Implement `pre-tool-use.ts`**

Return compact JSON only when denying:

```json
{
  "permissionDecision": "deny",
  "permissionDecisionReason": "..."
}
```

All non-deny paths should write nothing and exit `0`.

Behavior requirements:
- only count `bash` and `view`
- ignore `edit/create` entirely for reminder cadence
- perform lazy stale-state cleanup inside `preToolUse`
- optimistically bind `runId`/`rootDir` on `freefsm start`
- optimistically reset `gatedToolCount` on `freefsm current/goto/finish`
- on the 10th counted call, run `freefsm current` yourself, deny only that call, and immediately reset `gatedToolCount`
- if the active run is missing/completed/aborted, clear binding and allow
- if reminder generation fails unexpectedly, deny once with a short fallback reason and reset the counter

- [ ] **Step 6: Run the hook unit tests to verify GREEN**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && \
npm run build && \
npx vitest run src/__tests__/copilot-hooks.test.ts
```

Expected: PASS.

## Chunk 3: Wire install flow and restore e2e

### Task 5: Replace the Copilot install implementation

**Files:**
- Modify: `freefsm/src/commands/install.ts`
- Test: `freefsm/src/__tests__/install.test.ts`

- [ ] **Step 1: Update `install.ts` to validate plugin assets**

Before invoking Copilot, validate:
- `plugin.json`
- `copilot/hooks.json`
- built hook entrypoints under `dist/copilot-hooks/`

- [ ] **Step 2: Replace symlink creation with plugin install**

Use:

```ts
execFileSync("copilot", ["plugin", "install", packageRoot], { stdio: "inherit" });
```

Keep failure messages explicit and user-oriented.

- [ ] **Step 3: Update success output**

Report:
- plugin installed
- Copilot-compatible skills are provided through `copilot/skills`
- hooks now enforce workflow re-sync through Copilot’s plugin system

- [ ] **Step 4: Run the install tests to verify GREEN**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && \
npm run build && \
npx vitest run src/__tests__/install.test.ts
```

Expected: PASS.

### Task 5b: Remove the obsolete SDK-extension path

**Files:**
- Modify or Delete: `freefsm/copilot/extension.mjs`

- [ ] **Step 1: Remove or clearly deprecate `copilot/extension.mjs`**

Choose one:
- delete the file outright once no code/tests reference it, or
- replace it with a short deprecation note if packaging/layout still requires the path temporarily

Do not leave the repository appearing to support both the plugin and SDK-extension architectures.

- [ ] **Step 2: Run a focused search to confirm no active references remain**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && \
rg "extension\\.mjs|@github/copilot-sdk|joinSession" .
```

Expected: only intentional deprecation text remains, or no matches at all outside historical docs/tests.

### Task 6: Update the Copilot e2e harness

**Files:**
- Modify: `freefsm/src/__tests__/copilot-e2e.test.ts`
- Modify: `freefsm/vitest.integration.config.ts`

- [ ] **Step 1: Rewrite the e2e expectations around plugins, not extensions**

The test should:
- create temp `HOME` and temp `--config-dir`
- call `node dist/cli.js install copilot`
- confirm `copilot plugin list` shows `freefsm`

- [ ] **Step 2: Keep default-off trace gating**

Pass:

```bash
FREEFSM_COPILOT_E2E_TRACE=1
FREEFSM_COPILOT_E2E_TRACE_FILE=<tmp-file>
FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini
```

Only the e2e test should opt into those trace env vars; production installs stay default-off.

- [ ] **Step 3: Make the prompt resilient to denial-based enforcement**

Instruct Copilot:
- run numbered bash steps separately
- if a tool call is denied with an FSM reminder, treat it as a one-shot reminder and continue/retry as needed
- end with exactly `DONE`

To keep runtime bounded, start a real run outside Copilot, seed a `cwd` fallback binding with
`gatedToolCount: 9`, and then let the first counted Copilot bash call trigger the real deny path.
The “10 counted calls” cadence itself stays covered by unit tests.

- [ ] **Step 4: Assert real plugin hook behavior**

Require:
- trace file exists
- trace contains a denial/reminder marker
- trace contains reminder firing and reset markers for the bounded seeded path
- combined output shows the pre-tool deny reason reaching the agent transcript
- combined output does **not** rely on post-hook stdout visibility
- workflow snapshot reaches `"run_status":"completed"`

- [ ] **Step 5: Run targeted RED/GREEN cycle**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && \
npm run build && \
FREEFSM_RUN_COPILOT_E2E=1 FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini \
npx vitest run --config vitest.integration.config.ts src/__tests__/copilot-e2e.test.ts
```

Expected: PASS after the hook rework lands.

## Chunk 4: Broad verification and handoff

### Task 7: Run the full package verification

**Files:**
- Modify: none

- [ ] **Step 1: Run build + tests + check**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && \
npm run build && \
npm test && \
npm run check
```

Expected:
- all default tests pass
- Copilot e2e remains skipped unless explicitly enabled
- no lint/format drift remains

- [ ] **Step 2: Re-run the targeted Copilot e2e**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && \
FREEFSM_RUN_COPILOT_E2E=1 FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini \
npx vitest run --config vitest.integration.config.ts src/__tests__/copilot-e2e.test.ts
```

Expected: PASS with the cheap model.

### Task 8: Commit and push

**Files:**
- Modify: all of the above

- [ ] **Step 1: Commit the plugin rework**

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev && \
git add freefsm && \
git commit -m "feat(freefsm): rework Copilot support as a real plugin

Replaces the invalid SDK-based extension approach with a documented
Copilot plugin built from plugin.json, hooks.json, and Node hook scripts.

Updates install flow, hook tests, and automated e2e coverage accordingly.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 2: Push the updated branch**

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev && \
git push fork copilot-cli-extension-e2e-dev
```

Expected: push succeeds to the user’s fork.

Plan complete and saved to `docs/superpowers/plans/2026-03-16-copilot-cli-plugin-rework.md`. Ready to execute?
