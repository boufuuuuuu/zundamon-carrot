// GET /api/market/historical?symbol=7203&offset=7&offsetUnit=calendar_day&field=close
//   -> { result: { symbol, date, field, value, currency, provider, market, marketDateBasis,
//                  requestedOffset, offsetUnit, usedNearestPreviousTradingDay } }
// Standalone Vercel function for the public Zundamon x carrot page.
// Mirrors carrot's own /api/market/historical route + MarketDataService.lookupHistorical
// behaviour (including its market calendars); price data from Yahoo Finance (no API key).
module.exports = async (req, res) => {
  const symbol = (req.query.symbol || "").trim();
  const offset = Number(req.query.offset ?? "0");
  const offsetUnit = req.query.offsetUnit === "trading_day" ? "trading_day" : "calendar_day";
  const field = normalizeField(req.query.field ?? "close");

  if (!symbol) {
    return res.status(400).json({ error: "symbol is required" });
  }
  if (!Number.isFinite(offset) || offset < 0 || offset > 5000) {
    return res.status(400).json({ error: "offset must be between 0 and 5000" });
  }
  try {
    const result = await lookupHistorical({ symbol, offset, offsetUnit, field });
    return res.status(200).json({ result });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "historical lookup failed" });
  }
};

function normalizeField(raw) {
  const lower = String(raw).toLowerCase();
  if (raw === "始値" || lower === "open") return "open";
  if (raw === "高値" || lower === "high") return "high";
  if (raw === "安値" || lower === "low") return "low";
  return "close";
}

function canonicalSymbol(raw) {
  const s = String(raw).trim().toUpperCase();
  if (/^\d{4}$/.test(s)) return `${s}.T`;
  return s;
}

function toYahooSymbol(symbol) {
  const s = canonicalSymbol(symbol);
  if (s === "XAUUSD") return "GC=F";
  if (s === "XAGUSD") return "SI=F";
  if (s === "WTI") return "CL=F";
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|LTC)(USD|JPY|EUR)$/.test(s)) return `${s.slice(0, -3)}-${s.slice(-3)}`;
  if (/^[A-Z]{6}$/.test(s)) return `${s}=X`;
  return s;
}

function isCrypto(symbol) {
  return /^(BTC|ETH|SOL|XRP|DOGE|ADA|LTC)(USD|JPY|EUR)$/.test(canonicalSymbol(symbol));
}

function isFx(symbol) {
  const s = canonicalSymbol(symbol);
  return s === "XAUUSD" || s === "XAGUSD" || s === "WTI" || /^[A-Z]{6}$/.test(s);
}

function marketOf(symbol) {
  const s = canonicalSymbol(symbol);
  if (s.endsWith(".T")) return "TSE";
  if (isCrypto(s)) return "CRYPTO";
  if (isFx(s)) return "FX";
  return "NYSE";
}

function fallbackCurrency(symbol) {
  const s = canonicalSymbol(symbol);
  if (s.endsWith(".T")) return "JPY";
  if (isCrypto(s)) return s.slice(-3);
  if (isFx(s)) return s.slice(-3);
  return "USD";
}

const MARKET_TZ = { TSE: "Asia/Tokyo", NYSE: "America/New_York", CRYPTO: "UTC", FX: "UTC" };
const MARKET_BASIS = { TSE: "TSE日付基準", NYSE: "NY日付基準", CRYPTO: "UTC日付基準", FX: "FX日付基準" };

// Same 2026 holiday sets as carrot's lib/market/calendar.ts.
const HOLIDAYS = {
  TSE: new Set(["2026-01-01", "2026-01-02", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-31"]),
  NYSE: new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"])
};

function isWeekendKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

function isTradingKey(market, key) {
  if (market === "CRYPTO") return true;
  if (market === "FX") return !isWeekendKey(key);
  return !isWeekendKey(key) && !(HOLIDAYS[market] && HOLIDAYS[market].has(key));
}

function addDaysKey(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function previousTradingKey(market, key) {
  let cursor = addDaysKey(key, -1);
  for (let i = 0; i < 370; i++) {
    if (isTradingKey(market, cursor)) return cursor;
    cursor = addDaysKey(cursor, -1);
  }
  return cursor;
}

function dateKeyInTz(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function rangeForDays(days) {
  if (days <= 35) return "3mo";
  if (days <= 95) return "6mo";
  if (days <= 185) return "1y";
  if (days <= 370) return "2y";
  return "5y";
}

async function fetchChart(symbol, days) {
  const yahooSymbol = toYahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${rangeForDays(days)}&interval=1d`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (zundamon-carrot-public)" } });
  if (!response.ok) throw new Error(`履歴データがありません: ${canonicalSymbol(symbol)}`);
  const json = await response.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error(`履歴データがありません: ${canonicalSymbol(symbol)}`);
  return result;
}

function buildSeries(chart, symbol, days) {
  const market = marketOf(symbol);
  const tz = market === "TSE" || market === "NYSE" ? (chart.meta && chart.meta.exchangeTimezoneName) || MARKET_TZ[market] : "UTC";
  const timestamps = chart.timestamp || [];
  const quote = (chart.indicators && chart.indicators.quote && chart.indicators.quote[0]) || {};
  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close && quote.close[i];
    if (!Number.isFinite(close)) continue;
    const point = { date: dateKeyInTz(new Date(timestamps[i] * 1000), tz), close };
    if (Number.isFinite(quote.open && quote.open[i])) point.open = quote.open[i];
    if (Number.isFinite(quote.high && quote.high[i])) point.high = quote.high[i];
    if (Number.isFinite(quote.low && quote.low[i])) point.low = quote.low[i];
    if (Number.isFinite(quote.volume && quote.volume[i])) point.volume = quote.volume[i];
    byDate.set(point.date, point);
  }
  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return points.slice(-days);
}

// Same selection logic as carrot's selectHistoricalPoint.
function selectPoint(series, offset, offsetUnit, market) {
  const sorted = series
    .filter((point) => point.date && Number.isFinite(point.close))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return null;

  if (offsetUnit === "trading_day") {
    const index = sorted.length - 1 - offset;
    if (index < 0 || index >= sorted.length) return null;
    return { point: sorted[index], usedNearestPreviousTradingDay: false };
  }

  const targetKey = addDaysKey(dateKeyInTz(new Date(), MARKET_TZ[market]), -offset);
  const exact = sorted.find((point) => point.date === targetKey);
  if (exact) return { point: exact, usedNearestPreviousTradingDay: false };

  const previous = sorted.filter((point) => point.date <= targetKey).at(-1);
  if (previous) return { point: previous, usedNearestPreviousTradingDay: true };

  const calendarPrevious = previousTradingKey(market, targetKey);
  const calendarPoint = sorted.filter((point) => point.date <= calendarPrevious).at(-1);
  return calendarPoint ? { point: calendarPoint, usedNearestPreviousTradingDay: true } : null;
}

async function lookupHistorical(input) {
  const symbol = canonicalSymbol(input.symbol);
  const market = marketOf(symbol);
  const lookbackDays = input.offsetUnit === "trading_day"
    ? Math.max(input.offset + 10, 40)
    : Math.max(input.offset + 14, 40);

  const chart = await fetchChart(symbol, lookbackDays);
  const series = buildSeries(chart, symbol, lookbackDays);
  const selected = selectPoint(series, input.offset, input.offsetUnit, market);
  if (!selected) throw new Error(`履歴データを選択できません: ${symbol}`);

  const value = Number.isFinite(selected.point[input.field]) ? selected.point[input.field] : selected.point.close;
  const currency = (chart.meta && chart.meta.currency) || fallbackCurrency(symbol);

  return {
    symbol,
    date: selected.point.date,
    field: input.field,
    value,
    currency,
    provider: "yahoo",
    market,
    marketDateBasis: MARKET_BASIS[market],
    requestedOffset: input.offset,
    offsetUnit: input.offsetUnit,
    usedNearestPreviousTradingDay: selected.usedNearestPreviousTradingDay
  };
}
