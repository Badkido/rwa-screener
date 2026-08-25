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

let HISTORY = [];

async function load() {
  const res = await fetch("data/data.json", { cache: "no-store" });
  if (!res.ok) throw new Error("data.json fetch failed: " + res.status);
  DATA = await res.json();

  try {
    const histRes = await fetch("data/history.jsonl", { cache: "no-store" });
    if (histRes.ok) {
      const text = await histRes.text();
      HISTORY = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
  } catch (err) {
    console.warn("history.jsonl load failed", err);
  }

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

// ---------------------------------------------------------------------------
// Trend charts (daily bars, built client-side from data/history.jsonl)
// ---------------------------------------------------------------------------
const RANGE_PRESETS = [
  { label: "7天", days: 7 },
  { label: "30天", days: 30 },
];

function dailyBuckets(ctxKey, sectionKey) {
  const byDate = new Map();
  for (const snap of HISTORY) {
    const date = snap.t.slice(0, 10);
    const src = ctxKey === "agg" ? snap.agg : snap[ctxKey];
    const sec = src && src[sectionKey];
    if (!sec) continue;
    byDate.set(date, sec); // chronological order -> last snapshot of the day wins
  }
  return Array.from(byDate.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, sec]) => ({ date, sec }));
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function trendBarChart(buckets, seriesDef) {
  const barW = 7;
  const barGap = 2;
  const groupGap = 12;
  const groupW = seriesDef.length * barW + (seriesDef.length - 1) * barGap;
  const step = groupW + groupGap;
  const leftPad = 52;
  const rightPad = 10;
  const topPad = 10;
  const chartH = 150;
  const bottomPad = 24;
  const width = leftPad + rightPad + Math.max(buckets.length, 1) * step;
  const height = topPad + chartH + bottomPad;

  const maxVal = niceMax(
    Math.max(1, ...buckets.flatMap((b) => seriesDef.map((s) => b.sec[s.key] || 0)))
  );
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => maxVal * f);
  const yToPx = (v) => topPad + chartH - (v / maxVal) * chartH;

  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="trend-svg">`;

  // gridlines + y labels
  yTicks.forEach((v) => {
    const y = yToPx(v);
    svg += `<line x1="${leftPad}" y1="${y}" x2="${width - rightPad}" y2="${y}" class="trend-gridline" />`;
    svg += `<text x="${leftPad - 8}" y="${y + 3}" class="trend-ylabel" text-anchor="end">${fmtUsd(v)}</text>`;
  });

  buckets.forEach((b, i) => {
    const gx = leftPad + i * step;
    seriesDef.forEach((s, si) => {
      const val = b.sec[s.key] || 0;
      const y = yToPx(val);
      const h = topPad + chartH - y;
      const x = gx + si * (barW + barGap);
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h, 0)}" rx="2" class="trend-bar" style="fill:${s.color}" />`;
    });
    if (i % labelEvery === 0 || i === buckets.length - 1) {
      const label = b.date.slice(5).replace("-", "/");
      svg += `<text x="${gx + groupW / 2}" y="${height - 6}" class="trend-xlabel" text-anchor="middle">${label}</text>`;
    }
    // invisible hit target covering the whole day-group column
    svg += `<rect x="${gx - groupGap / 2}" y="${topPad}" width="${step}" height="${chartH}" class="trend-hit" tabindex="0" data-i="${i}" />`;
  });

  svg += `</svg>`;

  const wrap = document.createElement("div");
  wrap.className = "trend-chart-wrap";
  wrap.innerHTML = svg;

  const tooltip = document.createElement("div");
  tooltip.className = "trend-tooltip";
  tooltip.hidden = true;
  wrap.appendChild(tooltip);

  const showTip = (i, clientX, clientY) => {
    const b = buckets[i];
    if (!b) return;
    const rect = wrap.getBoundingClientRect();
    tooltip.innerHTML = "";
    const dateEl = document.createElement("div");
    dateEl.className = "trend-tooltip-date";
    dateEl.textContent = b.date;
    tooltip.appendChild(dateEl);
    seriesDef.forEach((s) => {
      const row = document.createElement("div");
      row.className = "trend-tooltip-row";
      const key = document.createElement("span");
      key.className = "trend-tooltip-key";
      key.style.background = s.color;
      const name = document.createElement("span");
      name.textContent = s.label;
      const val = document.createElement("b");
      val.textContent = fmtUsd(b.sec[s.key] || 0);
      row.append(key, name, val);
      tooltip.appendChild(row);
    });
    tooltip.hidden = false;
    tooltip.style.left = Math.min(clientX - rect.left + 12, rect.width - 160) + "px";
    tooltip.style.top = clientY - rect.top - 40 + "px";
  };
  const hideTip = () => {
    tooltip.hidden = true;
  };

  wrap.querySelectorAll(".trend-hit").forEach((hit) => {
    const i = Number(hit.dataset.i);
    hit.addEventListener("mousemove", (e) => showTip(i, e.clientX, e.clientY));
    hit.addEventListener("mouseleave", hideTip);
    hit.addEventListener("focus", (e) => {
      const r = hit.getBoundingClientRect();
      showTip(i, r.left + r.width / 2, r.top);
    });
    hit.addEventListener("blur", hideTip);
  });

  return wrap;
}

function trendLegend(seriesDef) {
  const div = document.createElement("div");
  div.className = "trend-legend";
  seriesDef.forEach((s) => {
    const item = document.createElement("span");
    item.className = "trend-legend-item";
    item.innerHTML = `<i class="trend-legend-swatch" style="background:${s.color}"></i>`;
    item.append(s.label);
    div.appendChild(item);
  });
  return div;
}

const VOLUME_SERIES = [
  { key: "total_volume_usd", label: "Total", color: "var(--text-muted)" },
  { key: "equity_volume_usd", label: "Equity", color: "var(--series-equity)" },
  { key: "commodity_volume_usd", label: "Commodity", color: "var(--series-commodity)" },
];
const OI_SERIES = [
  { key: "total_oi_usd", label: "Total OI", color: "var(--text-muted)" },
  { key: "equity_oi_usd", label: "Equity OI", color: "var(--series-equity)" },
  { key: "commodity_oi_usd", label: "Commodity OI", color: "var(--series-commodity)" },
];

function trendCard(title, ctxKey, sectionKey, seriesDef, days) {
  const buckets = dailyBuckets(ctxKey, sectionKey).slice(days ? -days : 0);
  const card = document.createElement("div");
  card.className = "trend-card";
  const h = document.createElement("div");
  h.className = "trend-card-title";
  h.textContent = title;
  card.appendChild(h);
  if (!buckets.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "暂无历史数据(数据从这次更新开始累积)";
    card.appendChild(empty);
    return card;
  }
  card.appendChild(trendLegend(seriesDef));
  card.appendChild(trendBarChart(buckets, seriesDef));
  return card;
}

function trendSection(ctxKey, label) {
  const wrap = document.createElement("div");
  const rangeRow = document.createElement("div");
  rangeRow.className = "range-row";
  let currentDays = 7;
  const grid = document.createElement("div");
  grid.className = "trend-grid";

  const renderCards = () => {
    grid.innerHTML = "";
    grid.appendChild(trendCard("现货成交量", ctxKey, "spot", VOLUME_SERIES, currentDays));
    grid.appendChild(trendCard("合约成交量", ctxKey, "futures", VOLUME_SERIES, currentDays));
    grid.appendChild(trendCard("合约 Open Interest", ctxKey, "futures", OI_SERIES, currentDays));
  };

  RANGE_PRESETS.forEach((preset, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "range-btn" + (i === 0 ? " active" : "");
    btn.textContent = preset.label;
    btn.addEventListener("click", () => {
      rangeRow.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentDays = preset.days;
      renderCards();
    });
    rangeRow.appendChild(btn);
  });

  wrap.appendChild(rangeRow);
  wrap.appendChild(grid);
  renderCards();
  return section(label + " 趋势", "按天汇总(取当日最后一条数据)", wrap);
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
  app.appendChild(trendSection("agg", "总览"));

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
  app.appendChild(trendSection(ex, label));

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
