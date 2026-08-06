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

## Binance 合约(本机刷新)

`fapi.binance.com` 对 GitHub Actions 的服务器 IP 返回 451(地域限制)，所以公开页面的自动抓取拿不到
Binance 合约数据。`scripts/local_binance_futures_proxy.py` 是一个只监听 `localhost:8899` 的本地小
服务，从运行它的电脑直连 Binance(不经过 GitHub 的服务器)，配合页面上的"刷新合约数据(本机)"按钮使用
——**只在运行该服务的这台电脑上点按钮才有效**，其余数据不受影响。

设为开机自启(macOS，一次性设置)：

```bash
mkdir -p ~/Library/Application\ Support/rwa-screener/scripts
cp scripts/fetch_data.py scripts/local_binance_futures_proxy.py \
   ~/Library/Application\ Support/rwa-screener/scripts/
```

将 `com.rwascreener.binanceproxy.plist` 放到 `~/Library/LaunchAgents/`，`ProgramArguments` 指向上面
复制出去的 `local_binance_futures_proxy.py`(注意：不能指向 `~/Documents` 里的原始路径，macOS 的隐私保护
会拒绝 launchd 启动的进程读取 `~/Documents`)，然后：

```bash
launchctl load -w ~/Library/LaunchAgents/com.rwascreener.binanceproxy.plist
```

`~/Library/Application Support/` 下是一份拷贝，不是仓库里的原文件，`git pull` 不会自动更新它。每次改了
`fetch_data.py` 或 `local_binance_futures_proxy.py` 之后，都要重新拷贝 + 重启服务，不然按钮返回的还是旧逻辑
的数据（新加的字段会缺失）：

```bash
cp scripts/fetch_data.py scripts/local_binance_futures_proxy.py \
   ~/Library/Application\ Support/rwa-screener/scripts/
launchctl kickstart -k gui/$(id -u)/com.rwascreener.binanceproxy
```

卸载：

```bash
launchctl unload ~/Library/LaunchAgents/com.rwascreener.binanceproxy.plist
rm ~/Library/LaunchAgents/com.rwascreener.binanceproxy.plist
```

或者不装开机自启，想用的时候手动跑一次也可以：

```bash
python3 scripts/local_binance_futures_proxy.py
```
