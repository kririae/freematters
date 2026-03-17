import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type BindingKey, bindingKeyFor } from "./bindings.js";

export interface ParsedHookPayload {
  sessionId?: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  bindingKey: BindingKey;
}

export type ToolClassification =
  | {
      kind: "freefsm-start";
      counted: false;
      runId?: string;
      rootDir?: string;
    }
  | {
      kind: "freefsm-reset";
      counted: false;
      action: "goto" | "finish";
    }
  | {
      kind: "counted";
      counted: true;
    };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }

  return asRecord(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

export function parseHookPayload(raw: unknown): ParsedHookPayload {
  const payload = asRecord(raw);
  const toolInput = parseToolInput(
    payload.toolInput ?? payload.toolArgs ?? payload.tool_input,
  );
  const sessionId = firstString(payload.sessionId, payload.session_id);
  const cwd = firstString(payload.cwd, payload.workingDirectory) ?? process.cwd();
  const toolName = (
    firstString(payload.toolName, payload.tool_name) ?? ""
  ).toLowerCase();

  return {
    sessionId,
    cwd,
    toolName,
    toolInput,
    bindingKey: bindingKeyFor({ sessionId, cwd }),
  };
}

export function extractBashCommand(input: ParsedHookPayload): string {
  return typeof input.toolInput.command === "string" ? input.toolInput.command : "";
}

export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length === 0) {
      return;
    }

    tokens.push(current);
    current = "";
  };

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === "`") {
      if (char === "`") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  pushCurrent();
  return tokens;
}

function isFreefsmExecutable(token: string): boolean {
  const normalized = token.replaceAll("\\", "/");
  return basename(normalized) === "freefsm";
}

function extractFlag(tokens: string[], name: string): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === name) {
      return tokens[index + 1];
    }

    if (token.startsWith(`${name}=`)) {
      return token.slice(name.length + 1);
    }
  }

  return undefined;
}

function resolveRoot(flagRoot?: string): string {
  if (flagRoot) {
    return resolve(flagRoot);
  }

  if (process.env.FREEFSM_ROOT) {
    return resolve(process.env.FREEFSM_ROOT);
  }

  return join(homedir(), ".freefsm");
}

// Find the freefsm executable in tokens and return the index of its subcommand.
// Handles prefixed invocations like `rtk freefsm start ...`.
function findFreefsmSubcommandIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (isFreefsmExecutable(tokens[i])) {
      return i + 1;
    }
  }
  return -1;
}

export function classifyToolCall(input: ParsedHookPayload): ToolClassification {
  if (input.toolName === "bash") {
    const tokens = tokenizeShellCommand(extractBashCommand(input));
    const subIdx = findFreefsmSubcommandIndex(tokens);

    if (subIdx >= 0) {
      const subcommand = tokens[subIdx];

      if (subcommand === "start") {
        return {
          kind: "freefsm-start",
          counted: false,
          runId: extractFlag(tokens, "--run-id"),
          rootDir: resolveRoot(extractFlag(tokens, "--root")),
        };
      }

      if (subcommand === "goto") {
        return { kind: "freefsm-reset", counted: false, action: "goto" };
      }

      if (subcommand === "finish") {
        return { kind: "freefsm-reset", counted: false, action: "finish" };
      }
    }
  }

  return { kind: "counted", counted: true };
}
