import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI = resolve(__dirname, "../../dist/cli.js");
const SHOULD_RUN = process.env.FREEFSM_RUN_COPILOT_E2E === "1";
const TEST_MODEL = process.env.FREEFSM_COPILOT_E2E_MODEL ?? "gpt-5-mini";
const execFile = promisify(execFileCallback);

function hasCommand(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function run(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      stdio: "pipe",
      ...options,
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    throw new Error(
      [
        `Command failed: ${cmd} ${args.join(" ")}`,
        `status: ${e.status ?? "unknown"}`,
        "--- stdout ---",
        e.stdout ?? "",
        "--- stderr ---",
        e.stderr ?? "",
      ].join("\n"),
    );
  }
}

async function runAsync(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
): Promise<string> {
  try {
    const { stdout } = await execFile(cmd, args, {
      encoding: "utf-8",
      ...options,
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    throw new Error(
      [
        `Command failed: ${cmd} ${args.join(" ")}`,
        `code: ${e.code ?? "unknown"}`,
        "--- stdout ---",
        e.stdout ?? "",
        "--- stderr ---",
        e.stderr ?? "",
      ].join("\n"),
    );
  }
}

function writeFreefsmWrapper(binDir: string): void {
  const wrapperPath = join(binDir, "freefsm");
  writeFileSync(wrapperPath, `#!/usr/bin/env bash\nnode "${CLI}" "$@"\n`, "utf-8");
  chmodSync(wrapperPath, 0o755);
}

function writeWorkflow(workflowPath: string): void {
  writeFileSync(
    workflowPath,
    `\
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
`,
    "utf-8",
  );
}

function seedFallbackBinding(stateDir: string, cwd: string, rootDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, `cwd-${createHash("sha256").update(cwd).digest("hex")}.json`),
    JSON.stringify(
      {
        cwd,
        runId: "e2e-run",
        rootDir,
        gatedToolCount: 9,
        updatedAt: "2026-03-16T12:34:56.000Z",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function readArtifacts(sharePath: string, logDir: string): string {
  const parts: string[] = [];

  if (existsSync(sharePath)) {
    parts.push(readFileSync(sharePath, "utf-8"));
  }

  if (existsSync(logDir)) {
    for (const file of readdirSync(logDir)) {
      parts.push(readFileSync(join(logDir, file), "utf-8"));
    }
  }

  return parts.join("\n---\n");
}

const describeCopilotE2E = describe.skipIf(!SHOULD_RUN || !hasCommand("copilot"));

describeCopilotE2E("copilot e2e automation", () => {
  let tmpHome: string;
  let tmpConfigDir: string;
  let tmpBin: string;
  let workspace: string;
  let rootDir: string;
  let workflowPath: string;
  let sharePath: string;
  let logDir: string;
  let traceFile: string;

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "freefsm-copilot-e2e-"));
    tmpConfigDir = join(tmpHome, ".copilot");
    tmpBin = join(tmpHome, "bin");
    workspace = join(tmpHome, "workspace");
    rootDir = join(tmpHome, "root");
    workflowPath = join(workspace, "workflow.yaml");
    sharePath = join(tmpHome, "copilot-session.md");
    logDir = join(tmpHome, "copilot-logs");
    traceFile = join(tmpHome, "freefsm-trace.log");

    mkdirSync(tmpConfigDir, { recursive: true });
    mkdirSync(tmpBin, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFreefsmWrapper(tmpBin);
    writeWorkflow(workflowPath);
  });

  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("installs the plugin, surfaces deny feedback, and completes the workflow", async () => {
    const env = {
      ...process.env,
      HOME: tmpHome,
      PATH: `${tmpBin}:${process.env.PATH ?? ""}`,
      FREEFSM_COPILOT_E2E_TRACE: "1",
      FREEFSM_COPILOT_E2E_TRACE_FILE: traceFile,
    };

    const installOut = run("node", [CLI, "install", "copilot"], { env });
    expect(installOut).toContain("FreeFSM plugin installed for Copilot CLI.");

    const pluginList = run(
      "copilot",
      ["--config-dir", tmpConfigDir, "plugin", "list"],
      { env },
    );
    expect(pluginList).toContain("freefsm");

    const startOut = run(
      "node",
      [CLI, "start", workflowPath, "--run-id", "e2e-run", "--root", rootDir],
      { cwd: workspace, env },
    );
    expect(startOut).toContain("FSM started. Copilot e2e workflow");

    seedFallbackBinding(join(tmpConfigDir, "state", "freefsm"), workspace, rootDir);

    const prompt = [
      "Use only the bash tool.",
      "Make exactly one bash tool call per numbered step.",
      "Do not combine commands.",
      "A denied tool call still counts as that step being complete.",
      "If any tool call is denied, do not retry it; continue to the next numbered step.",
      "1. printf 'one\\n'",
      `2. freefsm goto done --run-id e2e-run --on next --root ${rootDir}`,
      "3. Reply with exactly DONE.",
    ].join(" ");

    const out = await runAsync(
      "copilot",
      [
        "--config-dir",
        tmpConfigDir,
        "--model",
        TEST_MODEL,
        "--allow-all",
        "--output-format",
        "text",
        "--log-dir",
        logDir,
        `--share=${sharePath}`,
        "-p",
        prompt,
      ],
      {
        cwd: workspace,
        env,
        timeout: 180000,
      },
    );

    expect(existsSync(traceFile)).toBe(true);
    const traceContent = readFileSync(traceFile, "utf-8");
    expect(traceContent).toContain("FREEFSM_E2E_TRACE pre-tool-use-invoked");
    expect(traceContent).toContain("FREEFSM_E2E_TRACE reminder-fired e2e-run");
    expect(traceContent).toContain("FREEFSM_E2E_TRACE counter-reset goto");

    const combinedOutput = [out, readArtifacts(sharePath, logDir)]
      .filter(Boolean)
      .join("\n---\n");
    expect(combinedOutput).not.toContain("skills failed to load");
    expect(combinedOutput).toContain(
      "Denied by preToolUse hook: [FSM plan] Plan the work. Next: next → done.",
    );
    expect(combinedOutput).toContain("DONE");

    const snapshot = JSON.parse(
      readFileSync(join(rootDir, "runs", "e2e-run", "snapshot.json"), "utf-8"),
    ) as { run_status?: string; state?: string };
    expect(snapshot).toMatchObject({
      run_status: "completed",
      state: "done",
    });
  }, 180000);
});
