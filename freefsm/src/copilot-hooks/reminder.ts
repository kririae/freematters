export type RefreshRunResult =
  | { kind: "active"; reminder: string }
  | { kind: "inactive"; reason?: string }
  | { kind: "error"; reason?: string };

interface ReminderData {
  state: string;
  prompt: string;
  transitions: Record<string, string>;
}

interface CurrentEnvelope {
  ok?: boolean;
  code?: string | null;
  data?: Record<string, unknown> | null;
}

const INACTIVE_CODES = new Set(["RUN_NOT_FOUND", "RUN_NOT_ACTIVE"]);
const PROMPT_MAX = 160;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function asString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Missing ${label} in freefsm current output.`);
}

function asTransitions(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Missing transitions in freefsm current output.");
  }

  const transitions: Record<string, string> = {};

  for (const [label, target] of Object.entries(value)) {
    if (typeof target !== "string") {
      throw new Error("Invalid transition target in freefsm current output.");
    }
    transitions[label] = target;
  }

  return transitions;
}

export function formatCompactReminder(data: ReminderData): string {
  const prompt = collapseWhitespace(data.prompt);
  const compactPrompt =
    prompt.length > PROMPT_MAX
      ? `${prompt.slice(0, PROMPT_MAX - 3).trimEnd()}...`
      : prompt;
  const transitions = Object.entries(data.transitions);

  if (transitions.length === 0) {
    return `[FSM ${data.state}] ${compactPrompt}`;
  }

  const summary = transitions
    .map(([label, target]) => `${label} → ${target}`)
    .join("; ");

  return `[FSM ${data.state}] ${compactPrompt} Next: ${summary}.`;
}

export function parseRefreshResult(raw: string): RefreshRunResult {
  let envelope: CurrentEnvelope;

  try {
    envelope = JSON.parse(raw) as CurrentEnvelope;
  } catch {
    throw new Error("Failed to parse freefsm current output as JSON.");
  }

  if (envelope.ok !== true) {
    if (typeof envelope.code === "string" && INACTIVE_CODES.has(envelope.code)) {
      return { kind: "inactive" };
    }

    throw new Error("freefsm current returned an unexpected error.");
  }

  const data = envelope.data;
  if (!data || typeof data !== "object") {
    throw new Error("freefsm current returned no data.");
  }

  if (data.run_status !== "active") {
    return { kind: "inactive" };
  }

  return {
    kind: "active",
    reminder: formatCompactReminder({
      state: asString(data.state, "state"),
      prompt: asString(data.prompt, "prompt"),
      transitions: asTransitions(data.transitions),
    }),
  };
}
