# Copilot CLI Extension Implementation Plan

> Superseded by `docs/superpowers/plans/2026-03-16-copilot-cli-plugin-rework.md`. This plan assumes an SDK-style `extension.mjs` architecture that live Copilot verification disproved.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Copilot CLI support to freefsm via an extension that provides hook-based FSM enforcement, plus an install command.

**Architecture:** A thin `extension.mjs` file registers `onPostToolUse` (state reminder) and `onSessionStart` (cost optimization context) hooks via the Copilot SDK. The existing skills and CLI are reused without modification. A new `freefsm install copilot` command creates symlinks to `~/.copilot/`.

**Tech Stack:** JavaScript (ES module `.mjs`), `@github/copilot-sdk`, Node.js `child_process`

**Spec:** `docs/superpowers/specs/2026-03-16-copilot-cli-extension-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `copilot/extension.mjs` | Create | Copilot CLI extension: hooks (onPostToolUse, onSessionStart) |
| `src/commands/install.ts` | Modify | Add `installCopilot()` function, update type and dispatch |
| `src/cli.ts` | Modify | Accept "copilot" in install command platform validation |
| `package.json` | Modify | Add `"copilot/"` to `files` array |
| `src/__tests__/install.test.ts` | Modify | Add Copilot install tests |

---

## Chunk 1: Extension + Install

### Task 1: Create `copilot/extension.mjs`

**Files:**
- Create: `freefsm/copilot/extension.mjs`

- [ ] **Step 1: Create the extension file with full implementation**

```js
import { execFile } from "node:child_process";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

// --- State ---
let activeRunId = null;
let counter = 0;

// --- Regex (ported from src/hooks/post-tool-use.ts) ---
const START_RE = /freefsm\s+start\b/;
const FINISH_RE = /freefsm\s+finish\b/;
const GOTO_DONE_RE = /freefsm\s+goto\s+done\b/;
const RUN_ID_FLAG_RE = /--run-id\s+(\S+)/;

function extractRunId(cmd, toolResult) {
  const match = RUN_ID_FLAG_RE.exec(cmd);
  if (match) return match[1];
  const text = typeof toolResult === "string"
    ? toolResult
    : toolResult?.textResultForLlm ?? "";
  const runIdMatch = /run_id:\s*(\S+)/.exec(text);
  return runIdMatch ? runIdMatch[1] : null;
}

function runFreefsm(args) {
  return new Promise((resolve) => {
    execFile("freefsm", args, { timeout: 10000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout);
    });
  });
}

async function buildReminder() {
  if (!activeRunId) return null;
  const stdout = await runFreefsm(["current", "--run-id", activeRunId, "-j"]);
  if (!stdout) return null;
  try {
    const envelope = JSON.parse(stdout);
    if (!envelope.ok) {
      activeRunId = null;
      counter = 0;
      return null;
    }
    const { state, prompt, todos, transitions } = envelope.data;
    const lines = [`[FSM Reminder] State: ${state}`, ""];
    const p = (prompt || "").trim();
    lines.push(p.length > 200 ? p.slice(0, 200) + "..." : p);
    if (todos && todos.length > 0) {
      lines.push("");
      lines.push("You MUST create a task for each of these items and complete them in order:");
      for (const t of todos) lines.push(`  - ${t}`);
    }
    const entries = Object.entries(transitions || {});
    if (entries.length > 0) {
      lines.push("");
      lines.push("Transitions:");
      for (const [label, target] of entries) lines.push(`  ${label} → ${target}`);
      lines.push("");
      lines.push("Keep driving the workflow — do NOT stop until you reach a terminal state.");
    }
    return lines.join("\n");
  } catch {
    activeRunId = null;
    counter = 0;
    return null;
  }
}

const COST_CONTEXT = [
  "COPILOT COST OPTIMIZATION: Each model turn costs a premium request.",
  "When you need user input, ALWAYS use the ask_user tool with requestedSchema",
  "(JSON Schema forms with enum, boolean, array fields) instead of conversational",
  "back-and-forth. Batch related questions into a single ask_user call when possible.",
  "Prefer multiple-choice (enum) and boolean fields over open-ended string fields.",
].join(" ");

const session = await joinSession({
  onPermissionRequest: approveAll,
  hooks: {
    onSessionStart: async () => {
      return { additionalContext: COST_CONTEXT };
    },
    onPostToolUse: async (input) => {
      // 1. Detect freefsm commands from Bash
      if (input.toolName === "bash") {
        const cmd = typeof input.toolArgs?.command === "string"
          ? input.toolArgs.command : "";
        if (START_RE.test(cmd)) {
          const resultText = typeof input.toolResult === "string"
            ? input.toolResult
            : input.toolResult?.textResultForLlm ?? "";
          const runId = extractRunId(cmd, resultText);
          if (runId) {
            activeRunId = runId;
            counter = 0;
          }
        } else if (FINISH_RE.test(cmd) || GOTO_DONE_RE.test(cmd)) {
          activeRunId = null;
          counter = 0;
          return;
        }
      }

      // 2. No active run — nothing to do
      if (!activeRunId) return;

      // 3. Increment counter, check interval
      counter++;
      if (counter % 5 !== 0) return;

      // 4. Build and return reminder
      const reminder = await buildReminder();
      if (reminder) {
        return { additionalContext: reminder };
      }
    },
  },
  tools: [],
});
```

- [ ] **Step 2: Verify the file is valid ES module syntax**

The SDK imports are only resolvable inside the Copilot CLI runtime, so use dynamic import with catch:

Run: `cd freefsm && node -e "import('file://' + process.cwd() + '/copilot/extension.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') { console.log('Syntax OK (SDK unavailable outside Copilot)'); process.exit(0); } else { console.error(e); process.exit(1); } })"`

Expected: `Syntax OK (SDK unavailable outside Copilot)` — confirms valid JS syntax without SDK.

- [ ] **Step 3: Commit**

```bash
cd freefsm && git add copilot/extension.mjs
git commit -m "feat(freefsm): add Copilot CLI extension with PostToolUse hook

Adds copilot/extension.mjs that registers onPostToolUse (state reminder
every 5 tool calls) and onSessionStart (cost optimization context) hooks
via the Copilot SDK extension API.

Ports the core logic from src/hooks/post-tool-use.ts to the Copilot
extension model (in-memory state instead of file-based sessions).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add `freefsm install copilot`

**Files:**
- Modify: `freefsm/src/commands/install.ts`
- Modify: `freefsm/src/cli.ts:165-175`

- [ ] **Step 1: Update the Platform type and install dispatch in `install.ts`**

In `src/commands/install.ts`, change:
```typescript
type Platform = "claude" | "codex";
```
to:
```typescript
type Platform = "claude" | "codex" | "copilot";
```

Update the `install()` function dispatch:
```typescript
export function install(platform: Platform): void {
  const packageRoot = getPackageRoot();

  if (platform === "claude") {
    installClaude(packageRoot);
  } else if (platform === "codex") {
    installCodex(packageRoot);
  } else {
    installCopilot(packageRoot);
  }
}
```

- [ ] **Step 2: Add `installCopilot()` function to `install.ts`**

Add after `installCodex()`, following the same symlink pattern:

```typescript
function linkTarget(source: string, target: string, label: string): void {
  if (existsSync(target)) {
    try {
      readlinkSync(target);
      unlinkSync(target);
      console.log(`Updating existing symlink: ${target}`);
    } catch {
      const backup = `${target}.bak`;
      renameSync(target, backup);
      console.log(`Backed up ${target} -> ${backup}`);
    }
  }
  symlinkSync(source, target);
  console.log(`${label}: ${target} -> ${source}`);
}

function installCopilot(packageRoot: string): void {
  const skillsSource = join(packageRoot, "skills");
  const copilotSource = join(packageRoot, "copilot");

  if (!existsSync(skillsSource)) {
    console.error(`Skills directory not found: ${skillsSource}`);
    process.exit(2);
  }
  if (!existsSync(copilotSource)) {
    console.error(
      `Copilot extension not found: ${copilotSource}\nUpgrade freefsm to a version with Copilot support.`,
    );
    process.exit(2);
  }

  const copilotHome = join(homedir(), ".copilot");
  const skillsDir = join(copilotHome, "skills");
  const extensionsDir = join(copilotHome, "extensions");
  const skillsTarget = join(skillsDir, PLUGIN_NAME);
  const extensionTarget = join(extensionsDir, PLUGIN_NAME);

  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });

  linkTarget(skillsSource, skillsTarget, "Skills linked");
  linkTarget(copilotSource, extensionTarget, "Extension linked");

  console.log("\nFreeFSM installed for Copilot CLI.");
  console.log(
    "\nSkills: /freefsm:create, /freefsm:start, /freefsm:current, /freefsm:finish",
  );
  console.log("Hook: PostToolUse state reminder (every 5 tool calls)");
  console.log("\nRestart Copilot CLI to activate.");
}
```

Note: Extract the symlink-replace-or-backup pattern from `installCodex` into a shared `linkTarget` helper to DRY up the code. Refactor `installCodex` to use it too:

```typescript
function installCodex(packageRoot: string): void {
  const skillsSource = join(packageRoot, "skills");
  const agentsDir = join(homedir(), ".agents", "skills");
  const target = join(agentsDir, PLUGIN_NAME);

  if (!existsSync(skillsSource)) {
    console.error(`Skills directory not found: ${skillsSource}`);
    process.exit(2);
  }

  mkdirSync(agentsDir, { recursive: true });
  linkTarget(skillsSource, target, "FreeFSM skills linked for Codex");
  console.log(
    `\nNote: Codex does not support hooks. The agent won't get periodic state reminders.`,
  );
}
```

- [ ] **Step 3: Update platform validation in `cli.ts`**

In `src/cli.ts`, change:
```typescript
  .argument("<platform>", "target platform: claude or codex")
  .action((platform: string) => {
    if (platform !== "claude" && platform !== "codex") {
      console.error(`Unknown platform "${platform}". Use "claude" or "codex".`);
      process.exit(2);
    }
    install(platform as "claude" | "codex");
  });
```
to:
```typescript
  .argument("<platform>", "target platform: claude, codex, or copilot")
  .action((platform: string) => {
    if (platform !== "claude" && platform !== "codex" && platform !== "copilot") {
      console.error(`Unknown platform "${platform}". Use "claude", "codex", or "copilot".`);
      process.exit(2);
    }
    install(platform as "claude" | "codex" | "copilot");
  });
```

- [ ] **Step 4: Update `package.json` files array**

In `freefsm/package.json`, change:
```json
"files": ["dist/", "prompts/", "workflows/", "skills/", "hooks/", ".claude-plugin/"],
```
to:
```json
"files": ["dist/", "prompts/", "workflows/", "skills/", "hooks/", "copilot/", ".claude-plugin/"],
```

- [ ] **Step 5: Build and verify no type errors**

Run: `cd freefsm && npm run build`

Expected: Clean compilation, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/install.ts src/cli.ts package.json
git commit -m "feat(freefsm): add freefsm install copilot command

Adds Copilot CLI platform support to the install command. Creates two
symlinks: skills to ~/.copilot/skills/freefsm/ and extension to
~/.copilot/extensions/freefsm/.

Extracts linkTarget helper from installCodex to DRY up symlink logic.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Add Copilot install tests

**Files:**
- Modify: `freefsm/src/__tests__/install.test.ts`

- [ ] **Step 1: Add Copilot install test suite**

Add after the existing Codex install tests, following the same pattern. Unlike Codex (which only links skills), Copilot links both skills and extensions:

```typescript
// ─── Copilot install ────────────────────────────────────────────

describe("install copilot", () => {
  const copilotHome = join(homedir(), ".copilot");
  const skillsTarget = join(copilotHome, "skills", "freefsm");
  const extensionTarget = join(copilotHome, "extensions", "freefsm");
  const skillsBackup = `${skillsTarget}.bak`;
  const extensionBackup = `${extensionTarget}.bak`;

  let savedSkillsLink: string | null = null;
  let hadSkillsTarget = false;
  let savedExtensionLink: string | null = null;
  let hadExtensionTarget = false;

  beforeAll(() => {
    if (existsSync(skillsTarget)) {
      hadSkillsTarget = true;
      try {
        savedSkillsLink = readlinkSync(skillsTarget);
      } catch {
        savedSkillsLink = null;
      }
    }
    if (existsSync(extensionTarget)) {
      hadExtensionTarget = true;
      try {
        savedExtensionLink = readlinkSync(extensionTarget);
      } catch {
        savedExtensionLink = null;
      }
    }
  });

  afterAll(() => {
    // Clean up test artifacts
    if (existsSync(skillsTarget)) rmSync(skillsTarget, { force: true });
    if (existsSync(skillsBackup)) rmSync(skillsBackup, { recursive: true, force: true });
    if (existsSync(extensionTarget)) rmSync(extensionTarget, { force: true });
    if (existsSync(extensionBackup)) rmSync(extensionBackup, { recursive: true, force: true });

    // Restore original state
    if (hadSkillsTarget && savedSkillsLink) {
      mkdirSync(join(copilotHome, "skills"), { recursive: true });
      symlinkSync(savedSkillsLink, skillsTarget);
    }
    if (hadExtensionTarget && savedExtensionLink) {
      mkdirSync(join(copilotHome, "extensions"), { recursive: true });
      symlinkSync(savedExtensionLink, extensionTarget);
    }
  });

  test("creates symlinks to skills and extension directories", () => {
    if (existsSync(skillsTarget)) rmSync(skillsTarget, { force: true });
    if (existsSync(extensionTarget)) rmSync(extensionTarget, { force: true });

    const stdout = cli("install copilot");
    expect(stdout).toContain("FreeFSM installed for Copilot CLI");

    expect(existsSync(skillsTarget)).toBe(true);
    expect(lstatSync(skillsTarget).isSymbolicLink()).toBe(true);
    expect(readlinkSync(skillsTarget)).toBe(join(PACKAGE_ROOT, "skills"));

    expect(existsSync(extensionTarget)).toBe(true);
    expect(lstatSync(extensionTarget).isSymbolicLink()).toBe(true);
    expect(readlinkSync(extensionTarget)).toBe(join(PACKAGE_ROOT, "copilot"));
  });

  test("re-install updates existing symlinks", () => {
    const stdout = cli("install copilot");
    expect(stdout).toContain("Updating existing symlink");
    expect(stdout).toContain("FreeFSM installed for Copilot CLI");

    expect(lstatSync(skillsTarget).isSymbolicLink()).toBe(true);
    expect(lstatSync(extensionTarget).isSymbolicLink()).toBe(true);
  });

  test("backs up non-symlink targets", () => {
    rmSync(skillsTarget, { force: true });
    mkdirSync(skillsTarget, { recursive: true });
    writeFileSync(join(skillsTarget, "marker.txt"), "original-skills");

    rmSync(extensionTarget, { force: true });
    mkdirSync(extensionTarget, { recursive: true });
    writeFileSync(join(extensionTarget, "marker.txt"), "original-ext");

    const stdout = cli("install copilot");
    expect(stdout).toContain("Backed up");
    expect(stdout).toContain("FreeFSM installed for Copilot CLI");

    expect(lstatSync(skillsTarget).isSymbolicLink()).toBe(true);
    expect(lstatSync(extensionTarget).isSymbolicLink()).toBe(true);

    expect(existsSync(skillsBackup)).toBe(true);
    expect(readFileSync(join(skillsBackup, "marker.txt"), "utf-8")).toBe("original-skills");
    expect(existsSync(extensionBackup)).toBe(true);
    expect(readFileSync(join(extensionBackup, "marker.txt"), "utf-8")).toBe("original-ext");
  });
});
```

- [ ] **Step 2: Run tests to verify**

Run: `cd freefsm && npm run build && npm test`

Expected: All existing tests pass plus the new Copilot install tests.

- [ ] **Step 3: Run lint/format**

Run: `cd freefsm && npm run check`

Expected: No format or lint errors.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/install.test.ts
git commit -m "test(freefsm): add Copilot CLI install tests

Tests creating skills and extension symlinks, re-install updates, and
non-symlink backup behavior. Follows existing Codex install test pattern.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

**Note on extension.mjs unit tests:** The spec mentions mocking `execFile` to test hook logic. This is deferred because: (1) the SDK imports (`@github/copilot-sdk`) are only resolvable inside the Copilot CLI runtime, making vitest execution impractical without a full SDK mock, (2) the core logic is a direct port of already-tested `post-tool-use.ts`, (3) the extension will be manually tested in the Copilot CLI environment. A future task could add tests using a mock SDK module, but the ROI is low given the small codebase.

**Note on test skipIf guard:** The existing Codex tests use `describe.skipIf(!hasCommand("codex"))` even though `installCodex()` only creates symlinks. The Copilot install tests don't use a guard because they only create symlinks to `~/.copilot/` and don't invoke any Copilot CLI commands. Both approaches produce the same result (always run), but omitting the guard is more honest.

### Task 4: Push to fork

- [ ] **Step 1: Add fork remote if not present**

```bash
cd /home/krr/Projects/freematters
git remote get-url fork 2>/dev/null || git remote add fork git@github.com:kririae/freematters.git
```

- [ ] **Step 2: Push to fork**

```bash
git push fork main
```

Expected: Push succeeds.
