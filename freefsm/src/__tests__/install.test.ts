import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");

  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import { install } from "../commands/install.js";

const CLI = resolve(__dirname, "../../dist/cli.js");
const PACKAGE_ROOT = resolve(__dirname, "../..");
const COPILOT_PLUGIN_MANIFEST = JSON.stringify(
  {
    name: "freefsm",
    description: "CLI-first FSM runtime for agent workflows",
    skills: ["copilot/skills"],
    hooks: "copilot/hooks.json",
  },
  null,
  2,
);

function createCopilotHooksConfig(options?: {
  bash?: string;
  powershell?: string;
}): string {
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            bash: options?.bash ?? "node ./dist/copilot-hooks/pre-tool-use.js",
            powershell:
              options?.powershell ?? "node .\\dist\\copilot-hooks\\pre-tool-use.js",
            timeoutSec: 30,
          },
        ],
      },
    },
    null,
    2,
  );
}

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function cli(args: string): string {
  return execFileSync("node", [CLI, ...args.split(/\s+/)], {
    encoding: "utf-8",
  });
}

function hasCommand(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

// ─── Codex install ──────────────────────────────────────────────

const describeCodex = describe.skipIf(!hasCommand("codex"));

describeCodex("install codex", () => {
  const agentsDir = join(homedir(), ".agents", "skills");
  const target = join(agentsDir, "freefsm");
  const backup = `${target}.bak`;

  // Snapshot for restore
  let savedLink: string | null = null;
  let hadTarget = false;

  beforeAll(() => {
    if (existsSync(target)) {
      hadTarget = true;
      try {
        savedLink = readlinkSync(target);
      } catch {
        savedLink = null;
      }
    }
  });

  afterAll(() => {
    // Clean up test artifacts
    if (existsSync(target)) rmSync(target, { force: true });
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });

    // Restore original state
    if (hadTarget && savedLink) {
      mkdirSync(agentsDir, { recursive: true });
      symlinkSync(savedLink, target);
    }
  });

  test("creates symlink to skills directory", () => {
    // Clean slate
    if (existsSync(target)) rmSync(target, { force: true });

    const stdout = cli("install codex");
    expect(stdout).toContain("FreeFSM skills linked for Codex");

    expect(existsSync(target)).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(join(PACKAGE_ROOT, "skills"));
  });

  test("re-install updates existing symlink", () => {
    const stdout = cli("install codex");
    expect(stdout).toContain("Updating existing symlink");
    expect(stdout).toContain("FreeFSM skills linked for Codex");

    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(join(PACKAGE_ROOT, "skills"));
  });

  test("backs up non-symlink target", () => {
    // Replace symlink with a regular directory
    rmSync(target, { force: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker.txt"), "original");

    const stdout = cli("install codex");
    expect(stdout).toContain("Backed up");
    expect(stdout).toContain("FreeFSM skills linked for Codex");

    expect(lstatSync(target).isSymbolicLink()).toBe(true);

    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(join(backup, "marker.txt"), "utf-8")).toBe("original");
  });
});

// ─── Claude install ─────────────────────────────────────────────

const describeClaude = describe.skipIf(!hasCommand("claude"));

describeClaude("install claude", () => {
  const pluginsDir = join(homedir(), ".claude", "plugins");
  const knownPath = join(pluginsDir, "known_marketplaces.json");
  const installedPath = join(pluginsDir, "installed_plugins.json");
  const knownBackup = `${knownPath}.bak`;
  const installedBackup = `${installedPath}.bak`;

  beforeAll(() => {
    // Snapshot existing plugin state
    if (existsSync(knownPath)) copyFileSync(knownPath, knownBackup);
    if (existsSync(installedPath)) copyFileSync(installedPath, installedBackup);
  });

  afterAll(() => {
    // Restore original plugin state
    if (existsSync(knownBackup)) {
      copyFileSync(knownBackup, knownPath);
      rmSync(knownBackup);
    }
    if (existsSync(installedBackup)) {
      copyFileSync(installedBackup, installedPath);
      rmSync(installedBackup);
    }
  });

  test("registers marketplace and installs plugin", () => {
    const stdout = cli("install claude");
    expect(stdout).toContain("FreeFSM plugin installed for Claude Code");

    const known = JSON.parse(readFileSync(knownPath, "utf-8"));
    expect(known["freefsm-local"]).toBeDefined();
    expect(known["freefsm-local"].source.source).toBe("directory");
    expect(known["freefsm-local"].source.path).toBe(PACKAGE_ROOT);

    const installed = JSON.parse(readFileSync(installedPath, "utf-8"));
    expect(installed.plugins["freefsm@freefsm-local"]).toBeDefined();
    expect(installed.plugins["freefsm@freefsm-local"].length).toBeGreaterThan(0);
  });

  test("re-install succeeds without errors", () => {
    const stdout = cli("install claude");
    expect(stdout).toContain("FreeFSM plugin installed for Claude Code");
  });
});

// ─── Copilot install ────────────────────────────────────────────

describe("install copilot", () => {
  const originalHome = process.env.HOME;
  const tempRoots = new Set<string>();

  function createCopilotPackageFixture(options?: {
    plugin?: boolean;
    hooks?: boolean;
    buildOutput?: boolean;
    hooksConfig?: string;
  }): { packageRoot: string; hookEntrypoint: string } {
    const packageRoot = mkdtempSync(join(tmpdir(), "freefsm-copilot-install-"));
    const hookEntrypoint = join(
      packageRoot,
      "dist",
      "copilot-hooks",
      "pre-tool-use.js",
    );
    tempRoots.add(packageRoot);

    mkdirSync(join(packageRoot, "copilot", "skills", "freefsm-create"), {
      recursive: true,
    });
    writeFileSync(
      join(packageRoot, "copilot", "skills", "freefsm-create", "SKILL.md"),
      "---\nname: freefsm-create\ndescription: start.\n---\n",
    );

    if (options?.plugin !== false) {
      writeFileSync(join(packageRoot, "plugin.json"), COPILOT_PLUGIN_MANIFEST);
    }

    if (options?.hooks !== false) {
      mkdirSync(join(packageRoot, "copilot"), { recursive: true });
      writeFileSync(
        join(packageRoot, "copilot", "hooks.json"),
        options?.hooksConfig ?? createCopilotHooksConfig(),
      );
    }

    if (options?.buildOutput !== false) {
      mkdirSync(join(packageRoot, "dist", "copilot-hooks"), { recursive: true });
      writeFileSync(hookEntrypoint, "export {};\n");
    }

    return { packageRoot, hookEntrypoint };
  }

  function runInstallExpectingFailure(packageRoot: string): string {
    const errorLines: string[] = [];
    const execSpy = vi.mocked(execFileSync);
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errorLines.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new ExitError(Number(code ?? 0));
    });

    let thrown: unknown;
    try {
      install("copilot", packageRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExitError);
    expect((thrown as ExitError).code).toBe(2);
    expect(execSpy).not.toHaveBeenCalled();
    return errorLines.join("\n");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const tempHome = mkdtempSync(join(tmpdir(), "freefsm-copilot-home-"));
    tempRoots.add(tempHome);
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }

    for (const tempRoot of tempRoots) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  test("invokes copilot plugin install for the package root", () => {
    const { packageRoot } = createCopilotPackageFixture();
    const logLines: string[] = [];
    const execSpy = vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(""));
    const homeDir = process.env.HOME ?? "";
    const copilotSkillsTarget = join(homeDir, ".copilot", "skills", "freefsm");
    const copilotExtensionsTarget = join(homeDir, ".copilot", "extensions", "freefsm");

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logLines.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    install("copilot", packageRoot);

    const output = logLines.join("\n");

    expect(execSpy).toHaveBeenCalledWith(
      "copilot",
      ["plugin", "install", packageRoot],
      { stdio: "inherit" },
    );
    expect(output).toContain("Installing Copilot plugin");
    expect(output).toContain("FreeFSM plugin installed for Copilot CLI");
    expect(output).not.toContain("linked");
    expect(existsSync(copilotSkillsTarget)).toBe(false);
    expect(existsSync(copilotExtensionsTarget)).toBe(false);
  });

  test("fails clearly when plugin.json is missing", () => {
    const { packageRoot } = createCopilotPackageFixture({ plugin: false });

    const output = runInstallExpectingFailure(packageRoot);

    expect(output).toContain("Copilot plugin manifest not found");
    expect(output).toContain(join(packageRoot, "plugin.json"));
  });

  test("fails clearly when copilot/hooks.json is missing", () => {
    const { packageRoot } = createCopilotPackageFixture({ hooks: false });

    const output = runInstallExpectingFailure(packageRoot);

    expect(output).toContain("Copilot hooks config not found");
    expect(output).toContain(join(packageRoot, "copilot", "hooks.json"));
  });

  test("fails clearly when built Copilot hook entrypoints are missing", () => {
    const { packageRoot, hookEntrypoint } = createCopilotPackageFixture({
      buildOutput: false,
    });

    const output = runInstallExpectingFailure(packageRoot);

    expect(output).toContain("Copilot hook entrypoint not found");
    expect(output).toContain(hookEntrypoint);
    expect(output).toContain("npm run build");
  });

  test("fails clearly when hook entrypoints are not rooted at dist/copilot-hooks", () => {
    const invalidHookPath = "./scripts/../../dist/copilot-hooks/pre-tool-use.js";
    const { packageRoot } = createCopilotPackageFixture({
      hooksConfig: createCopilotHooksConfig({
        bash: `node ${invalidHookPath}`,
      }),
    });

    const output = runInstallExpectingFailure(packageRoot);

    expect(output).toContain(
      "Copilot hook entrypoint must be rooted at dist/copilot-hooks/",
    );
    expect(output).toContain(invalidHookPath);
  });
});

// ─── End-to-end workflow ────────────────────────────────────────

const HELLO_WORKFLOW = `\
version: 1
guide: "Say hello workflow"
initial: greet
states:
  greet:
    prompt: "Say hello to the user."
    transitions:
      next: done
  done:
    prompt: "Say goodbye."
    transitions: {}
`;

describe("workflow e2e after install", () => {
  let tmp: string;
  let fsmPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "freefsm-install-e2e-"));
    fsmPath = join(tmp, "hello.yaml");
    writeFileSync(fsmPath, HELLO_WORKFLOW, "utf-8");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("create workflow yaml and start a run", () => {
    // Verify the workflow file was created
    expect(existsSync(fsmPath)).toBe(true);
    const yaml = readFileSync(fsmPath, "utf-8");
    expect(yaml).toContain("Say hello workflow");
    expect(yaml).toContain("greet");
    expect(yaml).toContain("done");

    // Start a run using the workflow
    const root = join(tmp, "root");
    const startOut = cli(`start ${fsmPath} --run-id hello-run --root ${root}`);
    expect(startOut).toContain("FSM started.");
    expect(startOut).toContain("You are in **greet** state.");
    expect(startOut).toContain("Say hello to the user.");
    expect(startOut).toContain("next → done");

    // Verify current state
    const currentOut = cli(`current --run-id hello-run --root ${root}`);
    expect(currentOut).toContain("You are in **greet** state.");

    // Transition to done
    const gotoOut = cli(`goto done --run-id hello-run --on next --root ${root}`);
    expect(gotoOut).toContain("You are in **done** state.");
    expect(gotoOut).toContain("Say goodbye.");
  });

  test("start with JSON output", () => {
    const root = join(tmp, "root-json");
    const stdout = cli(`start ${fsmPath} --run-id hello-json -j --root ${root}`);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.state).toBe("greet");
    expect(envelope.data.prompt).toBe("Say hello to the user.");
    expect(envelope.data.transitions).toEqual({ next: "done" });
  });
});
