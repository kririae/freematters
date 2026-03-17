# Copilot Plugin Chain Alignment Design

## Problem

The current Copilot integration works, but its packaging and runtime chain diverge more than necessary from the Claude path.

The user wants Copilot to look and feel more like the Claude integration:

- use a dedicated plugin wrapper directory, similar in spirit to `.claude-plugin`
- keep skills driving the `freefsm` CLI instead of bypassing it
- route hook entry through `freefsm _hook ...` rather than directly executing an implementation file
- keep platform differences as narrow and explicit as possible

At the same time, the user does **not** want Copilot-specific packaging files such as `plugin.json` living at the package root.

## Goals

1. Make the Copilot packaging chain resemble the Claude packaging chain as closely as Copilot allows.
2. Keep the runtime call chain aligned: platform hook config → `freefsm _hook ...` → hook module.
3. Keep `freefsm` CLI as the stable runtime surface used by both skills and hooks.
4. Move Copilot packaging concerns out of the package root and into a dedicated wrapper directory.
5. Preserve the already-approved `preToolUse` hook model for Copilot.

## Non-Goals

- Replacing the current Copilot `preToolUse` reminder behavior.
- Solving the final Copilot slash-command UX in this step; the user will continue validating the exact UI exposure separately.
- Removing the need for Copilot-specific skills entirely.
- Making Copilot identical to Claude at the protocol level; only the architecture and call chain are being aligned.

## Key Findings

### 1. Copilot plugin paths cannot escape the plugin directory

Directly pointing plugin metadata at `../skills` or `../hooks.json` does not work. Copilot rejects such paths as escaping the plugin directory.

### 2. Symlinks inside the plugin directory do work

A plugin directory can contain symlinks such as:

- `skills -> ../copilot/skills`
- `hooks.json -> ../copilot/hooks.json`

and Copilot can successfully install and load the plugin through that wrapper.

### 3. npm packaging does not preserve symlinks reliably enough for this design

Symlinks survive ordinary filesystem and tar behavior, but they do **not** survive `npm pack` / `npm install` as package contents in the required way.

This means the symlinks needed by `.copilot-plugin` must be created or refreshed locally by `freefsm install copilot`, rather than being assumed to ship intact through npm packaging.

## Chosen Approach

Use a **thin `.copilot-plugin` wrapper directory** that mirrors the role of `.claude-plugin`, while letting `freefsm install copilot` create or refresh the required local symlinks before calling `copilot plugin install`.

### Why this approach

- It satisfies the user’s requirement that Copilot packaging should not be rooted at the package root.
- It keeps packaging concerns in a dedicated directory, like Claude.
- It keeps Copilot-specific differences concentrated in the wrapper layer and the hook type.
- It avoids a heavier self-contained duplication of the entire plugin payload inside `.copilot-plugin`.

## Architecture

The target Copilot chain is:

```text
freefsm install copilot
  -> prepare .copilot-plugin wrapper
  -> copilot plugin install <packageRoot>/.copilot-plugin
  -> Copilot loads plugin.json from .copilot-plugin
  -> .copilot-plugin/skills (symlink) exposes Copilot skills
  -> .copilot-plugin/hooks.json (symlink) exposes Copilot hooks
  -> Copilot skill invokes freefsm CLI
  -> Copilot preToolUse hook invokes freefsm _hook pre-tool-use
  -> freefsm CLI dispatches to src/copilot-hooks/pre-tool-use.ts
```

This intentionally mirrors the Claude structure:

```text
freefsm install claude
  -> Claude marketplace/plugin install
  -> Claude loads .claude-plugin metadata
  -> Claude skill invokes freefsm CLI
  -> Claude PostToolUse hook invokes freefsm _hook post-tool-use
  -> freefsm CLI dispatches to src/hooks/post-tool-use.ts
```

## File Layout

### Canonical runtime and content

These remain outside the wrapper directory:

- `freefsm/skills/*`
- `freefsm/copilot/skills/*`
- `freefsm/hooks/hooks.json` (Claude)
- `freefsm/copilot/hooks.json` (Copilot)
- `freefsm/src/hooks/post-tool-use.ts`
- `freefsm/src/copilot-hooks/pre-tool-use.ts`

### Copilot wrapper

Introduce:

- `freefsm/.copilot-plugin/plugin.json`

Runtime-created local symlinks:

- `freefsm/.copilot-plugin/skills -> ../copilot/skills`
- `freefsm/.copilot-plugin/hooks.json -> ../copilot/hooks.json`

The wrapper directory should stay thin. It exists to satisfy Copilot’s plugin-root expectations, not to duplicate runtime logic.

### Wrapper manifest contract

`.copilot-plugin/plugin.json` must be fully wrapper-local:

- `"skills": ["skills"]`
- `"hooks": "hooks.json"`

It must not point outside the wrapper using `../...` paths, because Copilot rejects paths that escape the plugin directory.

### Published package contract

The published package must include `.copilot-plugin/plugin.json`, because `freefsm install copilot` will install from the packaged filesystem layout and then create the wrapper symlinks locally.

## Install Design

### `freefsm install copilot`

`freefsm install copilot` should:

1. Resolve the package root.
2. Ensure `.copilot-plugin/` exists.
3. Create or refresh these symlinks:
   - `.copilot-plugin/skills -> ../copilot/skills`
   - `.copilot-plugin/hooks.json -> ../copilot/hooks.json`
4. Invoke:

```bash
copilot plugin install <packageRoot>/.copilot-plugin
```

### Install behavior boundaries

- The install command may create or refresh the symlinks required by the wrapper.
- The install command should reuse the existing safe link-replacement behavior already used elsewhere in FreeFSM install logic:
  - replace correct or broken symlinks in place
  - back up conflicting regular files or directories before replacing them
  - recreate wrong-target symlinks so the wrapper always points at the intended paths
- If required wrapper targets are missing, install should fail explicitly rather than silently proceeding with a broken wrapper.
- If the local platform cannot create the required links, install should fail explicitly with a clear platform error instead of falling back to a different packaging shape in this step.
- It should otherwise stay thin and avoid large amounts of Copilot-specific preflight logic.
- It should not move Copilot packaging metadata back to the package root.

## Hook Entry Design

Copilot should no longer execute a hook implementation file directly as the primary runtime entrypoint.

Instead:

- `.copilot-plugin/hooks.json` should use Copilot’s command-hook schema and point to `freefsm _hook pre-tool-use`
- `freefsm` CLI should expose a hidden `_hook pre-tool-use` subcommand
- that subcommand should delegate into the Copilot hook implementation module

More concretely, the Copilot hook config should remain Copilot-native while standardizing the runtime entry:

- `bash: "freefsm _hook pre-tool-use"`
- `powershell: "freefsm _hook pre-tool-use"`

The design goal is to forbid the older direct-entry style such as `node ./dist/copilot-hooks/pre-tool-use.js` as the installed hook command.

This makes the hook entry structure match Claude’s established pattern:

- Claude: `freefsm _hook post-tool-use`
- Copilot: `freefsm _hook pre-tool-use`

## Skill Design Boundary

Copilot skills should continue to:

- invoke `freefsm` CLI commands
- rely on the same CLI semantics as other platforms

They should **not** bypass the CLI by importing or executing internal implementation files directly.

This preserves `freefsm` CLI as the common operational surface.

## Platform Differences That Remain Acceptable

The remaining intentional platform differences are:

1. **Plugin protocol**
   - Claude uses Claude’s marketplace/plugin structure
   - Copilot uses Copilot’s plugin install structure

2. **Hook type**
   - Claude uses `PostToolUse`
   - Copilot uses `preToolUse`

3. **Skill naming/exposure**
   - Copilot follows Copilot’s skill naming and exposure rules
   - the exact final user-facing slash UX remains out of scope for this step because the user is still validating that behavior separately

These are platform-imposed differences, not FreeFSM design differences.

## Testing Design

### 1. Wrapper install test

Add or update tests to prove:

- `.copilot-plugin` can be used as the plugin install target
- the symlinks created by `freefsm install copilot` point to the intended targets
- re-running install refreshes the wrapper safely
- conflicting existing files/directories are handled by the documented replacement/back-up behavior
- the packaged filesystem includes `.copilot-plugin/plugin.json`

### 2. Hook entry test

Add or update tests to prove:

- Copilot hook configuration invokes `freefsm _hook pre-tool-use`
- the CLI hidden hook path dispatches into the Copilot pre-tool-use handler correctly

### 3. Copilot e2e

Keep real Copilot e2e coverage and ensure it still proves:

- plugin install succeeds through `.copilot-plugin`
- Copilot loads the skills successfully
- the preToolUse reminder path still works

### 4. Regression boundary

The implementation should not:

- reintroduce root-level Copilot `plugin.json`
- bypass `freefsm` CLI for Copilot skills or hooks
- duplicate the full Copilot payload into `.copilot-plugin`

## Acceptance Criteria

This design is successfully implemented when:

1. Copilot packaging metadata is rooted at `.copilot-plugin`, not the package root.
2. `freefsm install copilot` installs `.copilot-plugin`.
3. `freefsm install copilot` creates or refreshes the symlinks required by `.copilot-plugin`.
4. Copilot skills are loaded through `.copilot-plugin/skills`.
5. Copilot hooks are loaded through `.copilot-plugin/hooks.json`.
6. `.copilot-plugin/plugin.json` uses wrapper-local manifest paths (`skills`, `hooks.json`) and the published package contains that manifest.
7. Copilot hook runtime entry is `freefsm _hook pre-tool-use`, expressed through Copilot’s native `bash` / `powershell` hook fields.
7. Copilot skills still drive the `freefsm` CLI rather than bypassing it.
8. Real Copilot e2e still passes after the wrapper migration.

## Risks and Mitigations

### Risk: wrapper symlink logic becomes brittle

Mitigation:

- keep symlink creation limited to install
- test reinstall/update behavior explicitly

### Risk: install grows into another large Copilot-specific branch

Mitigation:

- limit install work to wrapper preparation plus plugin installation
- avoid adding unnecessary validation and policy logic

### Risk: hook entry becomes split between CLI and direct script paths

Mitigation:

- standardize on `freefsm _hook pre-tool-use` as the runtime entry
- treat direct implementation-file execution as a regression from the desired chain
