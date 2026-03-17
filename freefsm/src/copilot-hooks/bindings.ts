import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BindingKey =
  | { kind: "session"; value: string }
  | { kind: "cwd"; value: string };

export interface BindingIdentity {
  sessionId?: string;
  cwd: string;
}

export interface HookBinding {
  sessionId?: string;
  cwd: string;
  runId: string;
  rootDir: string;
  gatedToolCount: number;
  updatedAt: string;
}

export interface ResolvedBinding {
  binding: HookBinding;
  key: BindingKey;
}

export function bindingKeyFor(identity: BindingIdentity): BindingKey {
  if (identity.sessionId && identity.sessionId.trim().length > 0) {
    return { kind: "session", value: identity.sessionId };
  }

  return { kind: "cwd", value: identity.cwd };
}

function uniqueBindingKeys(keys: BindingKey[]): BindingKey[] {
  const seen = new Set<string>();
  const unique: BindingKey[] = [];

  for (const key of keys) {
    const id = `${key.kind}:${key.value}`;
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    unique.push(key);
  }

  return unique;
}

export function lookupBindingKeys(identity: BindingIdentity): BindingKey[] {
  const keys: BindingKey[] = [];

  if (identity.sessionId && identity.sessionId.trim().length > 0) {
    keys.push({ kind: "session", value: identity.sessionId });
  }

  keys.push({ kind: "cwd", value: identity.cwd });
  return uniqueBindingKeys(keys);
}

export function bindingAliases(binding: HookBinding): BindingKey[] {
  const keys: BindingKey[] = [];

  if (binding.sessionId && binding.sessionId.trim().length > 0) {
    keys.push({ kind: "session", value: binding.sessionId });
  }

  keys.push({ kind: "cwd", value: binding.cwd });
  return uniqueBindingKeys(keys);
}

export function defaultBindingsDir(homeDir = homedir()): string {
  return join(homeDir, ".copilot", "state", "freefsm");
}

function sessionFileStem(sessionId: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return sessionId;
  }

  return createHash("sha256").update(sessionId).digest("hex");
}

function cwdFileStem(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

export function bindingPathFor(stateDir: string, key: BindingKey): string {
  const fileName =
    key.kind === "session"
      ? `session-${sessionFileStem(key.value)}.json`
      : `cwd-${cwdFileStem(key.value)}.json`;

  return join(stateDir, fileName);
}

export function loadBinding(stateDir: string, key: BindingKey): HookBinding | null {
  const path = bindingPathFor(stateDir, key);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<HookBinding>;

    if (
      typeof raw.cwd !== "string" ||
      typeof raw.runId !== "string" ||
      typeof raw.rootDir !== "string" ||
      typeof raw.gatedToolCount !== "number" ||
      typeof raw.updatedAt !== "string"
    ) {
      return null;
    }

    return {
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
      cwd: raw.cwd,
      runId: raw.runId,
      rootDir: raw.rootDir,
      gatedToolCount: raw.gatedToolCount,
      updatedAt: raw.updatedAt,
    };
  } catch {
    return null;
  }
}

export function resolveBinding(
  stateDir: string,
  identity: BindingIdentity,
): ResolvedBinding | null {
  for (const key of lookupBindingKeys(identity)) {
    const binding = loadBinding(stateDir, key);
    if (binding) {
      if (
        key.kind === "cwd" &&
        identity.sessionId &&
        binding.sessionId &&
        binding.sessionId !== identity.sessionId
      ) {
        continue;
      }

      return { binding, key };
    }
  }

  return null;
}

export function saveBinding(
  stateDir: string,
  key: BindingKey,
  binding: HookBinding,
): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    bindingPathFor(stateDir, key),
    JSON.stringify(binding, null, 2),
    "utf-8",
  );
}

export function removeBinding(stateDir: string, key: BindingKey): void {
  rmSync(bindingPathFor(stateDir, key), { force: true });
}

export function replaceBinding(
  stateDir: string,
  previous: HookBinding | null,
  next: HookBinding,
): void {
  if (previous) {
    for (const key of bindingAliases(previous)) {
      removeBinding(stateDir, key);
    }
  }

  for (const key of bindingAliases(next)) {
    saveBinding(stateDir, key, next);
  }
}

export function removeResolvedBinding(stateDir: string, binding: HookBinding): void {
  for (const key of bindingAliases(binding)) {
    removeBinding(stateDir, key);
  }
}
