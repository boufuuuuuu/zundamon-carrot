// GET /api/market/fx?base=USD&quote=JPY -> { rate: { base, quote, rate, provider, timestamp } }
// Standalone Vercel function for the public Zundamon x carrot page.
// Mirrors carrot's own /api/market/fx route contract; data from Yahoo Finance (no API key).
module.exports = async (req, res) => {
  const base = (req.query.base || "").toUpperCase();
  const quote = (req.query.quote || "").toUpperCase();
  if (!base || !quote) {
    return res.status(400).json({ error: "base and quote are required" });
  }
  try {
    const rate = await fetchFxRate(base, quote);
    if (!rate) throw new Error(`FXレートがありません: ${base}/${quote}`);
    return res.status(200).json({
      rate: { base, quote, rate, provider: "yahoo", timestamp: new Date().toISOString() }
    });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "fx fetch failed" });
  }
};

async function yahooPrice(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (zundamon-carrot-public)" } });
  if (!response.ok) throw new Error(`yahoo ${response.status}`);
  const json = await response.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error("yahoo: no result");
  const meta = result.meta || {};
  if (Number.isFinite(meta.regularMarketPrice)) return meta.regularMarketPrice;
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  for (let i = closes.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) return closes[i];
  }
  throw new Error("yahoo: no price");
}

// Rate of 1 unit of `ccy` in USD, via Yahoo FX symbols. Returns null when unavailable.
async function usdValueOf(ccy) {
  if (ccy === "USD") return 1;
  if (ccy === "XAU") return yahooPrice("GC=F").catch(() => null);
  if (ccy === "XAG") return yahooPrice("SI=F").catch(() => null);
  const direct = await yahooPrice(`${ccy}USD=X`).catch(() => null);
  if (direct) return direct;
  const inverse = await yahooPrice(`USD${ccy}=X`).catch(() => null);
  if (inverse) return 1 / inverse;
  return null;
}

async function fetchFxRate(base, quote) {
  if (base === quote) return 1;
  const direct = await yahooPrice(`${base}${quote}=X`).catch(() => null);
  if (direct) return direct;
  const inverse = await yahooPrice(`${quote}${base}=X`).catch(() => null);
  if (inverse) return 1 / inverse;
  const baseUsd = await usdValueOf(base);
  const quoteUsd = await usdValueOf(quote);
  if (baseUsd && quoteUsd) return baseUsd / quoteUsd;
  return null;
}
