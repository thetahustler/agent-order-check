// Copyright 2026 The Agentic Trader (JP3 Labs)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProposedOrder, KILL_REASON, LIVE_REFUSAL, liveEnabled, killSwitchOn } from "../src/index.ts";
import { checkOrderText } from "../src/rules.ts";

const root = join(import.meta.dir, "..");
const limits = JSON.parse(readFileSync(join(root, "examples/limits.json"), "utf8"));
const passOrder = JSON.parse(readFileSync(join(root, "examples/pass-order.json"), "utf8"));
const sendBackOrder = JSON.parse(readFileSync(join(root, "examples/send-back-order.json"), "utf8"));

const good = {
  symbol: "SPY",
  asset_class: "equity",
  side: "buy",
  qty: 10,
  type: "limit",
  limit_price: 500,
  time_in_force: "day",
  order_class: "bracket",
  take_profit: { limit_price: 506 },
  stop_loss: { stop_price: 496 },
};

const tradestation = {
  Symbol: "SPY",
  asset_class: "equity",
  Quantity: "10",
  OrderType: "Limit",
  TradeAction: "BUY",
  LimitPrice: "500",
  TimeInForce: { Duration: "DAY" },
  OSOs: [{
    Type: "BRK",
    Orders: [
      { Symbol: "SPY", Quantity: "10", OrderType: "Limit", TradeAction: "SELL", LimitPrice: "506", TimeInForce: { Duration: "GTC" } },
      { Symbol: "SPY", Quantity: "10", OrderType: "StopMarket", TradeAction: "SELL", StopPrice: "496", TimeInForce: { Duration: "GTC" } },
    ],
  }],
};

function ids(result: { checks: { id: string; pass: boolean }[] }) {
  return result.checks.filter((c) => !c.pass).map((c) => c.id).join(",");
}

function why(result: { checks: { id: string; why: string }[] }, id: string) {
  const line = result.checks.find((c) => c.id === id);
  if (!line) throw new Error("missing " + id);
  return line.why;
}

describe("the same rules as /check", () => {
  test("good sample passes every order check", () => {
    const res = checkOrderText(JSON.stringify(good), "50");
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.mode).toBe("order");
    expect(res.pass).toBe(11);
    expect(res.total).toBe(11);
    expect(why(res, "risk")).toBe("Dollar risk $40 is within your $50.");
    expect(why(res, "stopside")).toBe("Stop is 4.00 below the entry.");
  });

  test("bad sample fails the same six checks", () => {
    const bad = { symbol: "SPY", side: "buy", qty: 40, type: "limit", limit_price: 500, order_class: "bracket", take_profit: { limit_price: 494 }, stop_loss: { stop_price: 503 }, max_loss: "1000", live_trading: "on" };
    const res = checkOrderText(JSON.stringify(bad), "50");
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(ids(res)).toBe("asset,tif,stopside,bracket,risk,flags");
    expect(why(res, "risk")).toContain("The order's own max_loss was ignored.");
    expect(why(res, "flags")).toBe("The order says it turns LIVE_TRADING on. An order cannot change your limits. Only your own file can.");
  });

  test("limits sample passes all seven", () => {
    const res = checkOrderText(JSON.stringify(limits), "");
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.mode).toBe("limits");
    expect(res.pass).toBe(7);
    expect(why(res, "live")).toBe("LIVE_TRADING: off. Turn it on yourself, in the file, after paper.");
  });

  test("a larger quantity fails the dollar-risk cap", () => {
    const res = checkOrderText(JSON.stringify({ ...good, qty: 20 }), "50");
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(why(res, "risk")).toBe("Dollar risk exceeds max loss: $80 against your $50.");
    expect(res.checks.find((c) => c.id === "risk")?.pass).toBe(false);
  });

  test("a sell bracket passes", () => {
    const res = checkOrderText(JSON.stringify({ ...good, side: "sell", take_profit: { limit_price: 494 }, stop_loss: { stop_price: 504 } }), "50");
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.pass).toBe(res.total);
    expect(why(res, "side")).toBe("Side: sell.");
  });

  test("broken JSON is an error", () => {
    const res = checkOrderText("{oops", "50");
    expect("error" in res && res.error.startsWith("That is not valid JSON.")).toBe(true);
  });

  test("TradeStation fields map onto the same checks", () => {
    const res = checkOrderText(JSON.stringify(tradestation), "50");
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.pass).toBe(11);
    const bad = JSON.parse(JSON.stringify(tradestation));
    bad.OSOs[0].Orders[0].LimitPrice = "494";
    bad.OSOs[0].Orders[1].StopPrice = "503";
    delete bad.TimeInForce;
    const failed = checkOrderText(JSON.stringify(bad), "50");
    expect("error" in failed).toBe(false);
    if ("error" in failed) return;
    expect(ids(failed)).toBe("tif,stopside,bracket");
    const stop = checkOrderText(JSON.stringify({ Symbol: "SPY", asset_class: "equity", Quantity: "10", OrderType: "StopMarket", TradeAction: "SELL", StopPrice: "495", TimeInForce: { Duration: "GTC" }, stop_loss: { stop_price: 499 } }), "50");
    expect("error" in stop).toBe(false);
    if ("error" in stop) return;
    expect(stop.pass).toBe(11);
    const dyp = checkOrderText(JSON.stringify({ ...tradestation, TimeInForce: { Duration: "DYP" } }), "50");
    expect("error" in dyp).toBe(false);
    if ("error" in dyp) return;
    expect(dyp.checks.find((c) => c.id === "tif")?.pass).toBe(true);
    const trailing = checkOrderText(JSON.stringify({ ...tradestation, OrderType: "Trailing" }), "50");
    expect("error" in trailing).toBe(false);
    if ("error" in trailing) return;
    expect(trailing.checks.find((c) => c.id === "type")?.pass).toBe(false);
    const sideWins = checkOrderText(JSON.stringify({ ...tradestation, side: "sell" }), "50");
    expect("error" in sideWins).toBe(false);
    if ("error" in sideWins) return;
    expect(why(sideWins, "side")).toBe("Side: sell.");
  });

  test("option, future, notional, and a stop that is too close", () => {
    const option = checkOrderText(JSON.stringify({ symbol: "SPY", asset_class: "option", side: "buy", qty: 1, type: "limit", limit_price: 2, time_in_force: "day", stop_loss: { stop_price: 1.5 } }), "50");
    expect("error" in option).toBe(false);
    if ("error" in option) return;
    expect(why(option, "risk")).toBe("Dollar risk $50 is within your $50. Used 100 per contract, the usual US equity option multiplier. Put the real one on the order.");
    const future = checkOrderText(JSON.stringify({ symbol: "MES", asset_class: "future", side: "buy", qty: 1, type: "limit", limit_price: 5000, time_in_force: "day", stop_loss: { stop_price: 4992 } }), "50");
    expect("error" in future).toBe(false);
    if ("error" in future) return;
    expect(why(future, "risk")).toBe("No multiplier for a future order. Dollar risk is price distance times multiplier times quantity. Do not guess the multiplier.");
    const withMult = checkOrderText(JSON.stringify({ symbol: "MES", asset_class: "future", side: "buy", qty: 1, type: "limit", limit_price: 5000, time_in_force: "day", stop_loss: { stop_price: 4992 }, multiplier: 5 }), "50");
    expect("error" in withMult).toBe(false);
    if ("error" in withMult) return;
    expect(why(withMult, "risk")).toBe("Dollar risk $40 is within your $50.");
    const notional = checkOrderText(JSON.stringify({ symbol: "SPY", asset_class: "equity", side: "buy", notional: 5000, type: "market", time_in_force: "day", price: 500, stop_loss: { stop_price: 495 } }), "50");
    expect("error" in notional).toBe(false);
    if ("error" in notional) return;
    expect(why(notional, "qty")).toBe("Notional order: $5,000. Share count comes from the fill price.");
    expect(why(notional, "risk")).toBe("Dollar risk $50 is within your $50.");
    const close = checkOrderText(JSON.stringify({ symbol: "SPY", asset_class: "equity", side: "buy", qty: 1, type: "limit", limit_price: 500, time_in_force: "day", stop_loss: { stop_price: 499.995 } }), "50");
    expect("error" in close).toBe(false);
    if ("error" in close) return;
    expect(why(close, "stopside")).toBe("The stop must be at least $0.01 from the entry.");
    expect(why(close, "risk")).toBe("Dollar risk $0 is within your $50.");
  });
});

describe("PASS, SEND-BACK, kill switch, and live refusal", () => {
  test("a paper order inside the limits file is PASS", () => {
    const res = checkProposedOrder(passOrder, limits);
    expect(res.verdict).toBe("PASS");
    expect(res.reasons).toEqual([]);
    expect(res.checks.every((c) => c.pass)).toBe(true);
  });

  test("the bad sample is SEND-BACK and the order max_loss is ignored", () => {
    const res = checkProposedOrder(sendBackOrder, limits);
    expect(res.verdict).toBe("SEND-BACK");
    expect(ids(res)).toBe("asset,tif,stopside,bracket,risk,flags");
    expect(res.reasons.some((r) => r.includes("The order's own max_loss was ignored."))).toBe(true);
    expect(res.reasons.some((r) => r.includes("Dollar risk exceeds"))).toBe(false);
  });

  test("the kill switch blocks an order that would otherwise pass", () => {
    const res = checkProposedOrder(passOrder, limits, { killed: true });
    expect(res.verdict).toBe("SEND-BACK");
    expect(res.reasons).toEqual([KILL_REASON]);
    expect(res.checks.map((c) => c.id)).toEqual(["halt"]);
  });

  test("a live account type is refused by default", () => {
    const res = checkProposedOrder({ ...passOrder, account_type: "live" }, limits);
    expect(res.verdict).toBe("SEND-BACK");
    expect(res.reasons).toEqual([LIVE_REFUSAL]);
  });

  test("live passes only when it is explicitly enabled", () => {
    const res = checkProposedOrder({ ...passOrder, account_type: "live" }, limits, { allowLive: true });
    expect(res.verdict).toBe("PASS");
    expect(res.reasons).toEqual([]);
  });

  test("LIVE_TRADING on the limits file is still SEND-BACK", () => {
    const res = checkProposedOrder(passOrder, { ...limits, live_trading: "on" });
    expect(res.verdict).toBe("SEND-BACK");
    expect(res.reasons.some((r) => r.startsWith("LIVE_TRADING is \"on\""))).toBe(true);
  });

  test("a missing account type is SEND-BACK", () => {
    const order = { ...passOrder };
    delete order.account_type;
    const res = checkProposedOrder(order, limits);
    expect(res.verdict).toBe("SEND-BACK");
    expect(res.reasons[0]).toContain("Account type is missing.");
  });

  test("env flags: halt on, allow-live only when set", () => {
    expect(killSwitchOn({ TRADING_HALT: "1" }, false)).toBe(true);
    expect(killSwitchOn({ TRADING_HALT: "true" }, false)).toBe(true);
    expect(killSwitchOn({ TRADING_HALT: "0" }, false)).toBe(false);
    expect(killSwitchOn({}, false)).toBe(false);
    expect(killSwitchOn({}, true)).toBe(true);
    expect(liveEnabled({})).toBe(false);
    expect(liveEnabled({ ALLOW_LIVE: "1" })).toBe(true);
    expect(liveEnabled({ ALLOW_LIVE: "on" })).toBe(true);
    expect(liveEnabled({ ALLOW_LIVE: "0" })).toBe(false);
  });
});

function cli(args: string[], env: Record<string, string> = {}, input?: string) {
  return spawnSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    input,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TRADING_HALT: "",
      TRADING_HALT_FILE: "",
      ALLOW_LIVE: "",
      ...env,
    },
  });
}

describe("CLI", () => {
  test("pass file exits 0", () => {
    const res = cli(["--limits", "examples/limits.json", "examples/pass-order.json"]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).verdict).toBe("PASS");
  });

  test("send-back file exits 1", () => {
    const res = cli(["--limits", "examples/limits.json", "examples/send-back-order.json"]);
    expect(res.status).toBe(1);
    const body = JSON.parse(res.stdout);
    expect(body.verdict).toBe("SEND-BACK");
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  test("stdin JSON is a plain call", () => {
    const res = cli(["--limits", "examples/limits.json"], {}, JSON.stringify(passOrder));
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).verdict).toBe("PASS");
  });

  test("TRADING_HALT blocks a passing order", () => {
    const res = cli(["--limits", "examples/limits.json", "examples/pass-order.json"], { TRADING_HALT: "1" });
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout).reasons).toEqual([KILL_REASON]);
  });

  test("a halt file blocks a passing order", () => {
    const dir = mkdtempSync(join(tmpdir(), "halt-"));
    const halt = join(dir, "HALT");
    writeFileSync(halt, "");
    const res = cli(["--limits", "examples/limits.json", "--halt-file", halt, "examples/pass-order.json"]);
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout).reasons).toEqual([KILL_REASON]);
  });

  test("live account type is refused unless ALLOW_LIVE=1", () => {
    const live = { ...passOrder, account_type: "live" };
    const refused = cli(["--limits", "examples/limits.json"], {}, JSON.stringify(live));
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout).reasons).toEqual([LIVE_REFUSAL]);
    const enabled = cli(["--limits", "examples/limits.json", "--allow-live"], {}, JSON.stringify(live));
    expect(enabled.status).toBe(0);
    expect(JSON.parse(enabled.stdout).verdict).toBe("PASS");
  });
});
