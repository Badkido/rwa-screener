# RWA Screener

代币化股票 (equity) / 大宗商品 (commodity) 交易数据看板，覆盖 Binance、OKX、Coinbase、Hyperliquid。

- `scripts/fetch_data.py` — 从四家交易所公开 API 抓取现货/合约成交量与持仓量，按分类规则输出 `data/data.json`。仅用 Python 标准库，无需 `pip install`。
- `.github/workflows/update.yml` — 每 20 分钟自动运行抓取脚本并提交 `data/data.json`。
- `index.html` / `style.css` / `app.js` — 静态展示页面，读取同源的 `data/data.json`，托管在 GitHub Pages。

## 分类规则

| 交易所 | 依据 |
|---|---|
| Binance | 官方字段 `underlyingType`（合约）；现货 bStocks 通过 `原ticker+B` 与合约端交叉比对 |
| OKX | 官方字段 `instCategory`（3=equity, 4=commodity） |
| Coinbase | International Exchange 官方字段 `underlying_type`（EQUITY / COMMOD） |
| Hyperliquid | 无官方字段，按关键词规则人工分类 HIP-3 (`xyz`/`flx`/`vntl`/`km`/`cash`/`para`/`hyna`/`mkts`) 市场；main dex 视为纯加密货币，不计入 equity/commodity；forex 类资产(EUR/GBP/JPY/KRW)排除；指数/板块篮子(SP500/XYZ100等)归入 equity |

成交量按 USDT(或 USD/USDC) 计价对折算作为美元近似值，仅统计 USDⓈ-M / USDT 结算合约与 USDT 现货交易对。

## 本地运行抓取脚本

```bash
python3 scripts/fetch_data.py
```

会在 `data/data.json` 生成最新数据（需要能访问各交易所 API 的网络环境）。
