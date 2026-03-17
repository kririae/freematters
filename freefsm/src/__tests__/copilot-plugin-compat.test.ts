import { execFileSync } from "node:child_process";
import {
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");

  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import { install } from "../commands/install.js";

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

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function createCopilotHooksConfig(): string {
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            bash: "node ./dist/copilot-hooks/pre-tool-use.js",
            powershell: "node .\\dist\\copilot-hooks\\pre-tool-use.js",
            timeoutSec: 30,
          },
        ],
      },
    },
    null,
    2,
  );
}

function writeSkillFixture(
  packageRoot: string,
  dirName: string,
  skillName: string,
): void {
  const skillDir = join(packageRoot, "copilot", "skills", dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${skillName} skill.\n---\n`,
  );
}

function createCopilotPackageFixture(
  skillDir = "freefsm-create",
  skillName = skillDir,
): string {
  const packageRoot = mkdtempSync(join(tmpdir(), "freefsm-copilot-plugin-compat-"));

  mkdirSync(join(packageRoot, "copilot"), { recursive: true });
  mkdirSync(join(packageRoot, "dist", "copilot-hooks"), { recursive: true });

  writeSkillFixture(packageRoot, skillDir, skillName);
  writeFileSync(join(packageRoot, "plugin.json"), COPILOT_PLUGIN_MANIFEST);
  writeFileSync(join(packageRoot, "copilot", "hooks.json"), createCopilotHooksConfig());
  writeFileSync(
    join(packageRoot, "dist", "copilot-hooks", "pre-tool-use.js"),
    "export {};\n",
  );

  return packageRoot;
}

function runInstallExpectingFailure(packageRoot: string): string {
  const errorLines: string[] = [];
  const execSpy = vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));

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

describe("copilot plugin compatibility", () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const tempRoot of tempRoots) {
      if (existsSync(tempRoot)) {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
    tempRoots.length = 0;
  });

  test("ships Copilot-compatible skill names", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "plugin.json"), "utf-8"),
    ) as {
      skills?: string[];
    };

    expect(manifest.skills).toEqual(["copilot/skills"]);

    const skillDirs = readdirSync(join(PACKAGE_ROOT, "copilot", "skills"));

    for (const skillDir of skillDirs) {
      const skillSource = readFileSync(
        join(PACKAGE_ROOT, "copilot", "skills", skillDir, "SKILL.md"),
        "utf-8",
      );
      const match = skillSource.match(/^name:\s+(.+)$/m);

      expect(match?.[1]).toBe(skillDir);
      expect(match?.[1]).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("rejects invalid Copilot skill names before install", () => {
    const packageRoot = createCopilotPackageFixture("freefsm-create", "freefsm:create");
    tempRoots.push(packageRoot);

    const output = runInstallExpectingFailure(packageRoot);

    expect(output).toContain("Copilot skill name must match its directory name");
    expect(output).toContain("freefsm:create");
  });

  test('uses wrapper-local copilot manifest and package includes it', () => {
    const wrapperPath = join(PACKAGE_ROOT, '.copilot-plugin', 'plugin.json');
    expect(existsSync(wrapperPath)).toBe(true);

    const wrapper = JSON.parse(readFileSync(wrapperPath, 'utf-8')) as {
      name?: string;
      skills?: string[];
      hooks?: string;
    };

    expect(wrapper).toMatchObject({ name: 'freefsm', skills: ['skills'], hooks: 'hooks.json' });

    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'),
    ) as {
      files?: string[];
    };

    expect(pkg.files).toContain('.copilot-plugin/');

    // create an npm pack (ignore scripts to avoid build) and inspect the produced tarball
    execFileSync('npm', ['pack', '--silent', '--ignore-scripts'], { cwd: PACKAGE_ROOT });

    const pkgMeta = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { name: string; version: string };
    const tarballName = `${pkgMeta.name.replace('@', '').replace('/', '-')}-${pkgMeta.version}.tgz`;
    const tarballPath = join(PACKAGE_ROOT, tarballName);

    const tarContent = readFileSync(tarballPath);

    const tarText = tarContent.toString('utf-8');

    expect(tarText).toContain('package/.copilot-plugin/plugin.json');
    expect(tarText).not.toContain('package/plugin.json');

    rmSync(tarballPath);

  });

});
