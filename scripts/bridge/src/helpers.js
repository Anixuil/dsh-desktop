// dsh-desktop-bridge — formatting helpers and cost estimation.
function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
function fmtMoney(n) {
  if (!Number.isFinite(n)) return "—";
  return "≈ $" + (n < 0.01 && n > 0 ? "<0.01" : n.toFixed(2));
}
function fmtUsd(v) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  return "$" + v.toFixed(2);
}
function fmtDate(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Approximate cost from the DeepSeek public price list (USD / 1M tokens).
 *  Third-party models are skipped: their platforms bill independently and
 *  the panel shows the platform's own billing totals instead. */
const PRICING = {
  "deepseek-reasoner": { miss: 0.55, hit: 0.14, out: 2.19 },
  default: { miss: 0.28, hit: 0.028, out: 0.42 },
};
function estimateCost(report) {
  if (!report?.byModel?.length) return 0;
  let cost = 0;
  for (const row of report.byModel) {
    const price = PRICING[row.model] ?? null;
    if (price === null) continue; // third-party platform — not DeepSeek-priced
    cost += (row.tokens.input / 1e6) * price.miss
      + (row.tokens.cacheRead / 1e6) * price.hit
      + (row.tokens.cacheWrite / 1e6) * price.hit
      + (row.tokens.output / 1e6) * price.out;
  }
  return cost;
}

module.exports = { fmtTokens, fmtMoney, fmtUsd, fmtDate, estimateCost };
