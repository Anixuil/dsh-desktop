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
 *  The V4 series moved to peak/off-peak tiers (effective 2026-08-17, CNY per
 *  1M tokens); entries below average the two tiers and convert at ≈7.1
 *  CNY/USD. Models without an exact entry fall back to the default price
 *  when they are attributed to DeepSeek (provider or model name); other
 *  third-party models are skipped — their platforms bill independently and
 *  the panel shows the platform's own billing totals instead. */
const PRICING = {
  "deepseek-reasoner": { miss: 0.55, hit: 0.14, out: 2.19 },
  "deepseek-v4-pro": { miss: 0.95, hit: 0.03, out: 2.85 },
  "deepseek-v4-flash": { miss: 0.32, hit: 0.01, out: 0.95 },
  default: { miss: 0.28, hit: 0.028, out: 0.42 },
};
function priceFor(row) {
  const model = String(row?.model ?? "");
  const exact = PRICING[model];
  if (exact !== undefined) return exact;
  const provider = String(row?.provider ?? "").toLowerCase();
  if (provider.includes("deepseek") || model.toLowerCase().startsWith("deepseek")) {
    return PRICING.default;
  }
  return null; // third-party platform — not DeepSeek-priced
}
function estimateCost(report) {
  if (!report?.byModel?.length) return 0;
  let cost = 0;
  for (const row of report.byModel) {
    const price = priceFor(row);
    if (price === null) continue;
    const tokens = row?.tokens ?? {};
    cost += (Number(tokens.input) || 0) / 1e6 * price.miss
      + (Number(tokens.cacheRead) || 0) / 1e6 * price.hit
      + (Number(tokens.cacheWrite) || 0) / 1e6 * price.hit
      + (Number(tokens.output) || 0) / 1e6 * price.out;
  }
  return cost;
}

module.exports = { fmtTokens, fmtMoney, fmtUsd, fmtDate, estimateCost };
