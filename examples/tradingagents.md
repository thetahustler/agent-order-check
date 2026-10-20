# Add a pre-trade check to TradingAgents

[TradingAgents](https://github.com/TauricResearch/TradingAgents) is a multi-agent research project. This package does not include that code. Run this check after the agent has written an order and before any broker call.

```python
import json
import subprocess

# The decision is whatever the agent just produced.
# Shape it into one order. Do not send it yet.
decision = {
    "symbol": "SPY",
    "asset_class": "equity",
    "side": "buy",
    "qty": 10,
    "type": "limit",
    "limit_price": 500,
    "time_in_force": "day",
    "account_type": "paper",
    "stop_loss": {"stop_price": 496},
}

checked = subprocess.run(
    ["bun", "src/cli.ts", "--limits", "limits.json"],
    input=json.dumps(decision),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
result = json.loads(checked.stdout)
if result["verdict"] != "PASS":
    raise SystemExit("SEND-BACK\n" + "\n".join(result["reasons"]))

# A PASS is permission to hand the same order to the paper broker.
# It is not a view on the trade. Live stays off unless you enable it.
# paper_broker.submit(decision)
```

`limits.json` is the file the agent cannot write. `TRADING_HALT=1`, or a halt file passed with `--halt-file`, blocks the call even when the order would otherwise pass.
