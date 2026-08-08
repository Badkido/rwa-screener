#!/usr/bin/env python3
"""Local helper for the RWA Screener dashboard's "刷新Binance合约数据" button.

fapi.binance.com blocks GitHub Actions' server IPs (HTTP 451) but works fine
from most home/office networks. This runs a tiny localhost server that fetches
+ classifies Binance USDⓈ-M futures data on request, with permissive CORS
headers, so the dashboard's JS can call it directly from your browser.

Usage:
    python3 scripts/local_binance_futures_proxy.py
    (leave it running, then click "刷新" on the dashboard's Binance tab)

Stdlib only — no pip install needed.
"""
import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from fetch_data import (  # noqa: E402
    fapi_urls,
    http_json,
    http_json_any,
    fetch_many,
    f,
    top,
    pct,
    oi_stats,
    BINANCE_FAPI_HOSTS,
)

PORT = 8899


def fetch_binance_futures():
    fut_info = http_json_any(fapi_urls("/v1/exchangeInfo"))
    fut_tick = fapi_base = None
    for host in BINANCE_FAPI_HOSTS:
        try:
            fut_tick = http_json(f"{host}/v1/ticker/24hr")
            fapi_base = host
            break
        except Exception:  # noqa: BLE001
            continue
    if fut_tick is None:
        raise RuntimeError("ticker/24hr failed on all hosts")

    fut_map = {s["symbol"]: s for s in fut_info["symbols"]}

    fut_rows = []
    for t in fut_tick:
        sym = t["symbol"]
        info = fut_map.get(sym)
        if not info or info.get("status") != "TRADING":
            continue
        if info.get("contractType") not in ("PERPETUAL", "TRADIFI_PERPETUAL"):
            continue
        if info.get("quoteAsset") != "USDT":
            continue
        cls = None
        if info.get("contractType") == "TRADIFI_PERPETUAL":
            cls = "commodity" if info.get("underlyingType") == "COMMODITY" else "equity"
        fut_rows.append(
            {
                "symbol": sym,
                "base": info["baseAsset"],
                "volume_usd": f(t.get("quoteVolume")),
                "price": f(t.get("lastPrice")),
                "change_pct": f(t.get("priceChangePercent")),
                "class": cls,
            }
        )

    oi_urls = [f"{fapi_base}/v1/openInterest?symbol={r['symbol']}" for r in fut_rows]
    oi_results = fetch_many(oi_urls, max_workers=30)
    for r, oi in zip(fut_rows, oi_results):
        qty = f(oi.get("openInterest")) if oi else 0.0
        r["oi_usd"] = qty * r["price"]

    total = sum(r["volume_usd"] for r in fut_rows)
    equity = [r for r in fut_rows if r["class"] == "equity"]
    commodity = [r for r in fut_rows if r["class"] == "commodity"]

    return {
        "total_volume_usd": total,
        "equity_volume_usd": sum(r["volume_usd"] for r in equity),
        "commodity_volume_usd": sum(r["volume_usd"] for r in commodity),
        "equity_pct": pct(sum(r["volume_usd"] for r in equity), total),
        "commodity_pct": pct(sum(r["volume_usd"] for r in commodity), total),
        "equity_ranking": top(equity, "volume_usd"),
        "commodity_ranking": top(commodity, "volume_usd"),
        "top100_oi": top(fut_rows, "oi_usd", 100),
        **oi_stats(fut_rows),
    }


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path != "/binance-futures":
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        try:
            data = fetch_binance_futures()
            body = json.dumps(data).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # noqa: BLE001
            print(f"fetch_binance_futures failed: {e}", file=sys.stderr)
            body = json.dumps({"error": str(e)}).encode()
            self.send_response(502)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(fmt % args, file=sys.stderr)


if __name__ == "__main__":
    print(f"Listening on http://localhost:{PORT} — open the dashboard and click 刷新.")
    print("Ctrl+C to stop.")
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
