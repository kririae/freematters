# Copilot CLI E2E Automation Implementation Plan

> Superseded by `docs/superpowers/plans/2026-03-16-copilot-cli-plugin-rework.md`. This plan relies on `extension.mjs`/`session.log()` observability assumptions that do not hold on Copilot's documented plugin surface.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fully automated, default-off Copilot CLI end-to-end test for `freefsm` that uses a low-cost model, a temporary Copilot config directory, and env-gated trace logging to validate hook behavior without manual interaction.

**Architecture:** The test harness will run the real `copilot` CLI in non-interactive prompt mode against a temporary `HOME`/`--config-dir`, so installation and extension discovery are exercised exactly as users run them. Because `additionalContext` is hidden from the transcript, `freefsm/copilot/extension.mjs` will gain default-off, env-gated `session.log()` trace markers that expose session-start, run binding, reminder firing, and unbinding during e2e runs without affecting normal users.

**Tech Stack:** TypeScript, Vitest, Node.js child processes/filesystem APIs, Copilot CLI prompt mode, `session.log()` from `@github/copilot-sdk`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `freefsm/copilot/extension.mjs` | Modify | Add default-off env-gated trace logging for automated Copilot e2e observation |
| `freefsm/src/__tests__/copilot-e2e.test.ts` | Create | Real Copilot CLI e2e harness using temp HOME/config-dir/PATH and trace assertions |
| `freefsm/vitest.integration.config.ts` | Modify | Include the Copilot e2e test in the existing integration test config |

## Chunk 1: Automated Copilot CLI E2E

### Task 1: Add the failing Copilot e2e harness

**Files:**
- Create: `freefsm/src/__tests__/copilot-e2e.test.ts`
- Modify: `freefsm/vitest.integration.config.ts`

- [ ] **Step 1: Verify the local Copilot CLI automation flags**

Run:

```bash
copilot --help | rg 'config-dir|allow-all|output-format|log-dir|share|prompt|model'
```

Expected: local help confirms these exact flags exist:
- `--config-dir`
- `--allow-all`
- `--output-format`
- `--log-dir`
- `--share`
- `-p, --prompt`
- `--model`

- [ ] **Step 2: Write the failing e2e test file**

Create `src/__tests__/copilot-e2e.test.ts` with:

**Important implementation note:** `extensions.md` in the local Copilot SDK docs states that `@github/copilot-sdk` imports are auto-resolved for loaded extensions. The temporary probe extension written under the temp Copilot config directory is therefore allowed to import `@github/copilot-sdk` and `@github/copilot-sdk/extension` without its own `node_modules`.

```ts
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI = resolve(__dirname, "../../dist/cli.js");
const COPILOT_E2E_ENABLED = process.env.FREEFSM_RUN_COPILOT_E2E === "1";
const COPILOT_E2E_MODEL = process.env.FREEFSM_COPILOT_E2E_MODEL ?? "gpt-5-mini";

const WORKFLOW = `\
version: 1
guide: "Copilot e2e workflow"
initial: plan
states:
  plan:
    prompt: "Plan the work."
    transitions:
      next: done
  done:
    prompt: "Finished."
    transitions: {}
`;

function hasCommand(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const describeCopilotE2E = describe.skipIf(!hasCommand("copilot") || !COPILOT_E2E_ENABLED);

function writeFreefsmWrapper(binDir: string): void {
  const wrapper = join(binDir, "freefsm");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\nnode "${CLI}" "$@"\n`,
    "utf-8",
  );
  chmodSync(wrapper, 0o755);
}

function writeProbeExtension(extensionsDir: string): void {
  const probeDir = join(extensionsDir, "probe");
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(
    join(probeDir, "extension.mjs"),
    `
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

const session = await joinSession({
  onPermissionRequest: approveAll,
  hooks: {
    onSessionStart: async () => {
      await session.log("FREEFSM_E2E_PROBE session-start");
    },
  },
  tools: [],
});
`.trimStart(),
    "utf-8",
  );
}

function readArtifacts(sharePath: string, logDir: string): string {
  const parts: string[] = [];
  if (existsSync(sharePath)) {
    parts.push(readFileSync(sharePath, "utf-8"));
  }
  if (existsSync(logDir)) {
    for (const name of readdirSync(logDir)) {
      parts.push(readFileSync(join(logDir, name), "utf-8"));
    }
  }
  return parts.join("\n---\n");
}

describeCopilotE2E("copilot e2e", () => {
  let tmp: string;
  let fakeHome: string;
  let configDir: string;
  let workspace: string;
  let binDir: string;
  let rootDir: string;
  let fsmPath: string;
  let sharePath: string;
  let logDir: string;
  let extensionsDir: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "freefsm-copilot-e2e-"));
    fakeHome = join(tmp, "home");
    configDir = join(fakeHome, ".copilot");
    workspace = join(tmp, "workspace");
    binDir = join(tmp, "bin");
    rootDir = join(tmp, "root");
    fsmPath = join(workspace, "workflow.yaml");
    sharePath = join(tmp, "copilot-session.md");
    logDir = join(tmp, "copilot-logs");
    extensionsDir = join(configDir, "extensions");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    mkdirSync(extensionsDir, { recursive: true });
    writeFileSync(fsmPath, WORKFLOW, "utf-8");
    writeFreefsmWrapper(binDir);
    writeProbeExtension(extensionsDir);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test(
    "captures session.log output from a probe extension",
    () => {
      const env = {
        ...process.env,
        HOME: fakeHome,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };

      const out = execFileSync(
        "copilot",
        [
          "--config-dir",
          configDir,
          "--model",
          COPILOT_E2E_MODEL,
          "--allow-all",
          "--output-format",
          "text",
          "--log-dir",
          logDir,
          `--share=${sharePath}`,
          "-p",
          "Reply with exactly PROBE_OK.",
        ],
        { encoding: "utf-8", cwd: workspace, env, timeout: 60000 },
      );

      const captureText = [out, readArtifacts(sharePath, logDir)]
        .filter(Boolean)
        .join("\n---\n");

      expect(captureText).toContain("FREEFSM_E2E_PROBE session-start");
      expect(captureText).toContain("PROBE_OK");
    },
    60000,
  );

  test(
    "installs into temp Copilot config and emits trace logs for start → reminder → clear",
    () => {
      const env = {
        ...process.env,
        HOME: fakeHome,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FREEFSM_COPILOT_E2E_TRACE: "1",
      };

      const installOut = execFileSync(
        "node",
        [CLI, "install", "copilot"],
        { encoding: "utf-8", env },
      );
      expect(installOut).toContain("FreeFSM installed for Copilot CLI.");
      expect(existsSync(join(configDir, "skills", "freefsm"))).toBe(true);
      expect(existsSync(join(configDir, "extensions", "freefsm"))).toBe(true);

      const prompt = [
        "Use only the bash tool.",
        "Do not combine commands.",
        "Run these as separate bash tool calls in this exact order:",
        `1. freefsm start ${fsmPath} --run-id e2e-run --root ${rootDir}`,
        "2. printf 'one\\n'",
        "3. printf 'two\\n'",
        "4. printf 'three\\n'",
        "5. printf 'four\\n'",
        "6. printf 'five\\n'",
        "7. freefsm goto done --run-id e2e-run --on next --root " + rootDir,
        "Then reply with exactly DONE.",
      ].join(" ");

      const out = execFileSync(
        "copilot",
        [
          "--config-dir",
          configDir,
          "--model",
          COPILOT_E2E_MODEL,
          "--allow-all",
          "--output-format",
          "text",
          "--log-dir",
          logDir,
          `--share=${sharePath}`,
          "-p",
          prompt,
        ],
        { encoding: "utf-8", cwd: workspace, env, timeout: 120000 },
      );

      const captureText = [out, readArtifacts(sharePath, logDir)]
        .filter(Boolean)
        .join("\n---\n");

      expect(captureText).toContain("FREEFSM_E2E_TRACE session-start");
      expect(captureText).toContain("FREEFSM_E2E_TRACE run-bound e2e-run");
      expect(captureText).toContain("FREEFSM_E2E_TRACE reminder-fired e2e-run plan");
      expect(captureText).toContain("FREEFSM_E2E_TRACE run-cleared e2e-run");
      expect(captureText).toContain("DONE");
      expect(readFileSync(join(rootDir, "runs", "e2e-run", "snapshot.json"), "utf-8")).toContain('"run_status":"completed"');
    },
    120000,
  );
});
```

- [ ] **Step 3: Add the new file to the integration config**

Change `vitest.integration.config.ts` from:

```ts
export default defineConfig({
  test: {
    include: ["**/install.test.ts"],
    testTimeout: 30000,
  },
});
```

to:

```ts
export default defineConfig({
  test: {
    include: ["**/install.test.ts", "**/copilot-e2e.test.ts"],
    testTimeout: 120000,
  },
});
```

- [ ] **Step 4: Run the targeted test to verify it fails**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension/freefsm && \
npm run build && \
FREEFSM_RUN_COPILOT_E2E=1 FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini \
npx vitest run --config vitest.integration.config.ts src/__tests__/copilot-e2e.test.ts
```

Expected:
- The probe test passes, proving `session.log()` is observable through the harness capture strategy
- The `freefsm` e2e test fails because `FREEFSM_E2E_TRACE ...` messages are not emitted yet from `copilot/extension.mjs`

If the probe test fails instead, stop and diagnose extension loading or capture routing before continuing to Task 2.

### Task 2: Add default-off trace logging to the Copilot extension

**Files:**
- Modify: `freefsm/copilot/extension.mjs`

- [ ] **Step 1: Add trace helpers near the top of `extension.mjs`**

Initialize the trace switch **before** session setup, then capture the returned session object. Change the current top-level session registration from:

```js
await joinSession({
  onPermissionRequest: approveAll,
  hooks: { ... },
});
```

to:

```js
const E2E_TRACE_ENABLED = process.env.FREEFSM_COPILOT_E2E_TRACE === "1";

const session = await joinSession({
  onPermissionRequest: approveAll,
  hooks: { ... },
});

async function trace(message) {
  if (!E2E_TRACE_ENABLED) return;
  await session.log(`FREEFSM_E2E_TRACE ${message}`);
}
```

The trace must be **default off** and only enabled when the env var is exactly `"1"`.

- [ ] **Step 2: Emit trace points for the e2e lifecycle**

Add these calls:

```js
onSessionStart: async () => {
  await trace("session-start");
  return { additionalContext: COST_CONTEXT };
}
```

Inside `onPostToolUse`:

```js
if (runId) {
  activeRunId = runId;
  counter = 0;
  await trace(`run-bound ${runId}`);
}
```

```js
} else if (FINISH_RE.test(cmd) || GOTO_DONE_RE.test(cmd)) {
  const clearedRunId = activeRunId;
  activeRunId = null;
  counter = 0;
  if (clearedRunId) await trace(`run-cleared ${clearedRunId}`);
  return {};
}
```

Inside `buildReminder()` after the state is known and the reminder string is ready:

```js
await trace(`reminder-fired ${activeRunId} ${state}`);
return lines.join("\n");
```

Keep all existing production behavior unchanged when tracing is off.

- [ ] **Step 3: Re-run the targeted e2e test to verify it passes**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension/freefsm && \
npm run build && \
FREEFSM_RUN_COPILOT_E2E=1 FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini \
npx vitest run --config vitest.integration.config.ts src/__tests__/copilot-e2e.test.ts
```

Expected: PASS. The transcript contains:
- `FREEFSM_E2E_TRACE session-start`
- `FREEFSM_E2E_TRACE run-bound e2e-run`
- `FREEFSM_E2E_TRACE reminder-fired e2e-run plan`
- `FREEFSM_E2E_TRACE run-cleared e2e-run`

- [ ] **Step 4: Commit**

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension && \
git add freefsm/copilot/extension.mjs freefsm/src/__tests__/copilot-e2e.test.ts freefsm/vitest.integration.config.ts && \
git commit -m "test(freefsm): add automated Copilot e2e coverage

Adds a default-off Copilot CLI end-to-end test using a temporary HOME,
temporary Copilot config directory, and low-cost model selection.

Uses env-gated session.log trace markers so hidden hook behavior can be
asserted automatically without affecting normal users.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Run broad verification and push the branch update

**Files:**
- Modify: none (verification only unless formatter requires cleanup)

- [ ] **Step 1: Run the normal package verification**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension/freefsm && \
npm run build && \
npm test && \
npm run check
```

Expected:
- Existing suite stays green
- New Copilot e2e test is skipped by default unless `FREEFSM_RUN_COPILOT_E2E=1`
- No formatter or lint drift remains

- [ ] **Step 2: Re-run the targeted Copilot e2e with the cheap model**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension/freefsm && \
FREEFSM_RUN_COPILOT_E2E=1 FREEFSM_COPILOT_E2E_MODEL=gpt-5-mini \
npx vitest run --config vitest.integration.config.ts src/__tests__/copilot-e2e.test.ts
```

Expected: PASS using `gpt-5-mini`.

- [ ] **Step 3: Push the updated branch**

Run:

```bash
cd /home/krr/Projects/freematters/.worktrees/copilot-cli-extension && \
git push fork copilot-cli-extension
```

Expected: push succeeds and updates the existing branch on `git@github.com:kririae/freematters.git`.
