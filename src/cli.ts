#!/usr/bin/env -S node --experimental-strip-types
// Copyright 2026 The Agentic Trader (JP3 Labs)
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { checkProposedOrder, killSwitchOn, liveEnabled } from "./index.ts";

function usage(): string {
  return [
    "Usage: agent-order-check --limits <limits.json> [--halt-file <path>] [--allow-live] [order.json]",
    "",
    "Reads one order as JSON, from a file or from stdin, and a limits file.",
    "Prints PASS or SEND-BACK as JSON.",
    "Exit 0 is PASS. Exit 1 is SEND-BACK. Exit 2 means the check did not run.",
    "",
    "TRADING_HALT=1 blocks every order. If the halt file exists, every order is blocked.",
    "Set the halt file with --halt-file or TRADING_HALT_FILE.",
    "ALLOW_LIVE=1 or --allow-live is the explicit enable for account_type live.",
    "The default is to refuse live. LIVE_TRADING in the limits file stays off.",
  ].join("\n");
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
let limitsPath = "";
let orderPath = "";
let haltFile = "";
let allowLiveFlag = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  } else if (arg === "--limits") {
    limitsPath = args[++i] || "";
    if (!limitsPath) fail("Pass a path after --limits.");
  } else if (arg === "--halt-file") {
    haltFile = args[++i] || "";
    if (!haltFile) fail("Pass a path after --halt-file.");
  } else if (arg === "--allow-live") {
    allowLiveFlag = true;
  } else if (arg.startsWith("-")) {
    fail("Unknown argument: " + arg + "\n\n" + usage());
  } else if (!orderPath) {
    orderPath = arg;
  } else {
    fail("Pass one order file.\n\n" + usage());
  }
}

if (!limitsPath) fail("Pass --limits pointing at the limits file.\n\n" + usage());

function readText(path: string, label: string): string {
  if (!existsSync(path)) fail(label + " file was not found: " + path);
  return readFileSync(path, "utf8");
}

const limitsRaw = readText(limitsPath, "Limits");
let orderRaw = "";
if (orderPath) {
  orderRaw = readText(orderPath, "Order");
} else if (process.stdin.isTTY) {
  fail("Pass an order JSON file, or pipe JSON on stdin.\n\n" + usage());
} else {
  orderRaw = readFileSync(0, "utf8");
}

const haltPath = haltFile || process.env.TRADING_HALT_FILE || "";
const killed = killSwitchOn(process.env, haltPath !== "" && existsSync(haltPath));
const allowLive = allowLiveFlag || liveEnabled(process.env);
const result = checkProposedOrder(orderRaw, limitsRaw, { killed, allowLive });
console.log(JSON.stringify(result, null, 2));
process.exit(result.verdict === "PASS" ? 0 : 1);
