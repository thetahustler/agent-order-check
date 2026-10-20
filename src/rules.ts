// Copyright 2026 The Agentic Trader (JP3 Labs)
// SPDX-License-Identifier: Apache-2.0
//
// Same decisions and the same sentences as the order check on
// https://theagentictrader.com/check
// Field aliases, asset list, order types, time-in-force values, and the
// dollar-risk formula are copied from that checker. Do not add a trading rule here.

export type CheckLine = {
  id: string;
  name: string;
  pass: boolean;
  why: string;
};

export type OrderEvaluation =
  | { error: string }
  | { mode: "order" | "limits"; pass: number; total: number; checks: CheckLine[] };

type Dict = Record<string, unknown>;

export const ORDER_CHECKS: [string, string][] = [
  ["symbol", "Symbol is named"],
  ["side", "Side is buy or sell"],
  ["qty", "Quantity is a positive number"],
  ["asset", "Asset type is on the list"],
  ["type", "Order type is set"],
  ["tif", "Time in force is set"],
  ["stop", "There is a stop"],
  ["stopside", "Stop is on the right side of the entry, at least $0.01 away"],
  ["bracket", "Bracket legs are on the right sides"],
  ["risk", "Dollar risk is within your max loss"],
  ["flags", "The order does not change LIVE_TRADING or human approval"],
];

export const LIMIT_CHECKS: [string, string][] = [
  ["live", "LIVE_TRADING is off"],
  ["approval", "Human approval is on"],
  ["trade", "Max loss per trade is a number"],
  ["day", "Max loss per day is a number, at least the per-trade max"],
  ["positions", "Max open positions is a whole number"],
  ["never", "Never-trade list is present"],
  ["kill", "Kill switch is named"],
];

const CHECK_ASSETS: Record<string, string> = {
  equity: "equity",
  stock: "equity",
  us_equity: "equity",
  option: "option",
  us_option: "option",
  future: "future",
  fx: "fx",
  crypto_spot: "crypto_spot",
  crypto: "crypto_spot",
  crypto_perp: "crypto_perp",
};

const CHECK_TIF = ["day", "gtc", "ioc", "fok", "opg", "cls", "gtd"];
const CHECK_TS_TIF = ["dyp", "gcp", "gdp", "clo", "1", "3", "5", "1 min", "3 min", "5 min"];
const CHECK_TS_TYPES: Record<string, string> = { stopmarket: "stop", stoplimit: "stop_limit" };
const CHECK_TYPES = ["market", "limit", "stop", "stop_limit", "trailing_stop"];
const CHECK_UNSET = ["unverified", "need limit", "need data", "none", "blank", "maybe", "tbd", ""];
const LIMIT_KEYS = ["live_trading", "max_loss_per_trade", "max_loss_per_day", "max_open_positions", "kill_switch", "never_trade", "paper_flag"];

function checkKeys(o: Dict): Dict {
  const out: Dict = {};
  for (const k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      out[String(k).trim().toLowerCase().replace(/[\s-]+/g, "_")] = o[k];
    }
  }
  return out;
}

function checkPick(o: Dict, names: string[]): unknown {
  for (let i = 0; i < names.length; i++) {
    const v = o[names[i]];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function checkNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return parseFloat(v);
  return NaN;
}

function checkLow(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim().toLowerCase();
}

function checkLeg(v: unknown, names: string[]): number {
  if (v && typeof v === "object") return checkNum(checkPick(checkKeys(v as Dict), names));
  return checkNum(v);
}

function checkBrokerFields(o: Dict): Dict {
  const out: Dict = {};
  for (const k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  }
  function fill(dst: string, src: string) {
    if ((out[dst] === undefined || out[dst] === null || out[dst] === "") && out[src] !== undefined) out[dst] = out[src];
  }
  fill("side", "tradeaction");
  fill("limit_price", "limitprice");
  fill("stop_price", "stopprice");
  if (out.time_in_force === undefined && out.timeinforce && typeof out.timeinforce === "object") {
    out.time_in_force = checkKeys(out.timeinforce as Dict).duration;
  }
  if (Array.isArray(out.osos)) {
    for (let i = 0; i < out.osos.length; i++) {
      const raw = out.osos[i];
      const g = raw && typeof raw === "object" ? checkKeys(raw as Dict) : {};
      if (checkLow(g.type) !== "brk" || !Array.isArray(g.orders)) continue;
      for (let j = 0; j < g.orders.length; j++) {
        const rawChild = g.orders[j];
        const c = rawChild && typeof rawChild === "object" ? checkKeys(rawChild as Dict) : {};
        const ct = checkLow(c.ordertype);
        if ((ct === "stopmarket" || ct === "stoplimit") && out.stop_loss === undefined && c.stopprice !== undefined) {
          out.stop_loss = { stop_price: c.stopprice };
        } else if (ct === "limit" && out.take_profit === undefined && c.limitprice !== undefined) {
          out.take_profit = { limit_price: c.limitprice };
        }
      }
    }
  }
  return out;
}

function checkMoney(n: number): string {
  return "$" + (Math.round(n * 100) / 100).toLocaleString("en-US");
}

export function parseCheckInput(text: string): { error: string } | { value: Dict } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: "That is not valid JSON. Check for a missing comma or quote. Parser said: " + message };
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (!parsed || typeof parsed !== "object") {
    return { error: "Paste one JSON object: the order, or your limits file as JSON." };
  }
  let o = checkKeys(parsed as Dict);
  if (o.order && typeof o.order === "object") o = checkKeys(o.order as Dict);
  else if (o.proposal && typeof o.proposal === "object") o = checkKeys(o.proposal as Dict);
  return { value: o };
}

function checkResult(mode: "order" | "limits", defs: [string, string][], res: Record<string, [boolean, string]>): OrderEvaluation {
  const checks = defs.map((d) => {
    const r = res[d[0]] || [false, "Not checked."];
    return { id: d[0], name: d[1], pass: !!r[0], why: r[1] };
  });
  const pass = checks.filter((c) => c.pass).length;
  return { mode, pass, total: checks.length, checks };
}

function checkProposal(o: Dict, maxLossInput: string): OrderEvaluation {
  const r: Record<string, [boolean, string]> = {};
  o = checkBrokerFields(o);
  const symbol = checkPick(o, ["symbol", "ticker", "instrument", "underlying"]);
  r.symbol = symbol
    ? [true, "Symbol: " + String(symbol).slice(0, 24) + "."]
    : [false, "No symbol. An agent should never leave the instrument for the broker to guess."];
  const sideRaw = checkLow(checkPick(o, ["side", "action", "trade_action", "intent", "position_intent"]));
  const side = /^buy/.test(sideRaw) ? "buy" : /^sell/.test(sideRaw) ? "sell" : "";
  r.side = side
    ? [true, "Side: " + side + "."]
    : [false, sideRaw ? "Side is \"" + sideRaw.slice(0, 20) + "\". It must be buy or sell." : "Side is missing. Without buy or sell there is no order to check."];
  const qty = checkNum(checkPick(o, ["qty", "quantity", "size", "contracts", "shares", "units"]));
  const notional = checkNum(checkPick(o, ["notional"]));
  if (qty > 0) r.qty = [true, "Quantity: " + qty + "."];
  else if (Number.isNaN(qty) && notional > 0) r.qty = [true, "Notional order: " + checkMoney(notional) + ". Share count comes from the fill price."];
  else r.qty = [false, Number.isNaN(qty) ? "Quantity is missing. Do not let an agent invent a size." : "Quantity is " + qty + ". It must be above zero."];
  const assetRaw = checkLow(checkPick(o, ["asset", "asset_type", "asset_class", "assetclass", "security_type", "instrument_type"]));
  const asset = CHECK_ASSETS[assetRaw] || "";
  r.asset = asset
    ? [true, "Asset type: " + asset + "."]
    : [false, assetRaw ? "Asset type \"" + assetRaw.slice(0, 20) + "\" is not on the list: equity, option, future, fx, crypto_spot, crypto_perp. The checker does not guess." : "Asset type is missing. Futures, options and stock carry different risk per point, so the checker will not assume one."];
  let type = checkLow(checkPick(o, ["type", "order_type", "ordertype"]));
  if (CHECK_TS_TYPES[type]) type = CHECK_TS_TYPES[type];
  r.type = CHECK_TYPES.indexOf(type) >= 0
    ? [true, "Order type: " + type + "."]
    : [false, type ? "Order type \"" + type.slice(0, 20) + "\" is not market, limit, stop, stop_limit or trailing_stop, or TradeStation's StopMarket or StopLimit." : "Order type is missing. The broker will not pick one safely for you."];
  const tif = checkLow(checkPick(o, ["time_in_force", "tif", "duration", "timeinforce"]));
  r.tif = CHECK_TIF.indexOf(tif) >= 0 || CHECK_TS_TIF.indexOf(tif) >= 0
    ? [true, "Time in force: " + tif + "."]
    : [false, tif ? "Time in force \"" + tif.slice(0, 20) + "\" is not day, gtc, ioc, fok, opg, cls or gtd, or a TradeStation duration such as DYP, GCP, GDP or CLO." : "Time in force is missing. Brokers default differently, and an order that rests past the close is a surprise."];
  let entry = checkNum(checkPick(o, ["limit_price", "entry", "entry_price", "price"]));
  if (Number.isNaN(entry) && (type === "stop" || type === "stop_limit")) entry = checkNum(o.stop_price);
  let stopVal = checkPick(o, ["stop_loss", "stop", "stoploss", "invalidation", "sl"]);
  if (stopVal === undefined && type !== "stop" && type !== "stop_limit") stopVal = o.stop_price;
  const stop = checkLeg(stopVal, ["stop_price", "price", "trigger"]);
  const tp = checkLeg(checkPick(o, ["take_profit", "target", "takeprofit", "tp", "profit_target"]), ["limit_price", "price"]);
  r.stop = !Number.isNaN(stop) ? [true, "Stop: " + stop + "."] : [false, "No stop. Nothing on the order says where the trade is wrong, so nothing caps the loss."];
  if (Number.isNaN(stop)) r.stopside = [false, "No stop to place against the entry."];
  else if (Number.isNaN(entry)) r.stopside = [false, "No entry price, so the stop distance cannot be checked. Add the price you expect to fill near."];
  else if (!side) r.stopside = [false, "Side is missing, so the right side for the stop is unknown."];
  else if (side === "buy" ? stop >= entry : stop <= entry) r.stopside = [false, "The stop is " + (stop === entry ? "at" : "beyond") + " the entry on a " + side + ". A " + side + " needs the stop " + (side === "buy" ? "below" : "above") + " the entry."];
  else if (Math.abs(entry - stop) < 0.01 - 1e-9) r.stopside = [false, "The stop must be at least $0.01 from the entry."];
  else r.stopside = [true, "Stop is " + Math.abs(entry - stop).toFixed(2) + " " + (side === "buy" ? "below" : "above") + " the entry."];
  if (Number.isNaN(tp)) r.bracket = [true, "No take-profit leg, so there are no legs to reverse."];
  else if (Number.isNaN(entry) || Number.isNaN(stop) || !side) r.bracket = [false, "A take-profit is set, but the entry, the stop or the side is missing, so the legs cannot be checked."];
  else if (side === "buy" && !(tp > entry && entry > stop)) r.bracket = [false, "A buy bracket needs take_profit above the entry and the entry above the stop."];
  else if (side === "sell" && !(tp < entry && entry < stop)) r.bracket = [false, "A sell bracket needs take_profit below the entry and the entry below the stop."];
  else r.bracket = [true, "Take-profit and stop sit on the right sides of the entry."];
  const maxLoss = checkNum(maxLossInput);
  let mult = checkNum(checkPick(o, ["multiplier", "contract_multiplier", "point_value"]));
  let multNote = "";
  if (Number.isNaN(mult)) {
    if (asset === "equity" || asset === "crypto_spot") mult = 1;
    else if (asset === "option") {
      mult = 100;
      multNote = " Used 100 per contract, the usual US equity option multiplier. Put the real one on the order.";
    }
  }
  const units = qty > 0 ? qty : notional > 0 && entry > 0 ? notional / entry : NaN;
  const ownMax = checkPick(o, ["max_loss", "max_loss_per_trade", "risk_limit"]);
  const ownNote = ownMax !== undefined ? " The order's own max_loss was ignored. Limits live in your file, not on the order." : "";
  if (!(maxLoss > 0)) r.risk = [false, "Enter your max loss per trade above. It comes from your own limits, not from the order." + ownNote];
  else if (Number.isNaN(mult)) r.risk = [false, (asset ? "No multiplier for a " + asset + " order. " : "Asset type unknown, so the multiplier is unknown. ") + "Dollar risk is price distance times multiplier times quantity. Do not guess the multiplier." + ownNote];
  else if (Number.isNaN(units) || Number.isNaN(entry) || Number.isNaN(stop)) r.risk = [false, "Dollar risk needs a quantity, an entry and a stop." + ownNote];
  else {
    const risk = Math.abs(entry - stop) * mult * units;
    r.risk = risk <= maxLoss + 1e-9
      ? [true, "Dollar risk " + checkMoney(risk) + " is within your " + checkMoney(maxLoss) + "." + multNote + ownNote]
      : [false, "Dollar risk exceeds max loss: " + checkMoney(risk) + " against your " + checkMoney(maxLoss) + "." + multNote + ownNote];
  }
  const live = checkLow(checkPick(o, ["live_trading", "live"]));
  const appr = checkLow(checkPick(o, ["human_approval", "approval", "requires_approval"]));
  const bad: string[] = [];
  if (live === "on" || live === "true" || live === "yes") bad.push("it turns LIVE_TRADING on");
  if (appr === "off" || appr === "false" || appr === "no") bad.push("it turns human approval off");
  r.flags = bad.length
    ? [false, "The order says " + bad.join(" and ") + ". An order cannot change your limits. Only your own file can."]
    : [true, "The order leaves LIVE_TRADING and human approval to your file."];
  return checkResult("order", ORDER_CHECKS, r);
}

function checkLimits(o: Dict): OrderEvaluation {
  const r: Record<string, [boolean, string]> = {};
  const live = checkLow(o.live_trading);
  r.live = live === "off" || live === "false"
    ? [true, "LIVE_TRADING: off. Turn it on yourself, in the file, after paper."]
    : [false, live ? "LIVE_TRADING is \"" + live.slice(0, 12) + "\". The Desk Kit install writes off, and you arm it later." : "LIVE_TRADING is missing. A missing flag is not the same as off."];
  const appr = checkLow(checkPick(o, ["human_approval", "approval"]));
  r.approval = appr === "on" || appr === "true"
    ? [true, "Human approval: on."]
    : [false, appr ? "Human approval is \"" + appr.slice(0, 12) + "\". Keep it on until the desk has a paper record." : "Human approval is missing."];
  const trade = checkNum(o.max_loss_per_trade);
  r.trade = trade > 0
    ? [true, "Max loss per trade: " + checkMoney(trade) + "."]
    : [false, CHECK_UNSET.indexOf(checkLow(o.max_loss_per_trade)) >= 0 ? "Max loss per trade is missing or unverified. The checker refuses every order without it." : "Max loss per trade must be a number above zero."];
  const day = checkNum(o.max_loss_per_day);
  r.day = day > 0 && (!(trade > 0) || day >= trade)
    ? [true, "Max loss per day: " + checkMoney(day) + "."]
    : [false, day > 0 ? "Max loss per day is under the per-trade max, so one loss would break it." : "Max loss per day is missing or not a number."];
  const pos = checkNum(o.max_open_positions);
  r.positions = pos > 0 && Math.floor(pos) === pos
    ? [true, "Max open positions: " + pos + "."]
    : [false, "Max open positions is missing or not a whole number."];
  r.never = "never_trade" in o
    ? [true, "Never-trade list is present" + (Array.isArray(o.never_trade) && o.never_trade.length ? ": " + o.never_trade.length + " symbol(s)." : ", empty for now.")]
    : [false, "Never-trade list missing. Put the key in, even when the list is empty."];
  const kill = checkLow(o.kill_switch);
  r.kill = kill && CHECK_UNSET.indexOf(kill) < 0
    ? [true, "Kill switch: " + kill.slice(0, 24) + "."]
    : [false, "Kill switch is not named. Say who can stop the desk."];
  return checkResult("limits", LIMIT_CHECKS, r);
}

/** Run the /check rules on one JSON text. `maxLossInput` is the operator's number, never the order's. */
export function checkOrderText(text: string, maxLossInput: string): OrderEvaluation {
  const parsed = parseCheckInput(text);
  if ("error" in parsed) return parsed;
  const o = parsed.value;
  const isLimits = !("side" in o) && !("qty" in o) && !("quantity" in o) && LIMIT_KEYS.some((k) => k in o);
  return isLimits ? checkLimits(o) : checkProposal(o, maxLossInput);
}

export function readAccountType(text: string): string {
  const parsed = parseCheckInput(text);
  if ("error" in parsed) return "";
  return checkLow(checkPick(parsed.value, ["account_type", "accounttype", "account"]));
}

export function readMaxLoss(text: string): string {
  const parsed = parseCheckInput(text);
  if ("error" in parsed) return "";
  const v = parsed.value.max_loss_per_trade;
  if (v === undefined || v === null) return "";
  return String(v);
}
