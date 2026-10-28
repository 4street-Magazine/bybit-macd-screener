/**
 * MACD SCREENER (OKX data) + paper-trading sim for Cloudflare Workers.
 *
 * MODE "screen": scanner only. MODE "sim": leveraged PAPER trades from screener crosses (fake money).
 * MODE "trade": old MACD stop-and-reverse paper bot.
 *
 * OI filter (sim): a MACD cross is only traded when open interest grew at least OI_MIN_CHANGE over OI_LOOKBACK candles.
 *
 * SIM features: BTC-follower leverage (30x) vs other coins (10x), fixed margin per position,
 * TP_USDT: when a position reaches +TP_USDT net profit it is NOT closed; a retracing stop takes over
 * and follows the best price, giving back at most TRAIL_GIVEBACK of the peak profit. All P&L in USDT.
 *
 * Endpoints: GET /  GET /api/oi  GET /api/status  GET /api/trades  GET /api/universe  GET /api/screen  GET /api/followers
 *            POST /api/run  POST /api/reset   (Authorization: Bearer <ADMIN_TOKEN>)
 * Educational only. Not financial advice.
 */

// ============================== CONFIG ==============================
const OKX_HOST = "https://www.okx.com";

const DEFAULTS = {
  GRANULARITY: 900,           // seconds: 300 (5m), 900 (15m), 3600, 14400, 86400
  MODE: "sim",                // "screen" | "sim" | "trade"
  SCREEN_BATCH: 33,           // coins scanned per run (free plan: max 50 subrequests per run; OI filter uses 1)
  START_CASH: 10000,
  FEE: 0.001,
  SLIPPAGE: 0.0015,
  SHORT_CARRY_HOURLY: 0.0000125,

  MACD_FAST: 12, MACD_SLOW: 26, MACD_SIGNAL: 9,

  POSITION_PCT: 0.10,
  MAX_EXPOSURE: 0.80,
  MAX_POSITIONS: 22,
  SAFETY_STOP_PCT: 0.15,
  DAILY_LOSS_LIMIT: 0.04,
  MAX_DRAWDOWN: 0.20,
  HALT_DAYS: 5,

  MAX_SYMBOLS: 60,
  MIN_QUOTE_VOLUME: 1000000,
  UNIVERSE_REFRESH_H: 6,
  KLINE_LIMIT: 300,

  // --- MODE "sim" ---
  LEV_FOLLOW: 30,             // leverage for coins that follow BTC
  LEV_OTHER: 10,              // leverage for everything else
  FOLLOWERS: "",              // comma list of coins always treated as BTC followers, e.g. "DOGE,PEPE,SHIB"
  FOLLOWERS_ONLY: 1,          // 1 = scan and trade only BTC followers
  RESET_ID: "2",              // change this value (e.g. "3", "4") and redeploy to wipe the paper account and start afresh
  BTC_CORR: 0.6,              // a coin "follows BTC" when its return correlation with BTC is at least this
  CORR_BARS: 100,             // candles used for the correlation
  POSITION_MARGIN: 1,         // every position uses this much margin (USDT); size = margin x leverage. 0 = compounding margin
  SIM_MARGIN: 1.1,            // start funds = SIM_MARGIN x MAX_POSITIONS (a little above POSITION_MARGIN to cover fees)
  OI_FILTER: 1,               // 1 = only enter a MACD cross when open interest is rising (new money in the move). 0 = off
  OI_LOOKBACK: 4,             // OI change is measured over this many candles (4 x 15m = 1 hour)
  OI_MIN_CHANGE: 0.005,       // OI must have grown at least this much (0.005 = +0.5%) over the lookback
  MIN_SCORE: 0,               // minimum rating (0-8) to enter. 5 = STRONG only
  TPSL_MODE: "size",          // "size" = TP/SL as % of POSITION SIZE (price move), "atr" = volatility-scaled
  TP_USDT: 0.04,              // NET profit (USDT, after fees) at which the retracing stop switches on. 0 = old fixed-TP mode
  TP_SIZE_PCT: 0.16,          // size mode (only when TP_USDT = 0): take profit = 16% of position size
  SL_SIZE_PCT: 0.053,         // size mode: stop loss = 5.3% of position size (capped at 90% of margin)
  SL_ATR: 1.5,                // stop distance = 1.5 x ATR
  MIN_SL_PCT: 0.0035,         // stop never tighter than 0.35% price move
  MAX_SL_MARGIN: 0.30,        // stop never risks more than 30% of margin
  RR_MIN: 1.5,                // reward:risk for a rating-0 cross
  RR_MAX: 3,                  // reward:risk for a rating-8 cross
  TRAIL: 1,                   // 1 = trailing stop on (must stay on when TP_USDT > 0)
  TRAIL_GIVEBACK: 0.4,        // once trailing, the stop allows giving back at most 40% of the best profit so far
  SIM_FEE: 0.0005,            // taker fee per side, on notional
  SIM_FEE_MAKER: 0.0002,      // maker fee, used for take-profit exits
  SIM_SLIP: 0.0003,           // slippage per fill
  SIM_CHECK_BATCH: 10,        // open positions whose candles are re-fetched per run
};

const STABLES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "USDT", "EUR", "AEUR", "XUSD", "USD1", "PYUSD"]);
const INTERVALS = { 300: "5m", 900: "15m", 3600: "1H", 14400: "4H", 86400: "1D" };

function getCfg(env) {
  const c = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = env[k];
    if (v !== undefined && v !== "") c[k] = typeof DEFAULTS[k] === "number" ? Number(v) : v;
  }
  return c;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ============================ INDICATORS ============================
function ema(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += v[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function macd(c, fast, slow, sig) {
  const ef = ema(c, fast), es = ema(c, slow);
  const line = c.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const signal = new Array(c.length).fill(null);
  const first = line.findIndex((v) => v != null);
  if (first >= 0) ema(line.slice(first), sig).forEach((v, i) => { signal[first + i] = v; });
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

function rsi14(c, n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

/** Williams %R over the last n candles: 0 = at the high (overbought), -100 = at the low (oversold). */
function wr14(h, l, c, n = 14) {
  if (c.length < n) return null;
  const hh = Math.max(...h.slice(-n)), ll = Math.min(...l.slice(-n));
  return hh === ll ? null : ((hh - c[c.length - 1]) / (hh - ll)) * -100;
}

function adx14(h, l, c, n = 14) {
  const len = c.length;
  if (len < 2 * n + 2) return null;
  let str = 0, spdm = 0, smdm = 0;
  const dxs = [];
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= n) { str += tr; spdm += pdm; smdm += mdm; }
    else { str = str - str / n + tr; spdm = spdm - spdm / n + pdm; smdm = smdm - smdm / n + mdm; }
    if (i >= n) {
      const pdi = str ? (100 * spdm) / str : 0, mdi = str ? (100 * smdm) / str : 0;
      const sum = pdi + mdi;
      dxs.push({ dx: sum ? (100 * Math.abs(pdi - mdi)) / sum : 0, pdi, mdi });
    }
  }
  if (dxs.length < n) return null;
  let a = 0;
  for (let i = 0; i < n; i++) a += dxs[i].dx;
  a /= n;
  for (let i = n; i < dxs.length; i++) a = (a * (n - 1) + dxs[i].dx) / n;
  const lastD = dxs[dxs.length - 1];
  return { adx: a, pdi: lastD.pdi, mdi: lastD.mdi };
}

/** ATR as a fraction of the latest close (Wilder smoothing). */
function atrPct(h, l, c, n = 14) {
  if (c.length <= n + 1) return null;
  const tr = (i) => Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr(i);
  a /= n;
  for (let i = n + 1; i < c.length; i++) a = (a * (n - 1) + tr(i)) / n;
  return a / c[c.length - 1];
}

function compute(candles, cfg) {
  const m = macd(candles.map((x) => x[4]), cfg.MACD_FAST, cfg.MACD_SLOW, cfg.MACD_SIGNAL);
  return {
    t: candles.map((x) => x[0]), l: candles.map((x) => x[1]), h: candles.map((x) => x[2]),
    o: candles.map((x) => x[3]), c: candles.map((x) => x[4]), hist: m.hist, line: m.line,
  };
}

// ============================== SIGNAL ==============================
function macdCross(ind, i) {
  const a = ind.hist[i - 1], b = ind.hist[i];
  if (i < 1 || a == null || b == null) return 0;
  if (a <= 0 && b > 0) return 1;
  if (a >= 0 && b < 0) return -1;
  return 0;
}

/** Rates a cross out of 8 (ADX, DI agreement, 200-EMA side, zero-line side, cross sharpness, RSI stretch). */
function rate(side, ind, last, ci) {
  const c = ind.c;
  const a = adx14(ind.h, ind.l, c);
  const r = rsi14(c);
  const e = ema(c, 200), eLast = e[e.length - 1];
  let pts = 0;

  let trend = "no data";
  if (a) {
    pts += a.adx >= 40 ? 3 : a.adx >= 25 ? 2 : a.adx >= 20 ? 1 : 0;
    if (side > 0 ? a.pdi > a.mdi : a.mdi > a.pdi) pts += 1;
    const dir = a.pdi > a.mdi ? "uptrend" : "downtrend";
    trend = a.adx >= 50 ? `very strong ${dir}` : a.adx >= 40 ? `strong ${dir}` : a.adx >= 25 ? dir
      : a.adx >= 20 ? `weak ${dir}` : "choppy, no clear trend";
  }

  const emaOk = eLast != null && (side > 0 ? c[last] > eLast : c[last] < eLast);
  if (emaOk) pts += 2;

  const lineAtCross = ind.line[ci];
  const zeroOk = lineAtCross != null && (side > 0 ? lineAtCross > 0 : lineAtCross < 0);
  if (zeroOk) pts += 1;

  let sum = 0, n = 0;
  for (let j = Math.max(1, ci - 50); j < ci; j++) if (ind.hist[j] != null) { sum += Math.abs(ind.hist[j]); n++; }
  const ratio = n && sum ? Math.abs(ind.hist[ci]) / (sum / n) : 1;
  if (ratio >= 1.5) pts += 1;

  if (r != null && (side > 0 ? r > 75 : r < 25)) pts -= 1;

  const score = Math.max(0, pts);
  const label = score >= 7 ? "VERY STRONG" : score >= 5 ? "STRONG" : score >= 3 ? "MODERATE" : "WEAK";
  return { score, label, trend, adx: a ? a.adx : null, rsi: r, emaOk, zeroOk, ratio };
}

// ============================== ENGINE (MODE "trade") ==============================
function newState(cfg) {
  return {
    cash: cfg.START_CASH, pos: {}, pending: {}, peak: cfg.START_CASH, day: null,
    dayStartEq: cfg.START_CASH, halted: false, haltUntil: 0, lastBar: {},
    closed: [], events: [], curve: [], mark: {}, equity: cfg.START_CASH,
    stats: { n: 0, wins: 0, gw: 0, gl: 0, sumPct: 0, longN: 0, longPnl: 0, shortN: 0, shortPnl: 0 },
    universe: [], universeAt: 0, universeSource: "", universeNote: "", zone: {},
    screen: {}, screenBar: {}, btc: null, corr: {}, oi: {}, oiNow: {},
    startedAt: nowSec(), lastTick: 0, lastError: null, resetId: String(cfg.RESET_ID ?? ""),
  };
}

const SIDE = (x) => (x > 0 ? "LONG" : "SHORT");

class Engine {
  constructor(cfg, s) { this.cfg = cfg; this.s = s; this.px = { ...(s.mark || {}) }; }

  emit(kind, sym, t, price, qty, info) {
    this.s.events.unshift({ t, kind, sym, price, qty, info });
    if (this.s.events.length > 60) this.s.events.length = 60;
  }
  value(k, p) { const px = this.px[k] ?? p.entry; return Math.max(0, p.margin + p.side * (px - p.entry) * p.qty); }
  equity() { return Object.entries(this.s.pos).reduce((e, [k, p]) => e + this.value(k, p), this.s.cash); }
  exposure() { return Object.entries(this.s.pos).reduce((e, [k, p]) => e + p.qty * (this.px[k] ?? p.entry), 0); }
  dailyLimitHit() { return 1 - this.equity() / this.s.dayStartEq >= this.cfg.DAILY_LOSS_LIMIT; }

  _open(sym, price, t, side) {
    const { cfg, s } = this;
    if (s.halted || this.dailyLimitHit() || Object.keys(s.pos).length >= cfg.MAX_POSITIONS) return;
    const eq = this.equity();
    const fill = price * (1 + side * cfg.SLIPPAGE);
    const notional = Math.min(eq * cfg.POSITION_PCT, eq * cfg.MAX_EXPOSURE - this.exposure(), s.cash / (1 + cfg.FEE));
    if (notional < 10) return;
    const qty = notional / fill, fees = notional * cfg.FEE;
    s.cash -= notional + fees;
    const stop = cfg.SAFETY_STOP_PCT > 0 ? fill * (1 - side * cfg.SAFETY_STOP_PCT) : null;
    s.pos[sym] = { side, qty, entry: fill, margin: notional, stop, t, fees };
    this.emit("OPEN " + SIDE(side), sym, t, fill, qty, `$${notional.toFixed(0)}${stop ? ", safety stop " + stop.toPrecision(5) : ""}`);
  }

  _close(sym, price, t, reason) {
    const { cfg, s } = this;
    const pos = s.pos[sym];
    delete s.pos[sym];
    const fill = price * (1 - pos.side * cfg.SLIPPAGE);
    const gross = pos.side * (fill - pos.entry) * pos.qty;
    const exitFee = pos.qty * fill * cfg.FEE;
    const carry = pos.side < 0 ? pos.margin * cfg.SHORT_CARRY_HOURLY * ((t - pos.t) / 3600) : 0;
    const proceeds = Math.max(0, pos.margin + gross - exitFee - carry);
    s.cash += proceeds;
    const pnl = proceeds - (pos.margin + pos.fees), pct = pnl / pos.margin;
    s.closed.push({ sym, side: pos.side, tIn: pos.t, tOut: t, entry: pos.entry, exit: fill, qty: pos.qty, pnl, pct, reason });
    if (s.closed.length > 300) s.closed.shift();
    const st = s.stats;
    st.n++; st.sumPct += pct;
    if (pnl > 0) { st.wins++; st.gw += pnl; } else st.gl += -pnl;
    if (pos.side > 0) { st.longN++; st.longPnl += pnl; } else { st.shortN++; st.shortPnl += pnl; }
    this.emit("CLOSE " + SIDE(pos.side), sym, t, fill, pos.qty, `${reason}, P&L $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
  }

  processBar(sym, ind, i) {
    const { cfg, s } = this;
    const t = ind.t[i], o = ind.o[i], h = ind.h[i], l = ind.l[i], c = ind.c[i];

    const day = Math.floor(t / 86400);
    if (s.day !== day) { s.day = day; s.dayStartEq = this.equity(); }

    const order = s.pending[sym];
    delete s.pending[sym];
    if (order === "close") { if (s.pos[sym]) this._close(sym, o, t, "kill switch"); }
    else if (order && typeof order === "object" && t <= order.t + 2 * cfg.GRANULARITY) {
      const p = s.pos[sym];
      if (p && p.side !== order.side) { this._close(sym, o, t, "MACD flip"); this._open(sym, o, t, order.side); }
      else if (!p) this._open(sym, o, t, order.side);
    }

    const pos = s.pos[sym];
    if (pos && pos.stop) {
      if (pos.side > 0 && l <= pos.stop) this._close(sym, Math.min(o, pos.stop), t, "safety stop");
      else if (pos.side < 0 && h >= pos.stop) this._close(sym, Math.max(o, pos.stop), t, "safety stop");
    }

    this.px[sym] = c;
    const eq = this.equity();
    s.peak = Math.max(s.peak, eq);
    if (s.halted && t >= s.haltUntil) { s.halted = false; s.peak = eq; this.emit("RESUME", sym, t, c, 0, "cooldown over"); }
    if (!s.halted && 1 - eq / s.peak >= cfg.MAX_DRAWDOWN) {
      s.halted = true;
      s.haltUntil = t + cfg.HALT_DAYS * 86400;
      s.pending = Object.fromEntries(Object.keys(s.pos).map((k) => [k, "close"]));
      this.emit("HALT", sym, t, c, 0, `drawdown ${((1 - eq / s.peak) * 100).toFixed(1)}%, flattening`);
    }
    if (s.halted) return null;

    const side = macdCross(ind, i);
    if (!side) return null;
    const p = s.pos[sym];
    if (p) { if (p.side !== side) s.pending[sym] = { side, t }; return null; }
    if (this.dailyLimitHit()) return null;
    return { sym, t, side, score: Math.abs(ind.hist[i]) / c };
  }

  assignEntries(cands) {
    const { cfg, s } = this;
    if (s.halted) return;
    const queued = Object.entries(s.pending).filter(([k, v]) => typeof v === "object" && !s.pos[k]).length;
    let free = cfg.MAX_POSITIONS - Object.keys(s.pos).length - queued;
    for (const c of cands.sort((a, b) => b.score - a.score)) {
      if (free <= 0) break;
      if (s.pending[c.sym] || s.pos[c.sym]) continue;
      s.pending[c.sym] = { side: c.side, t: c.t };
      free--;
      this.emit("SIGNAL", c.sym, c.t, 0, 0, `MACD cross -> ${SIDE(c.side)}; fills next bar`);
    }
  }
}

// ============================== DATA (OKX + CoinGecko) ==========================
const toInst = (sym) => sym.replace(/USDT$/, "-USDT");

async function okx(path, params) {
  const r = await fetch(`${OKX_HOST}${path}?${new URLSearchParams(params)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  const j = await r.json();
  if (j.code !== "0") throw new Error(`OKX ${j.code}: ${j.msg}`);
  return j.data;
}

async function fetchTickers(cfg) {
  const list = await okx("/api/v5/market/tickers", { instType: "SPOT" });
  const prices = {}, volumes = {};
  for (const t of list) {
    if (!t.instId.endsWith("-USDT")) continue;
    const sym = t.instId.replace("-", "");
    prices[sym] = Number(t.last);
    volumes[sym] = Number(t.volCcy24h);
  }
  return { prices, volumes };
}

async function fetchKlines(cfg, sym, now) {
  const bar = INTERVALS[cfg.GRANULARITY];
  if (!bar) throw new Error("Unsupported GRANULARITY");
  const list = await okx("/api/v5/market/candles", { instId: toInst(sym), bar, limit: String(Math.min(300, cfg.KLINE_LIMIT)) });
  return list
    .map((k) => [Math.floor(+k[0] / 1000), +k[3], +k[2], +k[1], +k[4], +k[5]])
    .sort((a, b) => a[0] - b[0])
    .filter((c) => c[0] + cfg.GRANULARITY <= now);
}

/** Open interest (USD) for every USDT perpetual, in ONE request. Keys look like "BTCUSDT". */
async function fetchOI() {
  const list = await okx("/api/v5/public/open-interest", { instType: "SWAP" });
  const out = {};
  for (const x of list) {
    if (!x.instId.endsWith("-USDT-SWAP")) continue;
    const v = Number(x.oiUsd);
    if (v > 0) out[x.instId.replace("-USDT-SWAP", "USDT")] = v;
  }
  return out;
}

/** Keeps one OI reading per candle per coin (taken at the first tick of the candle) plus the latest reading. */
function recordOI(cfg, s, oi, now) {
  const gran = cfg.GRANULARITY, bucket = Math.floor(now / gran) * gran;
  if (!s.oi) s.oi = {};
  if (!s.oiNow) s.oiNow = {};
  for (const sym of s.universe) {
    const v = oi[sym];
    if (!v) continue;
    const h = s.oi[sym] || (s.oi[sym] = []);
    if (!h.length || h[h.length - 1][0] < bucket) h.push([bucket, v]);
    while (h.length > cfg.OI_LOOKBACK + 3) h.shift();
    s.oiNow[sym] = v;
  }
}

/** OI change (fraction) over the lookback, or null while there is not enough history yet (warm-up). */
function oiChange(cfg, s, sym, now) {
  const gran = cfg.GRANULARITY, h = s.oi && s.oi[sym], cur = s.oiNow && s.oiNow[sym];
  if (!h || !cur) return null;
  const target = Math.floor(now / gran) * gran - cfg.OI_LOOKBACK * gran;
  let ref = null;
  for (const e of h) if (e[0] <= target) ref = e;
  if (!ref || !ref[1] || target - ref[0] > 2 * gran) return null;
  return cur / ref[1] - 1;
}

function oiData(s, cfg, now = nowSec()) {
  const rows = s.universe.map((sym) => ({ sym, oiUsd: (s.oiNow && s.oiNow[sym]) ?? null, change: oiChange(cfg, s, sym, now) }))
    .sort((a, b) => (b.change ?? -9) - (a.change ?? -9));
  return { filter: !!cfg.OI_FILTER, lookbackCandles: cfg.OI_LOOKBACK, minChange: cfg.OI_MIN_CHANGE,
    ready: rows.filter((r) => r.change != null).length, total: rows.length, coins: rows };
}

/** Pearson correlation of candle-to-candle returns between a coin and BTC (aligned by timestamp). */
function btcCorr(kl, btcMap, n) {
  if (!btcMap) return null;
  const xs = [], ys = [];
  for (let i = 1; i < kl.length; i++) {
    const b0 = btcMap[kl[i - 1][0]], b1 = btcMap[kl[i][0]];
    if (!b0 || !b1) continue;
    xs.push(kl[i][4] / kl[i - 1][4] - 1);
    ys.push(b1 / b0 - 1);
  }
  const m = Math.min(n, xs.length);
  if (m < 30) return null;
  const x = xs.slice(-m), y = ys.slice(-m);
  const mx = x.reduce((a, v) => a + v, 0) / m, my = y.reduce((a, v) => a + v, 0) / m;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < m; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** 30x for BTC followers, 10x for the rest. */
const forced = (cfg) => new Set(String(cfg.FOLLOWERS || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean).map((x) => (x.endsWith("USDT") ? x : x + "USDT")));
/** A coin is a follower if it is in the FOLLOWERS list, or its BTC correlation is high enough. */
const isFollower = (cfg, r, sym) => forced(cfg).has(sym) || (r.corr != null && r.corr >= cfg.BTC_CORR);
const levFor = (cfg, r, sym) => (isFollower(cfg, r, sym) ? cfg.
