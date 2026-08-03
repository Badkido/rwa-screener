#!/usr/bin/env python3
"""Fetch spot/futures volume & OI data from Binance, OKX, Coinbase, Hyperliquid,
classify RWA (tokenized equity / commodity) instruments, and write data/data.json.

Stdlib only (no pip installs needed) so it runs on any GitHub Actions runner as-is.
"""
import concurrent.futures as cf
import json
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

UA = "Mozilla/5.0 (compatible; rwa-screener/1.0; +https://github.com/Badkido/rwa-screener)"
TIMEOUT = 15
MAX_RETRIES = 3


def http_json(url, method="GET", body=None, timeout=TIMEOUT):
    data = None
    headers = {"User-Agent": UA}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            last_err = e
            if 400 <= e.code < 500:
                break  # client error (incl. 451 geo-block) won't fix itself on retry
            time.sleep(0.5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"GET/POST {url} failed: {last_err}")


def http_json_any(urls, method="GET", body=None, timeout=TIMEOUT):
    """Try each candidate URL (same logical request, different host/path) in order."""
    errs = []
    for u in urls:
        try:
            return http_json(u, method=method, body=body, timeout=timeout)
        except Exception as e:  # noqa: BLE001
            errs.append(f"{u} -> {e}")
    raise RuntimeError("all hosts failed: " + " | ".join(errs))


def fetch_many(urls, max_workers=25):
    """Fetch many URLs concurrently. Returns list aligned with urls; None on failure."""
    results = [None] * len(urls)

    def _one(i, u):
        try:
            return i, http_json(u)
        except Exception:  # noqa: BLE001
            return i, None

    with cf.ThreadPoolExecutor(max_workers=max_workers) as ex:
        for i, res in ex.map(lambda p: _one(*p), list(enumerate(urls))):
            results[i] = res
    return results


def f(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def top(rows, key, n=None):
    rows = sorted(rows, key=lambda r: r.get(key, 0), reverse=True)
    return rows[:n] if n else rows


def pct(part, whole):
    return round(100 * part / whole, 2) if whole else 0.0


# ---------------------------------------------------------------------------
# Binance
# ---------------------------------------------------------------------------
COMMODITY_SPOT_TOKENS_BINANCE = {"PAXG", "XAUT"}


BINANCE_SPOT_BASE = "https://data-api.binance.vision"  # unrestricted market-data mirror of api.binance.com
# fapi.binance.com 451-blocks some cloud/datacenter IP ranges (incl. GitHub-hosted
# runners); www.binance.com proxies the same futures API under /fapi and is not
# subject to the same geo-block, so it's tried first with fapi.binance.com as fallback.
BINANCE_FAPI_HOSTS = ["https://www.binance.com/fapi", "https://fapi.binance.com/fapi"]


def fapi_urls(path):
    return [f"{host}{path}" for host in BINANCE_FAPI_HOSTS]


def fetch_binance():
    result = {"spot": None, "futures": None}
    errors = []

    fut_info = fut_tick = None
    fapi_base = None
    try:
        fut_info = http_json_any(fapi_urls("/v1/exchangeInfo"))
        # lock in whichever host just worked so subsequent calls don't re-probe
        for host in BINANCE_FAPI_HOSTS:
            try:
                fut_tick = http_json(f"{host}/v1/ticker/24hr")
                fapi_base = host
                break
            except Exception:  # noqa: BLE001
                continue
        if fut_tick is None:
            raise RuntimeError("ticker/24hr failed on all hosts")
    except Exception as e:  # noqa: BLE001
        errors.append(f"futures fetch failed: {e}")

    tradifi_equity_base, tradifi_commodity_base = set(), set()
    fut_map = {}
    if fut_info:
        fut_map = {s["symbol"]: s for s in fut_info["symbols"]}
        for s in fut_info["symbols"]:
            if s.get("contractType") == "TRADIFI_PERPETUAL":
                if s.get("underlyingType") == "COMMODITY":
                    tradifi_commodity_base.add(s["baseAsset"])
                else:
                    tradifi_equity_base.add(s["baseAsset"])

    def classify_spot(base_asset):
        if base_asset in COMMODITY_SPOT_TOKENS_BINANCE:
            return "commodity"
        if base_asset.endswith("B"):
            root = base_asset[:-1]
            if root in tradifi_commodity_base:
                return "commodity"
            if root in tradifi_equity_base:
                return "equity"
        return None

    # ---- Spot ----
    try:
        spot_info = http_json(f"{BINANCE_SPOT_BASE}/api/v3/exchangeInfo")
        spot_tick = http_json(f"{BINANCE_SPOT_BASE}/api/v3/ticker/24hr")
        spot_map = {s["symbol"]: s for s in spot_info["symbols"]}

        spot_rows = []
        for t in spot_tick:
            sym = t["symbol"]
            info = spot_map.get(sym)
            if not info or info.get("quoteAsset") != "USDT" or info.get("status") != "TRADING":
                continue
            spot_rows.append(
                {
                    "symbol": sym,
                    "base": info["baseAsset"],
                    "volume_usd": f(t.get("quoteVolume")),
                    "price": f(t.get("lastPrice")),
                    "change_pct": f(t.get("priceChangePercent")),
                    "class": classify_spot(info["baseAsset"]),
                }
            )

        spot_total = sum(r["volume_usd"] for r in spot_rows)
        spot_equity = [r for r in spot_rows if r["class"] == "equity"]
        spot_commodity = [r for r in spot_rows if r["class"] == "commodity"]

        result["spot"] = {
            "total_volume_usd": spot_total,
            "equity_volume_usd": sum(r["volume_usd"] for r in spot_equity),
            "commodity_volume_usd": sum(r["volume_usd"] for r in spot_commodity),
            "equity_pct": pct(sum(r["volume_usd"] for r in spot_equity), spot_total),
            "commodity_pct": pct(sum(r["volume_usd"] for r in spot_commodity), spot_total),
            "equity_ranking": top(spot_equity, "volume_usd"),
            "commodity_ranking": top(spot_commodity, "volume_usd"),
            "top100": top(spot_rows, "volume_usd", 100),
        }
    except Exception as e:  # noqa: BLE001
        errors.append(f"spot fetch failed: {e}")

    # ---- Futures (USDⓈ-M only) ----
    if fut_info and fut_tick:
        try:
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

            fut_total = sum(r["volume_usd"] for r in fut_rows)
            fut_equity = [r for r in fut_rows if r["class"] == "equity"]
            fut_commodity = [r for r in fut_rows if r["class"] == "commodity"]

            result["futures"] = {
                "total_volume_usd": fut_total,
                "equity_volume_usd": sum(r["volume_usd"] for r in fut_equity),
                "commodity_volume_usd": sum(r["volume_usd"] for r in fut_commodity),
                "equity_pct": pct(sum(r["volume_usd"] for r in fut_equity), fut_total),
                "commodity_pct": pct(sum(r["volume_usd"] for r in fut_commodity), fut_total),
                "equity_ranking": top(fut_equity, "volume_usd"),
                "commodity_ranking": top(fut_commodity, "volume_usd"),
                "top100_oi": top(fut_rows, "oi_usd", 100),
            }
        except Exception as e:  # noqa: BLE001
            errors.append(f"futures classify failed: {e}")

    if errors:
        result["_errors"] = errors
    return result


# ---------------------------------------------------------------------------
# OKX
# ---------------------------------------------------------------------------
def fetch_okx():
    spot_inst = http_json("https://www.okx.com/api/v5/public/instruments?instType=SPOT")["data"]
    spot_tick = http_json("https://www.okx.com/api/v5/market/tickers?instType=SPOT")["data"]
    swap_inst = http_json("https://www.okx.com/api/v5/public/instruments?instType=SWAP")["data"]
    swap_tick = http_json("https://www.okx.com/api/v5/market/tickers?instType=SWAP")["data"]
    swap_oi = http_json("https://www.okx.com/api/v5/public/open-interest?instType=SWAP")["data"]

    spot_inst_map = {i["instId"]: i for i in spot_inst}
    swap_inst_map = {i["instId"]: i for i in swap_inst}
    oi_map = {o["instId"]: f(o.get("oiUsd")) for o in swap_oi}

    def cat_class(cat):
        if cat == "3":
            return "equity"
        if cat == "4":
            return "commodity"
        return None

    spot_rows = []
    for t in spot_tick:
        inst = spot_inst_map.get(t["instId"])
        if not inst or inst.get("quoteCcy") != "USDT" or inst.get("state") != "live":
            continue
        spot_rows.append(
            {
                "symbol": t["instId"],
                "base": inst["baseCcy"],
                "volume_usd": f(t.get("volCcy24h")),
                "price": f(t.get("last")),
                "change_pct": pct(f(t.get("last")) - f(t.get("open24h")), f(t.get("open24h"))),
                "class": cat_class(inst.get("instCategory")),
            }
        )

    spot_total = sum(r["volume_usd"] for r in spot_rows)
    spot_equity = [r for r in spot_rows if r["class"] == "equity"]
    spot_commodity = [r for r in spot_rows if r["class"] == "commodity"]

    swap_rows = []
    for t in swap_tick:
        inst = swap_inst_map.get(t["instId"])
        if not inst or inst.get("settleCcy") != "USDT" or inst.get("state") != "live":
            continue
        swap_rows.append(
            {
                "symbol": t["instId"],
                "base": inst.get("instFamily", t["instId"]),
                "volume_usd": f(t.get("volCcy24h")),
                "price": f(t.get("last")),
                "change_pct": pct(f(t.get("last")) - f(t.get("open24h")), f(t.get("open24h"))),
                "class": cat_class(inst.get("instCategory")),
                "oi_usd": oi_map.get(t["instId"], 0.0),
            }
        )

    swap_total = sum(r["volume_usd"] for r in swap_rows)
    swap_equity = [r for r in swap_rows if r["class"] == "equity"]
    swap_commodity = [r for r in swap_rows if r["class"] == "commodity"]

    return {
        "spot": {
            "total_volume_usd": spot_total,
            "equity_volume_usd": sum(r["volume_usd"] for r in spot_equity),
            "commodity_volume_usd": sum(r["volume_usd"] for r in spot_commodity),
            "equity_pct": pct(sum(r["volume_usd"] for r in spot_equity), spot_total),
            "commodity_pct": pct(sum(r["volume_usd"] for r in spot_commodity), spot_total),
            "equity_ranking": top(spot_equity, "volume_usd"),
            "commodity_ranking": top(spot_commodity, "volume_usd"),
            "top100": top(spot_rows, "volume_usd", 100),
        },
        "futures": {
            "total_volume_usd": swap_total,
            "equity_volume_usd": sum(r["volume_usd"] for r in swap_equity),
            "commodity_volume_usd": sum(r["volume_usd"] for r in swap_commodity),
            "equity_pct": pct(sum(r["volume_usd"] for r in swap_equity), swap_total),
            "commodity_pct": pct(sum(r["volume_usd"] for r in swap_commodity), swap_total),
            "equity_ranking": top(swap_equity, "volume_usd"),
            "commodity_ranking": top(swap_commodity, "volume_usd"),
            "top100_oi": top(swap_rows, "oi_usd", 100),
        },
    }


# ---------------------------------------------------------------------------
# Coinbase
# ---------------------------------------------------------------------------
COMMODITY_SPOT_TOKENS_COINBASE = {"PAXG"}
EQUITY_SPOT_TOKENS_COINBASE = set()  # Coinbase retail tokenized-equity spot not live yet


def fetch_coinbase():
    products = http_json("https://api.coinbase.com/api/v3/brokerage/market/products")["products"]
    intl = http_json("https://api.international.coinbase.com/api/v1/instruments")

    def classify_spot(base):
        if base in COMMODITY_SPOT_TOKENS_COINBASE:
            return "commodity"
        if base in EQUITY_SPOT_TOKENS_COINBASE:
            return "equity"
        return None

    spot_rows = []
    for p in products:
        if p.get("product_type") != "SPOT" or p.get("status") != "online":
            continue
        if p.get("quote_currency_id") not in ("USD", "USDC", "USDT"):
            continue
        base = p.get("base_currency_id", "")
        spot_rows.append(
            {
                "symbol": p["product_id"],
                "base": base,
                "volume_usd": f(p.get("approximate_quote_24h_volume")),
                "price": f(p.get("price")),
                "change_pct": f(p.get("price_percentage_change_24h")),
                "class": classify_spot(base),
            }
        )

    spot_total = sum(r["volume_usd"] for r in spot_rows)
    spot_equity = [r for r in spot_rows if r["class"] == "equity"]
    spot_commodity = [r for r in spot_rows if r["class"] == "commodity"]

    fut_rows = []
    for p in intl:
        if p.get("type") != "PERP" or p.get("trading_state") != "TRADING":
            continue
        underlying = p.get("underlying_type")
        cls = "commodity" if underlying == "COMMOD" else ("equity" if underlying not in ("SPOT", None) else None)
        mark = f(p.get("quote", {}).get("mark_price"))
        oi_qty = f(p.get("open_interest"))
        change = f(p.get("quote", {}).get("mark_price")) - f(p.get("quote", {}).get("settlement_price"))
        fut_rows.append(
            {
                "symbol": p["symbol"],
                "base": p.get("base_asset_name", p["symbol"]),
                "volume_usd": f(p.get("notional_24hr")),
                "price": mark,
                "change_pct": pct(change, f(p.get("quote", {}).get("settlement_price"))),
                "class": cls,
                "oi_usd": oi_qty * mark,
            }
        )

    fut_total = sum(r["volume_usd"] for r in fut_rows)
    fut_equity = [r for r in fut_rows if r["class"] == "equity"]
    fut_commodity = [r for r in fut_rows if r["class"] == "commodity"]

    return {
        "spot": {
            "total_volume_usd": spot_total,
            "equity_volume_usd": sum(r["volume_usd"] for r in spot_equity),
            "commodity_volume_usd": sum(r["volume_usd"] for r in spot_commodity),
            "equity_pct": pct(sum(r["volume_usd"] for r in spot_equity), spot_total),
            "commodity_pct": pct(sum(r["volume_usd"] for r in spot_commodity), spot_total),
            "equity_ranking": top(spot_equity, "volume_usd"),
            "commodity_ranking": top(spot_commodity, "volume_usd"),
            "top100": top(spot_rows, "volume_usd", 100),
        },
        "futures": {
            "total_volume_usd": fut_total,
            "equity_volume_usd": sum(r["volume_usd"] for r in fut_equity),
            "commodity_volume_usd": sum(r["volume_usd"] for r in fut_commodity),
            "equity_pct": pct(sum(r["volume_usd"] for r in fut_equity), fut_total),
            "commodity_pct": pct(sum(r["volume_usd"] for r in fut_commodity), fut_total),
            "equity_ranking": top(fut_equity, "volume_usd"),
            "commodity_ranking": top(fut_commodity, "volume_usd"),
            "top100_oi": top(fut_rows, "oi_usd", 100),
        },
    }


# ---------------------------------------------------------------------------
# Hyperliquid
# ---------------------------------------------------------------------------
HL_CRYPTO_BLOCKLIST = {
    "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LTC", "BNB", "BCH", "XMR", "SUI",
    "LINK", "ENA", "XPL", "ZEC", "PUMP", "FARTCOIN", "IP", "LIGHTER", "LIT", "HYPE",
    "USDE", "BTCD", "TOTAL2", "OTHERS", "PURRDAT", "QNT", "NIGHT",
}
HL_FOREX = {"EUR", "GBP", "JPY", "KRW", "DXY", "USD"}
HL_COMMODITY_KEYWORDS = {
    "GOLD", "GOLDJM", "GLDMINE", "SILVER", "SILVERJM", "COPPER", "OIL", "WTI", "WTIOIL",
    "BRENT", "BRENTOIL", "CL", "BZ", "NATGAS", "GAS", "PLATINUM", "PALLADIUM", "ALUMINIUM",
    "WHEAT", "CORN", "SOY", "URANIUM", "XAU", "XAG", "XPT", "XPD", "XCU",
}


def hl_classify(hip3_name):
    ticker = hip3_name.split(":")[-1]
    if ticker in HL_CRYPTO_BLOCKLIST or ticker in HL_FOREX:
        return None
    if ticker in HL_COMMODITY_KEYWORDS:
        return "commodity"
    return "equity"


def fetch_hyperliquid():
    dexs = http_json(
        "https://api.hyperliquid.xyz/info", method="POST", body={"type": "perpDexs"}
    )
    dex_names = [d["name"] for d in dexs if d]  # skip the null default entry

    all_rows = []

    def load_dex(dex_name):
        body = {"type": "metaAndAssetCtxs"}
        if dex_name:
            body["dex"] = dex_name
        meta, ctxs = http_json("https://api.hyperliquid.xyz/info", method="POST", body=body)
        rows = []
        for asset, ctx in zip(meta["universe"], ctxs):
            name = asset["name"]
            mark = f(ctx.get("markPx"))
            rows.append(
                {
                    "symbol": name,
                    "base": name,
                    "volume_usd": f(ctx.get("dayNtlVlm")),
                    "price": mark,
                    "change_pct": pct(mark - f(ctx.get("prevDayPx")), f(ctx.get("prevDayPx"))),
                    "class": hl_classify(name) if dex_name else None,
                    "oi_usd": f(ctx.get("openInterest")) * mark,
                }
            )
        return rows

    all_rows.extend(load_dex(None))  # main dex: crypto only, excluded from equity/commodity
    for name in dex_names:
        try:
            all_rows.extend(load_dex(name))
        except Exception:  # noqa: BLE001
            print(f"[hyperliquid] failed to load dex {name}", file=sys.stderr)

    fut_total = sum(r["volume_usd"] for r in all_rows)
    fut_equity = [r for r in all_rows if r["class"] == "equity"]
    fut_commodity = [r for r in all_rows if r["class"] == "commodity"]

    return {
        "spot": None,  # Hyperliquid has no equity/commodity spot market
        "futures": {
            "total_volume_usd": fut_total,
            "equity_volume_usd": sum(r["volume_usd"] for r in fut_equity),
            "commodity_volume_usd": sum(r["volume_usd"] for r in fut_commodity),
            "equity_pct": pct(sum(r["volume_usd"] for r in fut_equity), fut_total),
            "commodity_pct": pct(sum(r["volume_usd"] for r in fut_commodity), fut_total),
            "equity_ranking": top(fut_equity, "volume_usd"),
            "commodity_ranking": top(fut_commodity, "volume_usd"),
            "top100_oi": top(all_rows, "oi_usd", 100),
        },
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
FETCHERS = {
    "binance": fetch_binance,
    "okx": fetch_okx,
    "coinbase": fetch_coinbase,
    "hyperliquid": fetch_hyperliquid,
}


def build_aggregate(exchanges, section):
    total = equity = commodity = 0.0
    for ex in exchanges.values():
        sec = ex.get(section)
        if not sec:
            continue
        total += sec.get("total_volume_usd", 0)
        equity += sec.get("equity_volume_usd", 0)
        commodity += sec.get("commodity_volume_usd", 0)
    return {
        "total_volume_usd": total,
        "equity_volume_usd": equity,
        "commodity_volume_usd": commodity,
        "equity_pct": pct(equity, total),
        "commodity_pct": pct(commodity, total),
    }


def main():
    exchanges = {}
    errors = []
    for name, fn in FETCHERS.items():
        try:
            print(f"Fetching {name}...", file=sys.stderr)
            exchanges[name] = fn()
            sub_errors = exchanges[name].pop("_errors", None)
            if sub_errors:
                errors.extend(f"{name}: {msg}" for msg in sub_errors)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {e}")
            traceback.print_exc()
            exchanges[name] = {"spot": None, "futures": None}

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "exchanges": exchanges,
        "aggregate": {
            "spot": build_aggregate(exchanges, "spot"),
            "futures": build_aggregate(exchanges, "futures"),
        },
        "errors": errors,
    }

    with open("data/data.json", "w") as fp:
        json.dump(output, fp, separators=(",", ":"))

    print(f"Wrote data/data.json ({'OK' if not errors else 'with errors: ' + str(errors)})")


if __name__ == "__main__":
    main()
