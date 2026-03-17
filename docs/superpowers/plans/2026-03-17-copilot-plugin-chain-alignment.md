# Copilot Plugin Chain Alignment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Copilot integration to a thin `.copilot-plugin` wrapper that installs via `freefsm install copilot`, keeps skills and hooks routed through the `freefsm` CLI, and aligns the Copilot call chain with Claude as closely as the platform allows.

**Architecture:** Keep runtime logic in the existing `freefsm` package, but move Copilot packaging metadata into `.copilot-plugin/`. During `install copilot`, create or refresh wrapper-local symlinks to `copilot/skills` and `copilot/hooks.json`, then install the wrapper. Standardize Copilot hook execution on `freefsm _hook pre-tool-use` so both Claude and Copilot enter hooks through hidden CLI subcommands.

**Tech Stack:** TypeScript, Commander, Vitest, GitHub Copilot CLI plugin hooks, Node.js filesystem/symlink APIs

---

## File Structure

### New files

- `freefsm/.copilot-plugin/plugin.json` — Copilot wrapper manifest with only wrapper-local paths (`skills`, `hooks.json`)

### Modified files

- `freefsm/package.json` — publish `.copilot-plugin/plugin.json`; stop publishing the old root-level Copilot manifest
- `freefsm/src/commands/install.ts` — switch Copilot install target to `.copilot-plugin`, create/refresh wrapper symlinks, reuse safe link replacement behavior
- `freefsm/src/cli.ts` — add hidden `_hook pre-tool-use` dispatch path alongside the existing Claude hook path
- `freefsm/copilot/hooks.json` — change Copilot hook commands to `freefsm _hook pre-tool-use`
- `freefsm/src/__tests__/copilot-plugin-compat.test.ts` — assert wrapper-local manifest expectations and packaged file layout
- `freefsm/src/__tests__/copilot-e2e.test.ts` — install `.copilot-plugin` and verify the CLI hook entry path still works end-to-end
- `freefsm/README.md` — update Copilot install description and command examples to match the wrapper design

### Removed files

- `freefsm/plugin.json` — old root-level Copilot manifest; packaging should no longer depend on it

### Existing files reused as-is

- `freefsm/copilot/skills/*` — existing Copilot skill copies remain the Copilot skill payload
- `freefsm/src/copilot-hooks/pre-tool-use.ts` — core Copilot pre-tool-use logic stays in this module

---

## Chunk 1: Wrapper Packaging and Install Path

### Task 1: Lock wrapper-manifest expectations with tests

**Files:**
- Modify: `freefsm/src/__tests__/copilot-plugin-compat.test.ts`
- Modify: `freefsm/package.json`
- Reference: `freefsm/package.json`, `freefsm/plugin.json`, `freefsm/copilot/hooks.json`

- [ ] **Step 1: Write a failing test for wrapper-local manifest expectations**

Add assertions that the Copilot manifest lives at `.copilot-plugin/plugin.json`, contains:

```json
{
  "name": "freefsm",
  "skills": ["skills"],
  "hooks": "hooks.json"
}
```

and that the package publish list includes `.copilot-plugin/` instead of the old root `plugin.json`.

Also add a packaged-filesystem assertion that verifies an `npm pack` tarball contains `.copilot-plugin/plugin.json`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm test -- src/__tests__/copilot-plugin-compat.test.ts
```

Expected: FAIL because the current manifest is still rooted at `freefsm/plugin.json` and package publishing still reflects the old layout.

- [ ] **Step 3: Add the new wrapper manifest**

Create `freefsm/.copilot-plugin/plugin.json` with wrapper-local paths only:

```json
{
  "name": "freefsm",
  "description": "CLI-first FSM runtime for agent workflows",
  "skills": ["skills"],
  "hooks": "hooks.json"
}
```

Remove `freefsm/plugin.json` from the active Copilot install path and update `freefsm/package.json` so the published package contains `.copilot-plugin/`.

- [ ] **Step 4: Re-run the focused compatibility test**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm test -- src/__tests__/copilot-plugin-compat.test.ts
```

Expected: PASS on the wrapper-manifest assertions.

- [ ] **Step 5: Run the packaged-filesystem verification**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm pack
```

Expected: the produced tarball contains `.copilot-plugin/plugin.json` and no longer relies on a root-level Copilot manifest.

- [ ] **Step 6: Commit the wrapper-manifest change**

```bash
git add freefsm/.copilot-plugin/plugin.json freefsm/package.json freefsm/src/__tests__/copilot-plugin-compat.test.ts freefsm/plugin.json
git commit -m "refactor: move Copilot manifest into wrapper"
```

### Task 2: Make `install copilot` create/refresh wrapper symlinks

**Files:**
- Modify: `freefsm/src/commands/install.ts`
- Modify: `freefsm/src/__tests__/install.test.ts`
- Modify: `freefsm/src/__tests__/copilot-plugin-compat.test.ts`
- Reference: `freefsm/src/__tests__/install.test.ts` for existing link-replacement patterns

- [ ] **Step 1: Write failing tests for symlink creation and refresh**

Add tests that call `install("copilot", packageRoot)` and assert:

- `.copilot-plugin/skills` points to `../copilot/skills`
- `.copilot-plugin/hooks.json` points to `../copilot/hooks.json`
- re-install replaces wrong-target or broken symlinks
- conflicting regular files/directories are backed up before replacement
- `install("copilot", packageRoot)` invokes `copilot plugin install <packageRoot>/.copilot-plugin`

Keep wrapper-manifest/package-layout ownership in `copilot-plugin-compat.test.ts`, but move install-path and symlink-refresh ownership into `install.test.ts`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm run test:integration -- src/__tests__/install.test.ts
```

Expected: FAIL because the current install path targets the package root and does not prepare `.copilot-plugin`.

- [ ] **Step 3: Implement minimal wrapper preparation in `install.ts`**

Add a Copilot-specific helper that:

- resolves `.copilot-plugin`
- ensures the wrapper directory exists
- reuses the existing safe link-replacement behavior to create/refresh:

```text
.copilot-plugin/skills -> ../copilot/skills
.copilot-plugin/hooks.json -> ../copilot/hooks.json
```

- fails explicitly if `copilot/skills` or `copilot/hooks.json` is missing
- invokes:

```bash
copilot plugin install <packageRoot>/.copilot-plugin
```

- [ ] **Step 4: Re-run the focused test**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm run test:integration -- src/__tests__/install.test.ts
```

Expected: PASS on install-target and symlink-refresh assertions.

- [ ] **Step 5: Commit the install-wrapper change**

```bash
git add freefsm/src/commands/install.ts freefsm/src/__tests__/install.test.ts freefsm/src/__tests__/copilot-plugin-compat.test.ts
git commit -m "refactor: install Copilot through wrapper symlinks"
```

## Chunk 2: CLI Hook Entry, E2E, and Docs

### Task 3: Route Copilot hooks through `freefsm _hook pre-tool-use`

**Files:**
- Modify: `freefsm/src/cli.ts`
- Modify: `freefsm/copilot/hooks.json`
- Modify: `freefsm/src/__tests__/copilot-plugin-compat.test.ts`
- Modify: `freefsm/src/__tests__/copilot-hooks.test.ts`
- Modify: `freefsm/src/__tests__/integration.test.ts`
- Reference: `freefsm/src/hooks/post-tool-use.ts`, `freefsm/src/copilot-hooks/pre-tool-use.ts`

- [ ] **Step 1: Write failing tests for CLI hook dispatch**

Add tests that assert:

- Copilot `hooks.json` uses command-hook fields with:

```json
{
  "bash": "freefsm _hook pre-tool-use",
  "powershell": "freefsm _hook pre-tool-use"
}
```

- the CLI exposes a hidden `_hook pre-tool-use` path that reaches the Copilot pre-tool-use handler
- Commander registration is actually wired, not just the underlying module tests

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm test -- src/__tests__/copilot-plugin-compat.test.ts src/__tests__/copilot-hooks.test.ts src/__tests__/integration.test.ts
```

Expected: FAIL because the current Copilot hooks still target the direct `dist/copilot-hooks/pre-tool-use.js` entrypoint and the CLI lacks the hidden pre-tool-use subcommand.

- [ ] **Step 3: Implement the CLI hook entry**

Update `freefsm/src/cli.ts` so hidden hook commands support both:

```text
freefsm _hook post-tool-use
freefsm _hook pre-tool-use
```

and make `freefsm/copilot/hooks.json` invoke the new CLI path instead of `node ./dist/copilot-hooks/pre-tool-use.js`.

- [ ] **Step 4: Re-run the focused tests**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm test -- src/__tests__/copilot-plugin-compat.test.ts src/__tests__/copilot-hooks.test.ts src/__tests__/integration.test.ts
```

Expected: PASS with the new CLI-based hook entry path.

- [ ] **Step 5: Commit the hook-entry unification**

```bash
git add freefsm/src/cli.ts freefsm/copilot/hooks.json freefsm/src/__tests__/copilot-plugin-compat.test.ts freefsm/src/__tests__/copilot-hooks.test.ts freefsm/src/__tests__/integration.test.ts
git commit -m "refactor: route Copilot hook through freefsm CLI"
```

### Task 4: Update real e2e and user-facing docs

**Files:**
- Modify: `freefsm/src/__tests__/copilot-e2e.test.ts`
- Modify: `freefsm/README.md`

- [ ] **Step 1: Write or tighten failing assertions for wrapper installation**

Update the real Copilot e2e to assert:

- installation goes through `.copilot-plugin`
- the loaded plugin still exposes the expected Copilot skills
- the preToolUse reminder still fires after the wrapper migration

Add an explicit README checklist:

- Copilot install target is described as `.copilot-plugin`
- Copilot hook entry is described through `freefsm _hook pre-tool-use`, not a direct JS file
- Copilot packaging metadata is not described as rooted at `freefsm/plugin.json`

- [ ] **Step 2: Run the e2e test to confirm the current path is stale**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && FREEFSM_RUN_COPILOT_E2E=1 FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini npm run test:integration -- src/__tests__/copilot-e2e.test.ts
```

Expected: FAIL or assert stale expectations until the wrapper-based install path is reflected.

- [ ] **Step 3: Update the e2e and README**

Adjust:

- `src/__tests__/copilot-e2e.test.ts` to install `.copilot-plugin` and preserve the existing runtime reminder checks
- `README.md` to describe the new packaging model succinctly

Do not broaden scope into slash-command UX promises; keep docs to the verified wrapper/install/runtime chain.

- [ ] **Step 4: Run the full verification suite**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm run build && npm test && npm run check && npm test && FREEFSM_RUN_COPILOT_E2E=1 FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini npm run test:integration -- src/__tests__/copilot-e2e.test.ts
```

Expected:

- `tsc` succeeds
- unit tests pass
- Biome check passes
- the post-check unit test rerun is still green in case `npm run check` rewrites files
- real Copilot e2e passes through `.copilot-plugin`

- [ ] **Step 5: Commit the verification and docs update**

```bash
git add freefsm/src/__tests__/copilot-e2e.test.ts freefsm/README.md
git commit -m "test: verify Copilot wrapper chain end to end"
```

### Task 5: Final branch verification

**Files:**
- Modify: none
- Verify: the full working tree

- [ ] **Step 1: Inspect the final diff**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev && git --no-pager diff --stat main...HEAD
```

Expected: only the wrapper-migration, CLI hook-entry, test, and docs files described above.

- [ ] **Step 2: Re-run final smoke verification**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev/freefsm && npm run build && npm test && npm run check && npm test && FREEFSM_RUN_COPILOT_E2E=1 FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini npm run test:integration -- src/__tests__/copilot-e2e.test.ts
```

Expected: PASS with no new regressions, including the wrapper/hook/e2e gates.

- [ ] **Step 3: Confirm no verification-generated edits remain**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev && git status --short
```

Expected: no unexpected edits caused by `npm run check` or test fixtures.

- [ ] **Step 4: Push the branch**

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev && git push fork HEAD
```

- [ ] **Step 5: Record the resulting head commit for handoff**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension-e2e-dev && git rev-parse HEAD
```

Expected: a single commit SHA ready for the next implementation handoff or review step.
