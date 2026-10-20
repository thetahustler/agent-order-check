"""Call the order-check CLI from Python. Run this from the package root.

The limits file stays outside the agent. This snippet does not place an order.
"""

import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
order = {
    "symbol": "SPY",
    "asset_class": "equity",
    "side": "buy",
    "qty": 10,
    "type": "limit",
    "limit_price": 500,
    "time_in_force": "day",
    "account_type": "paper",
    "stop_loss": {"stop_price": 496},
    "take_profit": {"limit_price": 506},
}

proc = subprocess.run(
    ["bun", "src/cli.ts", "--limits", str(root / "examples" / "limits.json")],
    input=json.dumps(order),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    cwd=root,
    check=False,
)
result = json.loads(proc.stdout)
print(proc.stdout, end="")
if result["verdict"] != "PASS":
    raise SystemExit(proc.returncode)
