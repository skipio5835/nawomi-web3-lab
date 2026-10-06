import test from "node:test";
import assert from "node:assert/strict";
import { analyzeToken, ANALYSIS_RULES, type AnalysisMarket, type AnalysisOwnership } from "../src/arc-radar-analysis.js";
import { KOREAN, JAPANESE, translate } from "../src/arc-radar-i18n.js";

const now = Date.parse("2026-09-15T09:00:00Z");
const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const trade = (direction = "buy", eventIndex = 1, value = 10) => ({ direction, eventIndex, usdcValue: value, timestamp: at(10), transactionHash: hash(1) });
const removal = { direction: "remove", timestamp: at(20), transactionHash: hash(2), usdcAmount: 20, changePercent: 20 };
function market(extra: Partial<AnalysisMarket> = {}): AnalysisMarket {
  return { periodsAsOf: now, priceFetchedAt: now - 10_000, priceEventAt: at(10), stale: false, historyTruncated: false,
    reserveSource: "sync", periods: { h1: { priceChange: 25 } }, trades: [trade(), trade("sell", 2, 5)], liquidityEvents: [], ...extra };
}
function detail(extra: Partial<AnalysisOwnership & { analysisPrevious?: AnalysisOwnership }> = {}) {
  return { checkedAt: now - 1000, poolScope: "chain:pool-a", top10Share: 30,
    sources: { holders: "fresh" as const }, holderHistoryPartial: false, ...extra };
}
const text = (result: ReturnType<typeof analyzeToken>) => [result.headline, result.summary, ...result.evidence.map(item => item.text), ...result.limits]
  .map(value => translate(value, "en")).join("\n");

test("combines price and same-hour removal without calling it a net liquidity reduction", () => {
  const result = analyzeToken(market({ liquidityEvents: [removal, { ...removal, direction: "add", usdcAmount: 100 }] }), detail(), now);
  assert.equal(result.headline.key, "Price rising; liquidity removal observed");
  assert.equal(result.tone, "warning");
  assert.match(text(result), /Not a net liquidity change/);
  assert.match(text(result), /Later deposits and swaps/);
  assert.equal(result.evidence.find(item => item.source === "transaction")?.transactionHash, hash(2));
});

test("flow uses swap value rather than transaction count or inferred wallet demand", () => {
  const result = analyzeToken(market({ trades: [trade("buy", 1, 1), trade("buy", 2, 1), trade("sell", 3, 20)] }), detail(), now);
  assert.equal(result.headline.key, "Price rising; indexed sell value leads");
  assert.match(text(result), /2 buys \/ 2 USDC; 1 sells \/ 20 USDC/);
  assert.match(text(result), /do not establish net capital inflow/);
});

test("two-way, falling, absent-sell and quiet outcomes do not assert trade safety", () => {
  assert.equal(analyzeToken(market(), detail(), now).headline.key, "Price rising with two-way swaps");
  assert.equal(analyzeToken(market({ periods: { h1: { priceChange: -8 } } }), detail(), now).headline.key, "Price falling with two-way swaps");
  assert.equal(analyzeToken(market({ periods: { h1: { priceChange: 0 } } }), detail(), now).headline.key, "Two-way swaps observed");
  const buy = analyzeToken(market({ trades: [trade()] }), detail(), now);
  assert.equal(buy.headline.key, "Buying observed; sell evidence missing");
  assert.match(text(buy), /does not prove that selling is restricted/);
  assert.equal(analyzeToken(market({ trades: [] }), detail(), now).headline.key, "Recent trading not established");
});

test("cached, expired, missing and future market timestamps withhold all current market conclusions", () => {
  for (const values of [{ stale: true }, { priceFetchedAt: null }, { priceFetchedAt: now - 300_000 },
    { priceFetchedAt: now + 1 }, { periodsAsOf: NaN }, { periodsAsOf: now + 1 }, { periodsAsOf: now - ANALYSIS_RULES.freshnessMs }]) {
    const result = analyzeToken(market({ ...values, liquidityEvents: [removal] }), detail(), now);
    assert.equal(result.headline.key, "Analysis on hold");
    assert.ok(result.evidence.every(item => item.source === "holders"));
  }
});

test("stale event price, balance fallback, and missing baseline never imply a price trend", () => {
  for (const values of [{ priceEventAt: at(3600) }, { priceEventAt: at(-1) }, { priceEventAt: null },
    { reserveSource: "balance" as const }, { periods: { h1: { priceChange: null } } }, { periods: { h1: { priceChange: Infinity } } }]) {
    const result = analyzeToken(market(values), detail(), now);
    assert.equal(result.headline.key, "Limited evidence");
    assert.ok(result.evidence.every(item => item.text.key !== "1H pool price {change}%."));
  }
});

test("partial histories can cite a valid removal but cannot establish complete flow", () => {
  const result = analyzeToken(market({ historyTruncated: true, liquidityEvents: [removal] }), detail(), now);
  assert.equal(result.headline.key, "Liquidity removal observed");
  assert.ok(result.evidence.some(item => item.source === "transaction"));
  assert.ok(result.evidence.every(item => !item.text.key.startsWith("1H indexed swaps")));
  assert.match(text(result), /history is incomplete/);
});

test("v4 never infers per-pool liquidity from injected v2 removal events", () => {
  const result = analyzeToken(market({ reserveSource: "v4", liquidityEvents: [removal] }), detail(), now);
  assert.equal(result.headline.key, "Price rising with two-way swaps");
  assert.ok(result.evidence.every(item => item.source !== "transaction"));
  assert.match(text(result), /v4 per-pool liquidity and hook-adjusted/);
});

test("invalid, future, old, zero and sub-threshold removals are not evidence", () => {
  for (const values of [{ timestamp: at(-1) }, { timestamp: at(3600) }, { transactionHash: "javascript:bad" },
    { changePercent: 9.9 }, { changePercent: 101 }, { changePercent: NaN }, { usdcAmount: 0 }, { usdcAmount: Infinity }]) {
    assert.ok(analyzeToken(market({ liquidityEvents: [{ ...removal, ...values }] }), detail(), now)
      .evidence.every(item => item.source !== "transaction"));
  }
});

test("deduplicates exact swap copies while preserving separate equal-value batch events", () => {
  const result = analyzeToken(market({ trades: [trade(), trade(), trade("buy", 2)] }), detail(), now);
  assert.match(text(result), /2 buys \/ 20 USDC/);
  const conflict = analyzeToken(market({ trades: [trade(), trade("sell")] }), detail(), now);
  assert.match(text(conflict), /incomplete or inconsistent/);
  assert.ok(conflict.evidence.every(item => !item.text.key.startsWith("1H indexed swaps")));
});

test("bad identities, non-swap transfers, future events, and overflow cannot establish flow", () => {
  for (const bad of [trade("transfer"), { ...trade(), eventIndex: undefined }, { ...trade(), transactionHash: "bad" },
    { ...trade(), timestamp: "invalid" }, { ...trade(), timestamp: at(-1) }, trade("buy", 1, -1), trade("buy", 1, NaN)]) {
    const result = analyzeToken(market({ trades: [bad] }), detail(), now);
    assert.equal(result.headline.key, "Limited evidence");
  }
  const overflow = analyzeToken(market({ trades: [trade("buy", 1, Number.MAX_VALUE), trade("sell", 2, Number.MAX_VALUE)] }), detail(), now);
  assert.equal(overflow.headline.key, "Limited evidence");
  assert.doesNotMatch(text(overflow), /Infinity|NaN/);
  assert.match(text(analyzeToken(market({ trades: [trade("buy", 1, 1e-9)] }), detail(), now)), /<0.001 USDC/);
});

test("ownership concentration requires fresh complete coverage and never substitutes zero for unknown", () => {
  const high = analyzeToken(market(), detail({ top10Share: 70 }), now);
  assert.equal(high.headline.key, "Holder concentration merits review");
  for (const values of [{ top10Share: null }, { top10Share: 101 }, { top10Share: NaN }, { checkedAt: now + 1 },
    { checkedAt: now - 120_000 }, { holderHistoryPartial: true }, { sources: { holders: "cached" as const } }]) {
    const result = analyzeToken(market(), detail({ top10Share: 70, ...values }), now);
    assert.ok(result.evidence.every(item => item.source !== "holders"));
    assert.match(text(result), /concentration is unassessed/);
  }
});

test("holder change uses only a prior same-scope complete snapshot within one day", () => {
  const previous = detail({ checkedAt: now - 60_000, top10Share: 20 });
  const result = analyzeToken(market(), detail({ analysisPrevious: previous }), now);
  assert.equal(result.headline.key, "Holder concentration merits review");
  assert.match(text(result), /changed \+10 percentage points/);
  for (const bad of [{ poolScope: "chain:other" }, { checkedAt: now }, { checkedAt: now - 90_000_000 }, { checkedAt: NaN },
    { top10Share: null }, { holderHistoryPartial: true }, { sources: { holders: "unavailable" as const } }]) {
    const result = analyzeToken(market(), detail({ analysisPrevious: { ...previous, ...bad } }), now);
    assert.ok(result.evidence.every(item => !item.text.key.startsWith("Top 10 share changed")));
    assert.match(text(result), /No comparable prior/);
  }
});

test("window stays anchored to the market snapshot while rendering later, without modifying inputs", () => {
  const m = market({ periodsAsOf: now - 60_000, priceEventAt: at(70), trades: [{ ...trade(), timestamp: at(3650) }] });
  const before = JSON.stringify(m);
  const result = analyzeToken(m, detail(), now);
  assert.equal(result.asOf, now - 60_000);
  assert.match(text(result), /1 buys/);
  assert.equal(JSON.stringify(m), before);
});

test("analysis copy translates all returned messages with matching interpolation fields", () => {
  const cases = [market(), market({ stale: true }), market({ liquidityEvents: [removal] }), market({ historyTruncated: true }),
    market({ reserveSource: "v4" }), market({ trades: [] }), market({ trades: [trade()] }), market({ periods: { h1: { priceChange: -8 } } }),
    market({ periods: { h1: { priceChange: 0 } } }), market({ trades: [trade(), trade("sell", 2, 50)] })];
  for (const m of cases) for (const d of [detail(), detail({ top10Share: 70 }), detail({ holderHistoryPartial: true }), detail({ analysisPrevious: detail({ checkedAt: now - 60_000 }) })]) {
    const result = analyzeToken(m, d, now);
    for (const message of [result.headline, result.summary, ...result.evidence.map(item => item.text), ...result.limits]) {
      for (const dictionary of [KOREAN, JAPANESE]) assert.ok(Object.hasOwn(dictionary, message.key), message.key);
      for (const language of ["en", "ko", "ja"] as const) assert.doesNotMatch(translate(message, language), /\{\w+\}|NaN|Infinity/);
    }
  }
});
