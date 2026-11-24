// GET /api/market/quote?symbol=7203 -> { quote: { symbol, price, currency, name, kind, provider, timestamp } }
// Standalone Vercel function for the public Zundamon x carrot page.
// Mirrors carrot's own /api/market/quote route contract; data from Yahoo Finance (no API key).
module.exports = async (req, res) => {
  const symbol = (req.query.symbol || "").trim();
  if (!symbol) {
    return res.status(400).json({ error: "symbol is required" });
  }
  try {
    const quote = await fetchQuote(symbol);
    return res.status(200).json({ quote });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "quote fetch failed" });
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

function kindOf(symbol) {
  const s = canonicalSymbol(symbol);
  if (s === "XAUUSD" || s === "XAGUSD" || s === "WTI") return "fx";
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|LTC)(USD|JPY|EUR)$/.test(s)) return "crypto";
  if (/^[A-Z]{6}$/.test(s)) return "fx";
  return "stock";
}

async function fetchQuote(rawSymbol) {
  const symbol = canonicalSymbol(rawSymbol);
  const yahooSymbol = toYahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (zundamon-carrot-public)" } });
  if (!response.ok) throw new Error(`価格データがありません: ${symbol}`);
  const json = await response.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error(`価格データがありません: ${symbol}`);
  const meta = result.meta || {};

  let price = meta.regularMarketPrice;
  if (!Number.isFinite(price)) {
    const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
    for (let i = closes.length - 1; i >= 0; i--) {
      if (Number.isFinite(closes[i])) { price = closes[i]; break; }
    }
  }
  if (!Number.isFinite(price)) throw new Error(`価格データがありません: ${symbol}`);

  const timestamp = Number.isFinite(meta.regularMarketTime)
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();

  return {
    symbol,
    price,
    currency: meta.currency || (symbol.endsWith(".T") ? "JPY" : "USD"),
    name: meta.longName || meta.shortName || symbol,
    kind: kindOf(symbol),
    provider: "yahoo",
    timestamp
  };
}
