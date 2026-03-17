import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const FIXED_NOW = "2026-03-16T12:34:56.000Z";
const tempRoots = new Set<string>();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(dir);
  return dir;
}

function rawPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "session-1",
    cwd: "/workspace/project",
    toolName: "view",
    toolInput: { path: "README.md" },
    ...overrides,
  };
}

const ACTIVE_CURRENT_JSON = JSON.stringify({
  ok: true,
  code: null,
  message: "Current state",
  data: {
    run_id: "run-1",
    state: "plan",
    prompt: "Plan\n the work carefully before coding.",
    todos: ["Draft todo list", "Implement the feature"],
    transitions: {
      next: "done",
      revise: "plan",
    },
    run_status: "active",
  },
});

async function loadParseModule() {
  return import("../copilot-hooks/parse.js");
}

async function loadBindingsModule() {
  return import("../copilot-hooks/bindings.js");
}

async function loadReminderModule() {
  return import("../copilot-hooks/reminder.js");
}

async function loadPreToolUseModule() {
  return import("../copilot-hooks/pre-tool-use.js");
}

afterEach(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("copilot hook payload parsing and classification", () => {
  test("prefers sessionId for binding and falls back to cwd when absent", async () => {
    const { parseHookPayload } = await loadParseModule();

    const withSession = parseHookPayload(
      rawPayload({
        sessionId: "session-99",
        cwd: "/repo/a",
      }),
    );
    const withCwdFallback = parseHookPayload(
      rawPayload({
        sessionId: undefined,
        cwd: "/repo/b",
      }),
    );

    expect(withSession.bindingKey).toEqual({ kind: "session", value: "session-99" });
    expect(withSession.sessionId).toBe("session-99");
    expect(withCwdFallback.bindingKey).toEqual({ kind: "cwd", value: "/repo/b" });
    expect(withCwdFallback.sessionId).toBeUndefined();
  });

  test("parses real Copilot stringified toolArgs payloads", async () => {
    const { classifyToolCall, parseHookPayload } = await loadParseModule();

    const parsed = parseHookPayload({
      sessionId: "session-json",
      cwd: "/workspace/project",
      toolName: "bash",
      toolArgs: JSON.stringify({
        command: "freefsm start workflow.yaml --run-id run-json --root /tmp/root-json",
      }),
    });

    expect(parsed.toolInput).toEqual({
      command: "freefsm start workflow.yaml --run-id run-json --root /tmp/root-json",
    });
    expect(classifyToolCall(parsed)).toMatchObject({
      kind: "freefsm-start",
      runId: "run-json",
      rootDir: "/tmp/root-json",
    });
  });

  test("treats non-object stringified toolArgs payloads as empty input", async () => {
    const { parseHookPayload } = await loadParseModule();

    const parsed = parseHookPayload({
      sessionId: "session-array",
      cwd: "/workspace/project",
      toolName: "bash",
      toolArgs: JSON.stringify(["printf", "hello"]),
    });

    expect(parsed.toolInput).toEqual({});
  });

  test.each([
    {
      name: "start command",
      payload: rawPayload({
        toolName: "bash",
        toolInput: {
          command: 'freefsm start workflow.yaml --run-id run-1 --root "/tmp/root dir"',
        },
      }),
      expected: {
        kind: "freefsm-start",
        counted: false,
        runId: "run-1",
        rootDir: "/tmp/root dir",
      },
    },
    {
      name: "start command with escaped spaces",
      payload: rawPayload({
        toolName: "bash",
        toolInput: {
          command:
            "freefsm start workflow.yaml --run-id run-escaped --root /tmp/root\\ dir",
        },
      }),
      expected: {
        kind: "freefsm-start",
        counted: false,
        runId: "run-escaped",
        rootDir: "/tmp/root dir",
      },
    },
    {
      name: "current command",
      payload: rawPayload({
        toolName: "bash",
        toolInput: { command: "freefsm current --run-id run-1 --root /tmp/root" },
      }),
      expected: { kind: "freefsm-reset", counted: false, action: "current" },
    },
    {
      name: "goto command",
      payload: rawPayload({
        toolName: "bash",
        toolInput: {
          command: "freefsm goto done --run-id run-1 --on next --root /tmp/root",
        },
      }),
      expected: { kind: "freefsm-reset", counted: false, action: "goto" },
    },
    {
      name: "finish command",
      payload: rawPayload({
        toolName: "bash",
        toolInput: { command: "freefsm finish --run-id run-1 --root /tmp/root" },
      }),
      expected: { kind: "freefsm-reset", counted: false, action: "finish" },
    },
    {
      name: "non-freefsm bash command",
      payload: rawPayload({
        toolName: "bash",
        toolInput: { command: "printf 'hello'" },
      }),
      expected: { kind: "counted", counted: true },
    },
    {
      name: "view command",
      payload: rawPayload({
        toolName: "view",
        toolInput: { path: "README.md" },
      }),
      expected: { kind: "counted", counted: true },
    },
    {
      name: "edit command",
      payload: rawPayload({
        toolName: "edit",
      }),
      expected: { kind: "ignored", counted: false },
    },
    {
      name: "create command",
      payload: rawPayload({
        toolName: "create",
      }),
      expected: { kind: "ignored", counted: false },
    },
  ])("classifies $name", async ({ payload, expected }) => {
    const { classifyToolCall, parseHookPayload } = await loadParseModule();

    const parsed = parseHookPayload(payload);
    const classification = classifyToolCall(parsed);

    expect(classification).toMatchObject(expected);
  });

  test("tokenizes escaped quotes inside double quoted arguments", async () => {
    const { tokenizeShellCommand } = await loadParseModule();

    expect(
      tokenizeShellCommand(
        'freefsm start "workflow file.yaml" --root "/tmp/root dir" --prompt "say \\"hello\\""',
      ),
    ).toEqual([
      "freefsm",
      "start",
      "workflow file.yaml",
      "--root",
      "/tmp/root dir",
      "--prompt",
      'say "hello"',
    ]);
  });
});

describe("copilot binding persistence", () => {
  test("persists, loads, removes, and keys bindings by session or cwd", async () => {
    const { bindingKeyFor, bindingPathFor, loadBinding, removeBinding, saveBinding } =
      await loadBindingsModule();
    const stateDir = makeTempDir("freefsm-copilot-bindings-");
    const sessionKey = bindingKeyFor({
      sessionId: "session-1",
      cwd: "/workspace/project",
    });
    const cwdKey = bindingKeyFor({ cwd: "/workspace/project" });

    saveBinding(stateDir, sessionKey, {
      sessionId: "session-1",
      cwd: "/workspace/project",
      runId: "run-session",
      rootDir: "/tmp/root-session",
      gatedToolCount: 3,
      updatedAt: FIXED_NOW,
    });
    saveBinding(stateDir, cwdKey, {
      cwd: "/workspace/project",
      runId: "run-cwd",
      rootDir: "/tmp/root-cwd",
      gatedToolCount: 1,
      updatedAt: FIXED_NOW,
    });

    expect(bindingPathFor(stateDir, sessionKey)).not.toBe(
      bindingPathFor(stateDir, cwdKey),
    );
    expect(loadBinding(stateDir, sessionKey)).toMatchObject({
      runId: "run-session",
      gatedToolCount: 3,
    });
    expect(loadBinding(stateDir, cwdKey)).toMatchObject({
      runId: "run-cwd",
      gatedToolCount: 1,
    });

    removeBinding(stateDir, sessionKey);
    expect(loadBinding(stateDir, sessionKey)).toBeNull();
    expect(loadBinding(stateDir, cwdKey)).toMatchObject({ runId: "run-cwd" });
  });
});

describe("reminder formatting", () => {
  test("compresses current output to a compact reminder without todos", async () => {
    const { parseRefreshResult } = await loadReminderModule();

    const result = parseRefreshResult(ACTIVE_CURRENT_JSON);

    expect(result).toEqual({
      kind: "active",
      reminder:
        "[FSM plan] Plan the work carefully before coding. Next: next → done; revise → plan.",
    });
  });

  test.each([
    {
      name: "missing run",
      raw: JSON.stringify({
        ok: false,
        code: "RUN_NOT_FOUND",
        message: "run not found",
        data: null,
      }),
    },
    {
      name: "completed run",
      raw: JSON.stringify({
        ok: true,
        code: null,
        message: "Current state",
        data: {
          state: "done",
          prompt: "Finished.",
          todos: null,
          transitions: {},
          run_status: "completed",
        },
      }),
    },
    {
      name: "aborted run",
      raw: JSON.stringify({
        ok: true,
        code: null,
        message: "Current state",
        data: {
          state: "done",
          prompt: "Stopped.",
          todos: null,
          transitions: {},
          run_status: "aborted",
        },
      }),
    },
  ])("treats $name as inactive", async ({ raw }) => {
    const { parseRefreshResult } = await loadReminderModule();

    expect(parseRefreshResult(raw)).toEqual({ kind: "inactive" });
  });
});

describe("pre-tool-use decisions", () => {
  test("allows when there is no active binding", async () => {
    const { parseHookPayload } = await loadParseModule();
    const { evaluatePreToolUse } = await loadPreToolUseModule();
    const stateDir = makeTempDir("freefsm-copilot-decisions-");

    const result = evaluatePreToolUse(parseHookPayload(rawPayload()), {
      stateDir,
      now: () => FIXED_NOW,
      refreshRun: () => {
        throw new Error("refresh should not run without a binding");
      },
    });

    expect(result).toEqual({ kind: "allow" });
  });

  test("counts only bash and view while ignoring edit and create", async () => {
    const { parseHookPayload } = await loadParseModule();
    const { bindingKeyFor, loadBinding, saveBinding } = await loadBindingsModule();
    const { evaluatePreToolUse } = await loadPreToolUseModule();
    const stateDir = makeTempDir("freefsm-copilot-counted-");
    const key = bindingKeyFor({ sessionId: "session-1", cwd: "/workspace/project" });

    saveBinding(stateDir, key, {
      sessionId: "session-1",
      cwd: "/workspace/project",
      runId: "run-1",
      rootDir: "/tmp/root",
      gatedToolCount: 0,
      updatedAt: FIXED_NOW,
    });

    for (const toolName of ["edit", "create", "search"] as const) {
      expect(
        evaluatePreToolUse(parseHookPayload(rawPayload({ toolName })), {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => {
            throw new Error("refresh should not run below threshold");
          },
        }),
      ).toEqual({ kind: "allow" });
    }

    expect(loadBinding(stateDir, key)?.gatedToolCount).toBe(0);

    expect(
      evaluatePreToolUse(
        parseHookPayload(
          rawPayload({
            toolName: "bash",
            toolInput: { command: "printf 'hello'" },
          }),
        ),
        {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => {
            throw new Error("refresh should not run below threshold");
          },
        },
      ),
    ).toEqual({ kind: "allow" });
    expect(loadBinding(stateDir, key)?.gatedToolCount).toBe(1);

    expect(
      evaluatePreToolUse(parseHookPayload(rawPayload({ toolName: "view" })), {
        stateDir,
        now: () => FIXED_NOW,
        refreshRun: () => {
          throw new Error("refresh should not run below threshold");
        },
      }),
    ).toEqual({ kind: "allow" });
    expect(loadBinding(stateDir, key)?.gatedToolCount).toBe(2);
  });

  test("denies the 10th counted call with a compact reminder and resets the counter", async () => {
    const { parseHookPayload } = await loadParseModule();
    const { bindingKeyFor, loadBinding, saveBinding } = await loadBindingsModule();
    const { evaluatePreToolUse } = await loadPreToolUseModule();
    const stateDir = makeTempDir("freefsm-copilot-threshold-");
    const key = bindingKeyFor({ sessionId: "session-1", cwd: "/workspace/project" });

    saveBinding(stateDir, key, {
      sessionId: "session-1",
      cwd: "/workspace/project",
      runId: "run-1",
      rootDir: "/tmp/root",
      gatedToolCount: 9,
      updatedAt: FIXED_NOW,
    });

    const result = evaluatePreToolUse(
      parseHookPayload(rawPayload({ toolName: "view" })),
      {
        stateDir,
        now: () => FIXED_NOW,
        refreshRun: () => ({
          kind: "active",
          reminder:
            "[FSM plan] Plan the work carefully before coding. Next: next → done.",
        }),
      },
    );

    expect(result).toEqual({
      kind: "deny",
      reason: "[FSM plan] Plan the work carefully before coding. Next: next → done.",
    });
    expect(loadBinding(stateDir, key)?.gatedToolCount).toBe(0);
  });

  test("freefsm start creates a binding and freefsm current/goto/finish reset the counter", async () => {
    const { parseHookPayload } = await loadParseModule();
    const { bindingKeyFor, loadBinding, saveBinding } = await loadBindingsModule();
    const { evaluatePreToolUse } = await loadPreToolUseModule();
    const stateDir = makeTempDir("freefsm-copilot-bookkeeping-");
    const key = bindingKeyFor({ sessionId: "session-1", cwd: "/workspace/project" });

    expect(
      evaluatePreToolUse(
        parseHookPayload(
          rawPayload({
            toolName: "bash",
            toolInput: {
              command: "freefsm start workflow.yaml --run-id run-2 --root /tmp/root-2",
            },
          }),
        ),
        {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => {
            throw new Error("refresh should not run for freefsm start");
          },
        },
      ),
    ).toEqual({ kind: "allow" });

    expect(loadBinding(stateDir, key)).toMatchObject({
      runId: "run-2",
      rootDir: "/tmp/root-2",
      gatedToolCount: 0,
    });

    saveBinding(stateDir, key, {
      sessionId: "session-1",
      cwd: "/workspace/project",
      runId: "run-2",
      rootDir: "/tmp/root-2",
      gatedToolCount: 7,
      updatedAt: FIXED_NOW,
    });

    for (const command of [
      "freefsm current --run-id run-2 --root /tmp/root-2",
      "freefsm goto done --run-id run-2 --on next --root /tmp/root-2",
      "freefsm finish --run-id run-2 --root /tmp/root-2",
    ]) {
      expect(
        evaluatePreToolUse(
          parseHookPayload(rawPayload({ toolName: "bash", toolInput: { command } })),
          {
            stateDir,
            now: () => FIXED_NOW,
            refreshRun: () => {
              throw new Error(
                "refresh should not run for freefsm bookkeeping commands",
              );
            },
          },
        ),
      ).toEqual({ kind: "allow" });
      expect(loadBinding(stateDir, key)?.gatedToolCount).toBe(0);

      saveBinding(stateDir, key, {
        sessionId: "session-1",
        cwd: "/workspace/project",
        runId: "run-2",
        rootDir: "/tmp/root-2",
        gatedToolCount: 7,
        updatedAt: FIXED_NOW,
      });
    }
  });

  test("keeps the reminder loop when a cwd-only binding later gains a sessionId", async () => {
    const { parseHookPayload } = await loadParseModule();
    const { bindingKeyFor, loadBinding } = await loadBindingsModule();
    const { evaluatePreToolUse } = await loadPreToolUseModule();
    const stateDir = makeTempDir("freefsm-copilot-session-upgrade-");
    const sessionKey = bindingKeyFor({
      sessionId: "session-1",
      cwd: "/workspace/project",
    });
    const cwdKey = bindingKeyFor({ cwd: "/workspace/project" });

    expect(
      evaluatePreToolUse(
        parseHookPayload(
          rawPayload({
            sessionId: undefined,
            toolName: "bash",
            toolInput: {
              command: "freefsm start workflow.yaml --run-id run-3 --root /tmp/root-3",
            },
          }),
        ),
        {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => {
            throw new Error("refresh should not run for freefsm start");
          },
        },
      ),
    ).toEqual({ kind: "allow" });

    expect(
      evaluatePreToolUse(parseHookPayload(rawPayload({ toolName: "view" })), {
        stateDir,
        now: () => FIXED_NOW,
        refreshRun: () => {
          throw new Error("refresh should not run below threshold");
        },
      }),
    ).toEqual({ kind: "allow" });

    expect(loadBinding(stateDir, sessionKey)).toMatchObject({
      runId: "run-3",
      gatedToolCount: 1,
    });
    expect(loadBinding(stateDir, cwdKey)).toMatchObject({
      runId: "run-3",
      gatedToolCount: 1,
    });
  });

  test("keeps the reminder loop when a session binding later falls back to cwd", async () => {
    const { parseHookPayload } = await loadParseModule();
    const { bindingKeyFor, loadBinding } = await loadBindingsModule();
    const { evaluatePreToolUse } = await loadPreToolUseModule();
    const stateDir = makeTempDir("freefsm-copilot-session-fallback-");
    const sessionKey = bindingKeyFor({
      sessionId: "session-1",
      cwd: "/workspace/project",
    });
    const cwdKey = bindingKeyFor({ cwd: "/workspace/project" });

    expect(
      evaluatePreToolUse(
        parseHookPayload(
          rawPayload({
            toolName: "bash",
            toolInput: {
              command: "freefsm start workflow.yaml --run-id run-4 --root /tmp/root-4",
            },
          }),
        ),
        {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => {
            throw new Error("refresh should not run for freefsm start");
          },
        },
      ),
    ).toEqual({ kind: "allow" });

    expect(
      evaluatePreToolUse(
        parseHookPayload(rawPayload({ sessionId: undefined, toolName: "view" })),
        {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => {
            throw new Error("refresh should not run below threshold");
          },
        },
      ),
    ).toEqual({ kind: "allow" });

    expect(loadBinding(stateDir, sessionKey)).toMatchObject({
      runId: "run-4",
      gatedToolCount: 1,
    });
    expect(loadBinding(stateDir, cwdKey)).toMatchObject({
      runId: "run-4",
      gatedToolCount: 1,
    });
  });

  test("does not let a different session inherit a cwd fallback binding", async () => {
    const { parseHookPayload } = await loadParseModule();
    const { bindingKeyFor, loadBinding } = await loadBindingsModule();
    const { evaluatePreToolUse } = await loadPreToolUseModule();
    const stateDir = makeTempDir("freefsm-copilot-session-isolation-");
    const sessionOneKey = bindingKeyFor({
      sessionId: "session-1",
      cwd: "/workspace/project",
    });
    const sessionTwoKey = bindingKeyFor({
      sessionId: "session-2",
      cwd: "/workspace/project",
    });
    const cwdKey = bindingKeyFor({ cwd: "/workspace/project" });

    expect(
      evaluatePreToolUse(
        parseHookPayload(
          rawPayload({
            toolName: "bash",
            toolInput: {
              command: "freefsm start workflow.yaml --run-id run-5 --root /tmp/root-5",
            },
          }),
        ),
        {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => {
            throw new Error("refresh should not run for freefsm start");
          },
        },
      ),
    ).toEqual({ kind: "allow" });

    expect(loadBinding(stateDir, sessionOneKey)).toMatchObject({
      sessionId: "session-1",
      runId: "run-5",
      gatedToolCount: 0,
    });
    expect(loadBinding(stateDir, cwdKey)).toMatchObject({
      sessionId: "session-1",
      runId: "run-5",
      gatedToolCount: 0,
    });

    expect(
      evaluatePreToolUse(
        parseHookPayload(rawPayload({ sessionId: "session-2", toolName: "view" })),
        {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => {
            throw new Error("refresh should not run without a matching binding");
          },
        },
      ),
    ).toEqual({ kind: "allow" });

    expect(loadBinding(stateDir, sessionOneKey)).toMatchObject({
      sessionId: "session-1",
      runId: "run-5",
      gatedToolCount: 0,
    });
    expect(loadBinding(stateDir, sessionTwoKey)).toBeNull();
    expect(loadBinding(stateDir, cwdKey)).toMatchObject({
      sessionId: "session-1",
      runId: "run-5",
      gatedToolCount: 0,
    });
  });

  test.each(["missing", "completed", "aborted"])(
    "clears the binding and allows when refresh reports %s",
    async (reason) => {
      const { parseHookPayload } = await loadParseModule();
      const { bindingKeyFor, loadBinding, saveBinding } = await loadBindingsModule();
      const { evaluatePreToolUse } = await loadPreToolUseModule();
      const stateDir = makeTempDir(`freefsm-copilot-inactive-${reason}-`);
      const key = bindingKeyFor({ sessionId: "session-1", cwd: "/workspace/project" });

      saveBinding(stateDir, key, {
        sessionId: "session-1",
        cwd: "/workspace/project",
        runId: "run-1",
        rootDir: "/tmp/root",
        gatedToolCount: 9,
        updatedAt: FIXED_NOW,
      });

      expect(
        evaluatePreToolUse(parseHookPayload(rawPayload({ toolName: "view" })), {
          stateDir,
          now: () => FIXED_NOW,
          refreshRun: () => ({ kind: "inactive", reason }),
        }),
      ).toEqual({ kind: "allow" });
      expect(loadBinding(stateDir, key)).toBeNull();
    },
  );

  test("denies once with a fallback reason when refresh fails unexpectedly and resets the counter", async () => {
    const { parseHookPayload } = await loadParseModule();
    const { bindingKeyFor, loadBinding, saveBinding } = await loadBindingsModule();
    const { evaluatePreToolUse } = await loadPreToolUseModule();
    const stateDir = makeTempDir("freefsm-copilot-refresh-failure-");
    const key = bindingKeyFor({ sessionId: "session-1", cwd: "/workspace/project" });

    saveBinding(stateDir, key, {
      sessionId: "session-1",
      cwd: "/workspace/project",
      runId: "run-1",
      rootDir: "/tmp/root",
      gatedToolCount: 9,
      updatedAt: FIXED_NOW,
    });

    const result = evaluatePreToolUse(
      parseHookPayload(rawPayload({ toolName: "view" })),
      {
        stateDir,
        now: () => FIXED_NOW,
        refreshRun: () => ({ kind: "error" }),
      },
    );

    expect(result).toEqual({
      kind: "deny",
      reason: "[FSM] Run `freefsm current` before continuing.",
    });
    expect(loadBinding(stateDir, key)?.gatedToolCount).toBe(0);
  });
});
