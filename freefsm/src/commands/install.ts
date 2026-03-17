import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Platform = "claude" | "codex" | "copilot";

const MARKETPLACE_NAME = "freefsm-local";
const PLUGIN_NAME = "freefsm";
const COPILOT_PLUGIN_MANIFEST = "plugin.json";
const COPILOT_HOOKS_CONFIG = "copilot/hooks.json";
const COPILOT_SKILL_NAME = /^[a-z0-9-]+$/;

type CopilotPluginManifest = {
  hooks?: string | Record<string, unknown>;
  skills?: unknown;
};

type CopilotHookDefinition = {
  type?: string;
  bash?: string;
  powershell?: string;
};

type CopilotHooksConfig = {
  hooks?: Record<string, CopilotHookDefinition[] | undefined>;
};

type CopilotHookEntrypointExtraction = {
  entrypoints: string[];
  invalidEntrypoints: string[];
};

function getPackageRoot(): string {
  // dist/commands/install.js is two levels deep under package root
  const thisDir = dirname(new URL(import.meta.url).pathname);
  return resolve(thisDir, "..", "..");
}

export function install(platform: Platform, packageRoot = getPackageRoot()): void {
  if (platform === "claude") {
    installClaude(packageRoot);
  } else if (platform === "codex") {
    installCodex(packageRoot);
  } else {
    installCopilot(packageRoot);
  }
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function failInstall(lines: string | string[]): never {
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    console.error(line);
  }
  process.exit(2);
}

function readJsonFile<T>(path: string, missingLabel: string): T {
  if (!existsSync(path)) {
    failInstall(`${missingLabel}: ${path}`);
  }

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failInstall([`Failed to parse JSON: ${path}`, message]);
  }
}

function extractShellTokens(command: string): string[] {
  const tokens: string[] = [];

  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }

  return tokens;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }

  return value;
}

function extractSkillName(skillSource: string): string | null {
  const match = skillSource.match(/^name:\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function validateCopilotSkills(
  packageRoot: string,
  pluginManifest: CopilotPluginManifest,
): void {
  const skillDirs = asStringArray(pluginManifest.skills);

  if (!skillDirs || skillDirs.length === 0) {
    failInstall(
      'plugin.json must define Copilot skills via a non-empty "skills" array.',
    );
  }

  const errors: string[] = [];

  for (const skillDirPath of skillDirs) {
    const skillsSource = join(packageRoot, skillDirPath);

    if (!existsSync(skillsSource)) {
      errors.push(`Copilot skills directory not found: ${skillsSource}`);
      continue;
    }

    const skillDirsInPath = readdirSync(skillsSource, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory(),
    );

    if (skillDirsInPath.length === 0) {
      errors.push(
        `Copilot skills directory must contain at least one skill: ${skillsSource}`,
      );
      continue;
    }

    for (const skillDir of skillDirsInPath) {
      const skillFile = join(skillsSource, skillDir.name, "SKILL.md");

      if (!existsSync(skillFile)) {
        errors.push(`Copilot skill file not found: ${skillFile}`);
        continue;
      }

      const skillName = extractSkillName(readFileSync(skillFile, "utf-8"));

      if (!skillName) {
        errors.push(`Copilot skill is missing a name field: ${skillFile}`);
        continue;
      }

      if (skillName !== skillDir.name) {
        errors.push(
          `Copilot skill name must match its directory name: ${skillFile} (name: ${skillName}, directory: ${skillDir.name})`,
        );
      }

      if (!COPILOT_SKILL_NAME.test(skillName)) {
        errors.push(
          `Copilot skill name must contain only lowercase letters, numbers, and hyphens: ${skillFile} (name: ${skillName})`,
        );
      }
    }
  }

  if (errors.length > 0) {
    failInstall(errors);
  }
}

function extractCopilotHookEntrypoints(
  hooks: CopilotHookDefinition[],
  packageRoot: string,
): CopilotHookEntrypointExtraction {
  const entrypoints = new Set<string>();
  const invalidEntrypoints = new Set<string>();

  for (const hook of hooks) {
    for (const command of [hook.bash, hook.powershell]) {
      if (typeof command !== "string") {
        continue;
      }

      for (const token of extractShellTokens(command)) {
        const normalizedToken = token.replaceAll("\\", "/");

        if (normalizedToken.startsWith("./dist/copilot-hooks/")) {
          entrypoints.add(resolve(packageRoot, normalizedToken.slice(2)));
          continue;
        }

        if (normalizedToken.startsWith("dist/copilot-hooks/")) {
          entrypoints.add(resolve(packageRoot, normalizedToken));
          continue;
        }

        if (normalizedToken.includes("dist/copilot-hooks/")) {
          invalidEntrypoints.add(token);
        }
      }
    }
  }

  return {
    entrypoints: [...entrypoints],
    invalidEntrypoints: [...invalidEntrypoints],
  };
}

function validateCopilotPluginAssets(packageRoot: string): void {
  const pluginManifestPath = join(packageRoot, COPILOT_PLUGIN_MANIFEST);

  const pluginManifest = readJsonFile<CopilotPluginManifest>(
    pluginManifestPath,
    "Copilot plugin manifest not found",
  );

  validateCopilotSkills(packageRoot, pluginManifest);

  if (pluginManifest.hooks !== COPILOT_HOOKS_CONFIG) {
    failInstall(
      `plugin.json must set "hooks" to "${COPILOT_HOOKS_CONFIG}" for Copilot installation.`,
    );
  }

  const hooksConfigPath = join(packageRoot, pluginManifest.hooks);
  const hooksConfig = readJsonFile<CopilotHooksConfig>(
    hooksConfigPath,
    "Copilot hooks config not found",
  );
  const registeredHooks = Object.keys(hooksConfig.hooks ?? {});

  if (registeredHooks.length !== 1 || registeredHooks[0] !== "preToolUse") {
    failInstall("copilot/hooks.json must register only preToolUse hooks for now.");
  }

  const preToolHooks = hooksConfig.hooks?.preToolUse;

  if (!Array.isArray(preToolHooks) || preToolHooks.length === 0) {
    failInstall("copilot/hooks.json must define at least one preToolUse hook.");
  }

  const { entrypoints, invalidEntrypoints } = extractCopilotHookEntrypoints(
    preToolHooks,
    packageRoot,
  );

  if (invalidEntrypoints.length > 0) {
    failInstall([
      ...invalidEntrypoints.map(
        (entrypoint) =>
          `Copilot hook entrypoint must be rooted at dist/copilot-hooks/: ${entrypoint}`,
      ),
      "Use dist/copilot-hooks/... or ./dist/copilot-hooks/... in copilot/hooks.json.",
    ]);
  }

  if (entrypoints.length === 0) {
    failInstall(
      "copilot/hooks.json must reference built hook entrypoints rooted at dist/copilot-hooks/.",
    );
  }

  const missingEntrypoints = entrypoints.filter(
    (entrypoint) => !existsSync(entrypoint),
  );

  if (missingEntrypoints.length > 0) {
    failInstall([
      ...missingEntrypoints.map(
        (entrypoint) => `Copilot hook entrypoint not found: ${entrypoint}`,
      ),
      "Run `npm run build` after the Copilot hooks are built under dist/copilot-hooks/.",
    ]);
  }
}

function linkTarget(source: string, target: string, label: string): void {
  // Replace existing target, backing up if it's not a symlink
  if (existsSync(target)) {
    try {
      readlinkSync(target);
      // It's a symlink — safe to remove and update
      unlinkSync(target);
      console.log(`Updating existing symlink: ${target}`);
    } catch {
      // Not a symlink — back it up
      const backup = `${target}.bak`;
      // Remove old backup if it exists
      if (existsSync(backup)) {
        rmSync(backup, { recursive: true, force: true });
      }
      renameSync(target, backup);
      console.log(`Backed up ${target} -> ${backup}`);
    }
  }

  symlinkSync(source, target);
  console.log(`${label}: ${target} -> ${source}`);
}

function installClaude(packageRoot: string): void {
  const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  // Register the local directory as a marketplace
  console.log(`Adding marketplace ${MARKETPLACE_NAME} -> ${packageRoot}`);
  run("claude", ["plugin", "marketplace", "add", packageRoot]);

  // Install the plugin from the marketplace
  console.log(`\nInstalling plugin ${pluginKey}`);
  run("claude", ["plugin", "install", pluginKey]);

  console.log("\nFreeFSM plugin installed for Claude Code.");
  console.log(
    "\nSkills: /freefsm:create, /freefsm:start, /freefsm:current, /freefsm:finish",
  );
  console.log("Hook: PostToolUse state reminder (every 5 tool calls)");
  console.log("\nRestart Claude Code to activate the plugin.");
}

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

function installCopilot(packageRoot: string): void {
  validateCopilotPluginAssets(packageRoot);

  console.log(`Installing Copilot plugin from ${packageRoot}`);
  run("copilot", ["plugin", "install", packageRoot]);

  console.log("\nFreeFSM plugin installed for Copilot CLI.");
  console.log(
    "\nSkills: /freefsm-create, /freefsm-start, /freefsm-current, /freefsm-finish",
  );
  console.log("Hook: preToolUse Copilot plugin hook");
  console.log("\nRestart or reload the Copilot CLI to activate the plugin.");
}
