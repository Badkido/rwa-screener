const EXCHANGE_LABELS = {
  binance: "Binance",
  okx: "OKX",
  coinbase: "Coinbase",
  hyperliquid: "Hyperliquid",
};

const fmtUsd = (n) => {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(2);
};
const fmtPct = (n) => (n == null ? "—" : n.toFixed(1) + "%");
const fmtPrice = (n) => {
  if (n == null) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
};
const fmtChange = (n) => {
  if (n == null || Number.isNaN(n)) return '<span class="v-muted">—</span>';
  const cls = n >= 0 ? "up" : "down";
  const sign = n >= 0 ? "+" : "";
  return `<span class="${cls}">${sign}${n.toFixed(2)}%</span>`;
};

let DATA = null;
let currentExchange = "all";

const LOCAL_PROXY_URL = "http://localhost:8899/binance-futures";

function recomputeAggregate(section) {
  let total = 0,
    equity = 0,
    commodity = 0;
  let oiTotal = 0,
    oiEquity = 0,
    oiCommodity = 0;
  for (const ex of Object.keys(EXCHANGE_LABELS)) {
    const sec = DATA.exchanges[ex] && DATA.exchanges[ex][section];
    if (!sec) continue;
    total += sec.total_volume_usd || 0;
    equity += sec.equity_volume_usd || 0;
    commodity += sec.commodity_volume_usd || 0;
    oiTotal += sec.total_oi_usd || 0;
    oiEquity += sec.equity_oi_usd || 0;
    oiCommodity += sec.commodity_oi_usd || 0;
  }
  DATA.aggregate[section] = {
    total_volume_usd: total,
    equity_volume_usd: equity,
    commodity_volume_usd: commodity,
    equity_pct: total ? Math.round((equity / total) * 10000) / 100 : 0,
    commodity_pct: total ? Math.round((commodity / total) * 10000) / 100 : 0,
    total_oi_usd: oiTotal,
    equity_oi_usd: oiEquity,
    commodity_oi_usd: oiCommodity,
    equity_oi_pct: oiTotal ? Math.round((oiEquity / oiTotal) * 10000) / 100 : 0,
    commodity_oi_pct: oiTotal ? Math.round((oiCommodity / oiTotal) * 10000) / 100 : 0,
  };
}

async function refreshBinanceFutures(statusEl) {
  statusEl.textContent = "正在从本地服务拉取…";
  statusEl.className = "refresh-status";
  try {
    const res = await fetch(LOCAL_PROXY_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("本地服务返回 " + res.status);
    const data = await res.json();
    DATA.exchanges.binance.futures = data;
    recomputeAggregate("futures");
    render();
  } catch (err) {
    statusEl.textContent =
      "本地服务不可用 — 请确认后台代理正在运行 (点击查看说明)";
    statusEl.className = "refresh-status refresh-error";
    statusEl.title = String(err);
  }
}

function binanceFuturesRefreshTile() {
  const div = document.createElement("div");
  div.className = "stat-tile";
  div.innerHTML = `
    <div class="stat-label">合约 24h 交易总量</div>
    <div class="stat-value">—</div>
    <button class="refresh-btn" type="button">刷新合约数据(本机)</button>
    <div class="refresh-status"></div>
  `;
  const btn = div.querySelector(".refresh-btn");
  const statusEl = div.querySelector(".refresh-status");
  btn.addEventListener("click", () => refreshBinanceFutures(statusEl));
  return div;
}

async function load() {
  const res = await fetch("data/data.json", { cache: "no-store" });
  if (!res.ok) throw new Error("data.json fetch failed: " + res.status);
  DATA = await res.json();
  render();
}

function statTile(label, section, keys = {}) {
  const {
    total = "total_volume_usd",
    equity = "equity_volume_usd",
    commodity = "commodity_volume_usd",
    equityPct = "equity_pct",
    commodityPct = "commodity_pct",
  } = keys;
  const tpl = document.getElementById("tpl-stat-tile");
  const node = tpl.content.cloneNode(true);
  node.querySelector(".stat-label").textContent = label;
  if (!section || !section[total]) {
    node.querySelector(".stat-value").textContent = "—";
    node.querySelector(".stat-meter").remove();
    return node;
  }
  node.querySelector(".stat-value").textContent = fmtUsd(section[total]);
  const eqPct = section[equityPct] || 0;
  const coPct = section[commodityPct] || 0;
  node.querySelector(".meter-equity").style.width = eqPct + "%";
  node.querySelector(".meter-commodity").style.width = coPct + "%";
  node.querySelector(".v-equity").textContent =
    fmtUsd(section[equity]) + " (" + fmtPct(eqPct) + ")";
  node.querySelector(".v-commodity").textContent =
    fmtUsd(section[commodity]) + " (" + fmtPct(coPct) + ")";
  return node;
}

const OI_KEYS = {
  total: "total_oi_usd",
  equity: "equity_oi_usd",
  commodity: "commodity_oi_usd",
  equityPct: "equity_oi_pct",
  commodityPct: "commodity_oi_pct",
};

function rankingTable(rows, opts = {}) {
  const { showExchange = false, oi = false } = opts;
  if (!rows || !rows.length) {
    const div = document.createElement("div");
    div.className = "empty-note";
    div.textContent = "暂无数据";
    return div;
  }
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr>
      <th>#</th>
      <th>标的</th>
      ${showExchange ? "<th>交易所</th>" : ""}
      <th>价格</th>
      <th>24h涨跌</th>
      ${oi ? "<th>持仓量(OI)</th>" : ""}
      <th>24h成交额</th>
    </tr></thead>
    <tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="rank-cell">${i + 1}</td>
      <td>${r.symbol}</td>
      ${showExchange ? `<td>${EXCHANGE_LABELS[r.exchange] || r.exchange}</td>` : ""}
      <td>${fmtPrice(r.price)}</td>
      <td>${fmtChange(r.change_pct)}</td>
      ${oi ? `<td>${fmtUsd(r.oi_usd)}</td>` : ""}
      <td>${fmtUsd(r.volume_usd)}</td>`;
    tbody.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

function withExchangeTag(rows, ex) {
  return (rows || []).map((r) => ({ ...r, exchange: ex }));
}

function combineAcrossExchanges(sectionKey, listKey, sortKey, n = 100) {
  let all = [];
  for (const ex of Object.keys(EXCHANGE_LABELS)) {
    const sec = DATA.exchanges[ex] && DATA.exchanges[ex][sectionKey];
    if (!sec) continue;
    all = all.concat(withExchangeTag(sec[listKey], ex));
  }
  all.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
  return all.slice(0, n);
}

function section(title, note, contentNode) {
  const sec = document.createElement("section");
  sec.className = "section";
  const h = document.createElement("h2");
  h.className = "section-title";
  h.innerHTML = `${title} ${note ? `<span class="note">${note}</span>` : ""}`;
  sec.appendChild(h);
  sec.appendChild(contentNode);
  return sec;
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  document.getElementById("updated-at").textContent =
    "最后更新: " + new Date(DATA.generated_at).toLocaleString("zh-CN");
  const errBadge = document.getElementById("errors-badge");
  if (DATA.errors && DATA.errors.length) {
    errBadge.hidden = false;
    errBadge.textContent = `${DATA.errors.length} 个数据源出错`;
    errBadge.title = DATA.errors.join("\n");
  } else {
    errBadge.hidden = true;
  }

  if (currentExchange === "all") {
    renderAll(app);
  } else {
    renderExchange(app, currentExchange);
  }
}

function renderAll(app) {
  const overview = document.createElement("div");
  overview.className = "stat-grid";
  overview.appendChild(statTile("现货 24h 交易总量 (全部交易所)", DATA.aggregate.spot));
  overview.appendChild(statTile("合约 24h 交易总量 (全部交易所)", DATA.aggregate.futures));
  overview.appendChild(statTile("合约 Open Interest (全部交易所)", DATA.aggregate.futures, OI_KEYS));
  app.appendChild(
    section("总览", "四家交易所合计，仅统计 USDT 计价交易对", overview)
  );

  const perExGrid = document.createElement("div");
  perExGrid.className = "stat-grid";
  for (const ex of Object.keys(EXCHANGE_LABELS)) {
    const spot = DATA.exchanges[ex] && DATA.exchanges[ex].spot;
    const fut = DATA.exchanges[ex] && DATA.exchanges[ex].futures;
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="section-title" style="font-size:14px;margin-bottom:6px">${EXCHANGE_LABELS[ex]}</div>`;
    const g = document.createElement("div");
    g.style.display = "grid";
    g.style.gap = "8px";
    g.appendChild(statTile("现货", spot));
    if (ex === "binance" && !fut) {
      g.appendChild(binanceFuturesRefreshTile());
    } else {
      g.appendChild(statTile("合约 24h 交易总量", fut));
      g.appendChild(statTile("合约 Open Interest", fut, OI_KEYS));
    }
    wrap.appendChild(g);
    perExGrid.appendChild(wrap);
  }
  app.appendChild(section("分交易所总览", null, perExGrid));

  const eqSpot = combineAcrossExchanges("spot", "equity_ranking", "volume_usd", 200);
  const coSpot = combineAcrossExchanges("spot", "commodity_ranking", "volume_usd", 200);
  const twoColSpot = document.createElement("div");
  twoColSpot.className = "two-col";
  twoColSpot.appendChild(rankingTable(eqSpot, { showExchange: true }));
  twoColSpot.appendChild(rankingTable(coSpot, { showExchange: true }));
  app.appendChild(section("现货 — Equity / Commodity 交易量排名", "全部交易所合并排序", twoColSpot));

  const eqFut = combineAcrossExchanges("futures", "equity_ranking", "volume_usd", 200);
  const coFut = combineAcrossExchanges("futures", "commodity_ranking", "volume_usd", 200);
  const twoColFut = document.createElement("div");
  twoColFut.className = "two-col";
  twoColFut.appendChild(rankingTable(eqFut, { showExchange: true }));
  twoColFut.appendChild(rankingTable(coFut, { showExchange: true }));
  app.appendChild(section("合约 — Equity / Commodity 交易量排名", "全部交易所合并排序", twoColFut));

  const top100Spot = combineAcrossExchanges("spot", "top100", "volume_usd", 100);
  app.appendChild(
    section("现货 Top 100 (全部币种)", "按24h成交额，跨交易所合并", rankingTable(top100Spot, { showExchange: true }))
  );

  const top100Oi = combineAcrossExchanges("futures", "top100_oi", "oi_usd", 100);
  app.appendChild(
    section("合约 Top 100 by Open Interest", "按持仓量，跨交易所合并", rankingTable(top100Oi, { showExchange: true, oi: true }))
  );
}

function renderExchange(app, ex) {
  const data = DATA.exchanges[ex];
  const label = EXCHANGE_LABELS[ex];
  if (!data) {
    app.appendChild(section(label, null, (() => { const d = document.createElement("div"); d.className = "empty-note"; d.textContent = "数据不可用"; return d; })()));
    return;
  }

  const overview = document.createElement("div");
  overview.className = "stat-grid";
  overview.appendChild(statTile("现货 24h 交易总量", data.spot));
  if (ex === "binance" && !data.futures) {
    overview.appendChild(binanceFuturesRefreshTile());
  } else {
    overview.appendChild(statTile("合约 24h 交易总量", data.futures));
    overview.appendChild(statTile("合约 Open Interest", data.futures, OI_KEYS));
  }
  app.appendChild(section(label + " 总览", null, overview));

  if (data.spot) {
    const twoCol = document.createElement("div");
    twoCol.className = "two-col";
    twoCol.appendChild(rankingTable(data.spot.equity_ranking));
    twoCol.appendChild(rankingTable(data.spot.commodity_ranking));
    app.appendChild(section("现货 — Equity / Commodity 交易量排名", null, twoCol));
    app.appendChild(section("现货 Top 100", "按24h成交额", rankingTable(data.spot.top100)));
  } else {
    app.appendChild(section("现货", null, (() => { const d = document.createElement("div"); d.className = "empty-note"; d.textContent = `${label} 无现货市场`; return d; })()));
  }

  if (data.futures) {
    const twoCol2 = document.createElement("div");
    twoCol2.className = "two-col";
    twoCol2.appendChild(rankingTable(data.futures.equity_ranking));
    twoCol2.appendChild(rankingTable(data.futures.commodity_ranking));
    app.appendChild(section("合约 — Equity / Commodity 交易量排名", null, twoCol2));
    app.appendChild(
      section("合约 Top 100 by Open Interest", null, rankingTable(data.futures.top100_oi, { oi: true }))
    );
  }
}

document.getElementById("exchange-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  currentExchange = btn.dataset.ex;
  if (DATA) render();
});

load().catch((err) => {
  document.getElementById("app").innerHTML = `<div class="empty-note">数据加载失败: ${err.message}</div>`;
  console.error(err);
});
