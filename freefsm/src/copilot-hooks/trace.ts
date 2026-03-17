import { appendFileSync } from "node:fs";

export const TRACE_PREFIX = "FREEFSM_E2E_TRACE";

export function trace(message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.FREEFSM_COPILOT_E2E_TRACE !== "1") {
    return;
  }

  const traceFile = env.FREEFSM_COPILOT_E2E_TRACE_FILE;
  if (!traceFile) {
    return;
  }

  appendFileSync(traceFile, `${TRACE_PREFIX} ${message}\n`, "utf-8");
}
