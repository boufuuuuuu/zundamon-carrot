// GET /api/market/series?symbol=AAPL&days=30 -> { series: [{ date, open, high, low, close, volume }] }
// Standalone Vercel function for the public Zundamon x carrot page.
// Mirrors carrot's own /api/market/series route contract; data from Yahoo Finance (no API key).
module.exports = async (req, res) => {
  const symbol = (req.query.symbol || "").trim();
  const days = Number(req.query.days ?? "30");
  if (!symbol) {
    return res.status(400).json({ error: "symbol is required" });
  }
  if (!Number.isFinite(days) || days <= 0 || days > 500) {
    return res.status(400).json({ error: "days must be between 1 and 500" });
  }
  try {
    const series = await fetchSeries(symbol, days);
    if (series.length === 0) throw new Error(`履歴データがありません: ${symbol}`);
    return res.status(200).json({ series });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "series fetch failed" });
  }
};

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

function isUtcDated(symbol) {
  const s = canonicalSymbol(symbol);
  if (s === "XAUUSD" || s === "XAGUSD" || s === "WTI") return true;
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|LTC)(USD|JPY|EUR)$/.test(s)) return true;
  if (/^[A-Z]{6}$/.test(s)) return true;
  return false;
}

function rangeForDays(days) {
  if (days <= 35) return "3mo";
  if (days <= 95) return "6mo";
  if (days <= 185) return "1y";
  if (days <= 370) return "2y";
  return "5y";
}

function dateKeyInTz(epochSec, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(epochSec * 1000));
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function fetchSeries(rawSymbol, days) {
  const symbol = canonicalSymbol(rawSymbol);
  const yahooSymbol = toYahooSymbol(symbol);
  const range = rangeForDays(days);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=1d`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (zundamon-carrot-public)" } });
  if (!response.ok) throw new Error(`履歴データがありません: ${symbol}`);
  const json = await response.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error(`履歴データがありません: ${symbol}`);

  const tz = isUtcDated(symbol) ? "UTC" : (result.meta && result.meta.exchangeTimezoneName) || "UTC";
  const timestamps = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close && quote.close[i];
    if (!Number.isFinite(close)) continue;
    const point = { date: dateKeyInTz(timestamps[i], tz), close };
    if (Number.isFinite(quote.open && quote.open[i])) point.open = quote.open[i];
    if (Number.isFinite(quote.high && quote.high[i])) point.high = quote.high[i];
    if (Number.isFinite(quote.low && quote.low[i])) point.low = quote.low[i];
    if (Number.isFinite(quote.volume && quote.volume[i])) point.volume = quote.volume[i];
    byDate.set(point.date, point);
  }

  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return points.slice(-days);
}
