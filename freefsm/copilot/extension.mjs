import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);

// --- Regex patterns ---
const START_RE = /freefsm\s+start\b/;
const FINISH_RE = /freefsm\s+finish\b/;
const GOTO_DONE_RE = /freefsm\s+goto\s+done\b/;
const RUN_ID_FLAG_RE = /--run-id\s+(\S+)/;

// --- In-memory session state ---
let activeRunId = null;
let counter = 0;

// --- Cost optimization context ---
const COST_CONTEXT = `
# CRITICAL: Minimize Copilot CLI request costs

Every tool call in Copilot CLI triggers a premium model request, making each turn significantly more expensive than in other environments.

## Required cost-saving behaviors:
- ALWAYS use ask_user with requestedSchema when you need information from the user
- BATCH related questions into ONE ask_user call instead of asking them separately
- Use structured types (enum, boolean) instead of open-ended strings whenever possible
- Combine multiple file reads into a single parallel tool call
- Never make sequential tool calls when parallel execution is possible
- Think carefully before each tool call — unnecessary calls waste premium requests

## Example (BAD - wastes 3 turns):
Turn 1: ask_user "What's the module name?"
Turn 2: ask_user "Should I add tests?"
Turn 3: ask_user "Which test framework?"

## Example (GOOD - uses 1 turn):
ask_user with requestedSchema: { moduleName: string, addTests: boolean, testFramework: enum }

Remember: Every turn is expensive. Maximize information gathered per turn.
`.trim();

// --- Helper: Extract run ID ---
function extractRunId(cmd, toolResult) {
  // Try --run-id flag from command
  const match = RUN_ID_FLAG_RE.exec(cmd);
  if (match) return match[1];

  // Try parsing from tool result (plain string or structured result)
  const resultText = typeof toolResult === "string" 
    ? toolResult 
    : toolResult?.textResultForLlm;
  
  if (resultText) {
    const runIdMatch = /run_id:\s*(\S+)/.exec(resultText);
    if (runIdMatch) return runIdMatch[1];
  }

  return null;
}

// --- Helper: Shell out to freefsm ---
async function runFreefsm(args) {
  try {
    const { stdout } = await execFileAsync("freefsm", args, { timeout: 10000 });
    return stdout;
  } catch {
    return null;
  }
}

// --- Helper: Build reminder text ---
async function buildReminder() {
  if (!activeRunId) return null;

  const output = await runFreefsm(["current", "--run-id", activeRunId, "-j"]);
  if (!output) {
    activeRunId = null;
    counter = 0;
    return null;
  }

  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch {
    activeRunId = null;
    counter = 0;
    return null;
  }

  if (!envelope.ok || !envelope.data) {
    activeRunId = null;
    counter = 0;
    return null;
  }

  // Wrap reminder formatting in try/catch for fail-safe behavior
  try {
    const { state, prompt, todos, transitions } = envelope.data;

    const lines = [];
    lines.push(`[FSM Reminder] State: ${state}`);
    lines.push("");

    let promptText = prompt.trim();
    if (promptText.length > 200) {
      promptText = `${promptText.slice(0, 200)}...`;
    }
    lines.push(promptText);

    if (todos && todos.length > 0) {
      lines.push("");
      lines.push("You MUST create a task for each of these items and complete them in order:");
      for (const t of todos) {
        lines.push(`  - ${t}`);
      }
    }

    const entries = Object.entries(transitions);
    if (entries.length > 0) {
      lines.push("");
      lines.push("Transitions:");
      for (const [label, target] of entries) {
        lines.push(`  ${label} → ${target}`);
      }
      lines.push("");
      lines.push("Keep driving the workflow — do NOT stop until you reach a terminal state.");
    }

    return lines.join("\n");
  } catch {
    // Silently fail and clear state if reminder formatting fails
    activeRunId = null;
    counter = 0;
    return null;
  }
}

// --- Register extension ---
await joinSession({
  onPermissionRequest: approveAll,

  hooks: {
    onSessionStart() {
      return { additionalContext: COST_CONTEXT };
    },

    async onPostToolUse(input) {
      // 1. Auto-detect freefsm commands from Bash
      if (input.toolName === "bash") {
        const cmd = typeof input.toolArgs?.command === "string" ? input.toolArgs.command : "";

        if (START_RE.test(cmd)) {
          const runId = extractRunId(cmd, input.toolResult);
          if (runId) {
            activeRunId = runId;
            counter = 0;
          }
        } else if (FINISH_RE.test(cmd) || GOTO_DONE_RE.test(cmd)) {
          activeRunId = null;
          counter = 0;
          return {};
        }
      }

      // 2. Check active run
      if (!activeRunId) return {};

      // 3. Increment counter
      counter++;
      if (counter % 5 !== 0) return {};

      // 4. Build and return reminder
      const reminder = await buildReminder();
      if (!reminder) return {};

      return { additionalContext: reminder };
    },
  },
});
