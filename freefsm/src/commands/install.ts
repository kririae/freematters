import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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

function getPackageRoot(): string {
  // dist/commands/install.js is two levels deep under package root
  const thisDir = dirname(new URL(import.meta.url).pathname);
  return resolve(thisDir, "..", "..");
}

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

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "inherit" });
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
  const skillsSource = join(packageRoot, "skills");
  const copilotSource = join(packageRoot, "copilot");
  const copilotSkillsDir = join(homedir(), ".copilot", "skills");
  const copilotExtensionsDir = join(homedir(), ".copilot", "extensions");
  const skillsTarget = join(copilotSkillsDir, PLUGIN_NAME);
  const extensionsTarget = join(copilotExtensionsDir, PLUGIN_NAME);

  if (!existsSync(skillsSource)) {
    console.error(`Skills directory not found: ${skillsSource}`);
    process.exit(2);
  }

  if (!existsSync(copilotSource)) {
    console.error(`Copilot directory not found: ${copilotSource}`);
    console.error(
      "\nThis appears to be an older version of freefsm without Copilot CLI support.",
    );
    console.error(
      "Please upgrade to the latest version: npm install -g @freematters/freefsm",
    );
    process.exit(2);
  }

  mkdirSync(copilotSkillsDir, { recursive: true });
  mkdirSync(copilotExtensionsDir, { recursive: true });

  linkTarget(skillsSource, skillsTarget, "Skills linked");
  linkTarget(copilotSource, extensionsTarget, "Extensions linked");

  console.log("\nFreeFSM extensions linked for Copilot.");
  console.log(
    "\nSkills: /freefsm:create, /freefsm:start, /freefsm:current, /freefsm:finish",
  );
  console.log("Hook: PostToolUse state reminder (every 5 tool calls)");
  console.log("\nRestart or reload the Copilot CLI to activate the extensions.");
}
