import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  type HookBinding,
  defaultBindingsDir,
  removeResolvedBinding,
  replaceBinding,
  resolveBinding,
} from "./bindings.js";
import { type ParsedHookPayload, classifyToolCall, parseHookPayload } from "./parse.js";
import { type RefreshRunResult, parseRefreshResult } from "./reminder.js";
import { trace as defaultTrace } from "./trace.js";

export type HookDecision = { kind: "allow" } | { kind: "deny"; reason: string };

export interface PreToolUseOptions {
  stateDir?: string;
  now?: () => string;
  refreshRun?: (binding: HookBinding) => RefreshRunResult;
  trace?: (message: string) => void;
}

const GATED_TOOL_LIMIT = 10;
export const FALLBACK_DENY_REASON = "[FSM] Run `freefsm current` before continuing.";
const ALLOW_DECISION: HookDecision = { kind: "allow" };

function nowIso(now: (() => string) | undefined): string {
  return now ? now() : new Date().toISOString();
}

function createBinding(
  input: ParsedHookPayload,
  runId: string,
  rootDir: string,
  now: (() => string) | undefined,
): HookBinding {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    runId,
    rootDir,
    gatedToolCount: 0,
    updatedAt: nowIso(now),
  };
}

function updateBinding(
  binding: HookBinding,
  input: ParsedHookPayload,
  overrides: Partial<HookBinding>,
  now: (() => string) | undefined,
): HookBinding {
  return {
    ...binding,
    sessionId: input.sessionId ?? binding.sessionId,
    cwd: input.cwd,
    updatedAt: nowIso(now),
    ...overrides,
  };
}

function coerceStdout(stdout: unknown): string {
  if (typeof stdout === "string") {
    return stdout;
  }

  if (stdout instanceof Buffer) {
    return stdout.toString("utf-8");
  }

  return "";
}

export function refreshRunFromCli(binding: HookBinding): RefreshRunResult {
  const args = ["current", "--run-id", binding.runId, "--root", binding.rootDir, "-j"];

  try {
    return parseRefreshResult(
      execFileSync("freefsm", args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error
        ? coerceStdout((error as { stdout?: unknown }).stdout)
        : "";

    if (stdout.trim().length > 0) {
      try {
        return parseRefreshResult(stdout);
      } catch {
        return { kind: "error" };
      }
    }

    return { kind: "error" };
  }
}

export function evaluatePreToolUse(
  input: ParsedHookPayload,
  options: PreToolUseOptions = {},
): HookDecision {
  const stateDir = options.stateDir ?? defaultBindingsDir();
  const refreshRun = options.refreshRun ?? refreshRunFromCli;
  const trace = options.trace ?? defaultTrace;
  const classification = classifyToolCall(input);

  if (classification.kind === "freefsm-start") {
    if (classification.runId && classification.rootDir) {
      replaceBinding(
        stateDir,
        null,
        createBinding(input, classification.runId, classification.rootDir, options.now),
      );
      trace(`run-bound ${classification.runId}`);
    }

    return ALLOW_DECISION;
  }

  const resolvedBinding = resolveBinding(stateDir, {
    sessionId: input.sessionId,
    cwd: input.cwd,
  });
  const binding = resolvedBinding?.binding ?? null;

  if (classification.kind === "freefsm-reset") {
    if (binding) {
      replaceBinding(
        stateDir,
        binding,
        updateBinding(binding, input, { gatedToolCount: 0 }, options.now),
      );
      trace(`counter-reset ${classification.action}`);
    }

    return ALLOW_DECISION;
  }

  if (classification.kind !== "counted" || !binding) {
    return ALLOW_DECISION;
  }

  const updatedCount = binding.gatedToolCount + 1;
  if (updatedCount < GATED_TOOL_LIMIT) {
    replaceBinding(
      stateDir,
      binding,
      updateBinding(binding, input, { gatedToolCount: updatedCount }, options.now),
    );
    return ALLOW_DECISION;
  }

  let refreshResult: RefreshRunResult;
  try {
    refreshResult = refreshRun(binding);
  } catch {
    refreshResult = { kind: "error" };
  }

  if (refreshResult.kind === "inactive") {
    removeResolvedBinding(stateDir, binding);
    trace(`run-cleared ${binding.runId}`);
    return ALLOW_DECISION;
  }

  replaceBinding(
    stateDir,
    binding,
    updateBinding(binding, input, { gatedToolCount: 0 }, options.now),
  );

  if (refreshResult.kind === "error") {
    trace(`refresh-failed ${binding.runId}`);
    return { kind: "deny", reason: FALLBACK_DENY_REASON };
  }

  trace(`reminder-fired ${binding.runId}`);
  return { kind: "deny", reason: refreshResult.reminder };
}

export function renderHookDecision(decision: HookDecision): string | null {
  if (decision.kind !== "deny") {
    return null;
  }

  return JSON.stringify({
    permissionDecision: "deny",
    permissionDecisionReason: decision.reason,
  });
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      resolve(raw);
    });
    process.stdin.on("error", () => {
      resolve("");
    });
  });
}

export async function main(): Promise<void> {
  try {
    defaultTrace("pre-tool-use-invoked");
    const raw = await readStdin();
    if (raw.trim().length === 0) {
      return;
    }

    const input = parseHookPayload(JSON.parse(raw));
    const output = renderHookDecision(evaluatePreToolUse(input));

    if (output) {
      process.stdout.write(output);
    }
  } catch {
    // Fail open unless intentionally denying.
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  void main();
}
