// Copyright 2026 The Agentic Trader (JP3 Labs)
// SPDX-License-Identifier: Apache-2.0

import { checkOrderText, readAccountType, readMaxLoss, type CheckLine } from "./rules.ts";

export { checkOrderText, LIMIT_CHECKS, ORDER_CHECKS, parseCheckInput } from "./rules.ts";
export type { CheckLine, OrderEvaluation } from "./rules.ts";

export type Verdict = "PASS" | "SEND-BACK";

export type CheckResult = {
  verdict: Verdict;
  reasons: string[];
  checks: CheckLine[];
};

export type CheckOptions = {
  /** When true, a live account type is allowed through this gate. Default is false. */
  allowLive?: boolean;
  /** When true, every order is SEND-BACK before the trading rules run. */
  killed?: boolean;
};

export const KILL_REASON = "Kill switch is on. New orders are blocked.";
export const LIVE_REFUSAL = "Live account type is refused. Paper first. Live stays off unless you enable it outside this check.";

const ON = new Set(["1", "true", "yes", "on"]);

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function line(id: string, name: string, pass: boolean, why: string): CheckLine {
  return { id, name, pass, why };
}

function finish(checks: CheckLine[]): CheckResult {
  const reasons = checks.filter((c) => !c.pass).map((c) => c.why);
  return { verdict: reasons.length === 0 ? "PASS" : "SEND-BACK", reasons, checks };
}

/** True when TRADING_HALT is 1, true, yes, or on, or the halt file is present. */
export function killSwitchOn(env: Record<string, string | undefined>, haltFileExists: boolean): boolean {
  const raw = (env.TRADING_HALT || "").trim().toLowerCase();
  if (ON.has(raw)) return true;
  return haltFileExists;
}

/** True only when ALLOW_LIVE is 1, true, yes, or on. Unset is false. */
export function liveEnabled(env: Record<string, string | undefined>): boolean {
  return ON.has((env.ALLOW_LIVE || "").trim().toLowerCase());
}

function accountLine(orderText: string, allowLive: boolean): CheckLine {
  const account = readAccountType(orderText);
  const name = "Account type is paper, or live is explicitly enabled";
  if (account === "paper") return line("account", name, true, "Account type: paper.");
  if (account === "live" && allowLive) return line("account", name, true, "Account type: live. Live is explicitly enabled.");
  if (account === "live") return line("account", name, false, LIVE_REFUSAL);
  if (!account) return line("account", name, false, "Account type is missing. It must be paper or live. Live is refused unless you enable it.");
  return line("account", name, false, "Account type is \"" + account.slice(0, 20) + "\". It must be paper or live.");
}

/**
 * Check one proposed order against a limits file.
 * The order's own max_loss is ignored. Max loss is read from the limits file.
 * LIVE_TRADING on the limits file must be off. A live account type is refused unless `allowLive` is true.
 * A killed check blocks everything and does not score the order.
 */
export function checkProposedOrder(order: unknown, limits: unknown, options: CheckOptions = {}): CheckResult {
  if (options.killed) {
    return finish([line("halt", "Kill switch is off", false, KILL_REASON)]);
  }

  const limitsText = asText(limits);
  const orderText = asText(order);
  const limitsResult = checkOrderText(limitsText, "");
  const maxLoss = !("error" in limitsResult) && limitsResult.mode === "limits" ? readMaxLoss(limitsText) : "";
  const orderResult = checkOrderText(orderText, maxLoss);
  const checks: CheckLine[] = [];

  if ("error" in orderResult) {
    checks.push(line("order", "Order JSON parses", false, orderResult.error));
  } else if (orderResult.mode !== "order") {
    checks.push(line("order", "Order JSON is one order", false, "That JSON is a limits file, not an order. An order names a side or a quantity."));
  } else {
    checks.push(accountLine(orderText, options.allowLive === true));
    checks.push(...orderResult.checks);
  }

  if ("error" in limitsResult) {
    checks.push(line("limits", "Limits JSON parses", false, limitsResult.error));
  } else if (limitsResult.mode !== "limits") {
    checks.push(line("limits", "Limits file is a limits file", false, "The limits file was read as an order. A limits file has no side or quantity."));
  } else {
    checks.push(...limitsResult.checks);
  }

  return finish(checks);
}
