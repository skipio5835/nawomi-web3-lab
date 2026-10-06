import test from "node:test";
import assert from "node:assert/strict";
import { observeSellEvents, groupTokenPools } from "../src/arc-radar-market-tools.js";

const hash = `0x${"ab".repeat(32)}`;
const trade = (eventIndex: number, seconds = eventIndex) => ({ direction: "sell", transactionHash: hash, eventIndex, timestamp: new Date(100_000 + seconds * 1000).toISOString() });

test("first observation and legacy migration establish a baseline without historical alerts", () => {
  assert.equal(observeSellEvents([trade(1), trade(2)]).added, 0);
  const baseline = observeSellEvents([trade(1)]).state;
  assert.equal(observeSellEvents([trade(1), trade(1)], baseline).added, 0);
});

test("equal or shrinking rolling counts still detect unseen logs within one transaction", () => {
  const baseline = observeSellEvents([trade(1), trade(2), trade(3)]).state;
  const next = observeSellEvents([trade(3), trade(4), trade(4)], baseline);
  assert.equal(next.added, 1);
  assert.equal(observeSellEvents([trade(1), trade(4)], next.state).added, 0);
  const delayed = observeSellEvents([trade(5, 0)], next.state);
  assert.equal(delayed.added, 1);
  assert.equal(observeSellEvents([{ ...trade(5, 0), transactionHash: hash.toUpperCase().replace("0X", "0x") }], delayed.state).added, 0);
});

test("missing identity is ignored and bounded retention prevents old events being counted again", () => {
  const baseline = observeSellEvents([], undefined, 2).state;
  assert.equal(observeSellEvents([{ ...trade(1), eventIndex: undefined }, { ...trade(1), transactionHash: "bad" }, { ...trade(2), direction: "buy" }], baseline).added, 0);
  const next = observeSellEvents([trade(1), trade(2), trade(3)], baseline, 2);
  assert.equal(next.added, 3);
  assert.equal(next.state.seen.length, 2);
  assert.equal(observeSellEvents([trade(1), trade(2), trade(3)], next.state, 2).added, 0);
});

test("tokens group by chain and address; representatives prefer fresh data then liquidity", () => {
  const a = { chainId: 1, tokenAddress: "0xab", pairAddress: "0x1", totalLiquidity: 10, stale: false };
  const b = { ...a, pairAddress: "0x2", totalLiquidity: 20 };
  const c = { ...a, pairAddress: "0x3", totalLiquidity: 1000, stale: true };
  const input = [a, b, c, { ...b, tokenAddress: "0xAB" }, { ...a, chainId: 2 }, { ...a, tokenAddress: "0xcd" }];
  const grouped = groupTokenPools(input);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0]!.pools.length, 3);
  assert.equal(grouped[0]!.primary.pairAddress, "0x2");
  assert.equal(input[0], a);
});

test("an empty fresh pool cannot hide another pool's cached price during rotating refresh", () => {
  const base = { chainId: 5042, tokenAddress: "0xab", totalLiquidity: null, lastTradeAt: null };
  const priced = { ...base, pairAddress: "0x2", currentPrice: 0.007, stale: true };
  for (const currentPrice of [0, undefined, NaN, Infinity, -1]) {
    const idle = { ...base, pairAddress: "0x1", currentPrice, stale: false };
    const result = groupTokenPools([idle, priced])[0]!.primary;
    assert.equal(result, priced);
    assert.equal(result.stale, true, "selection must not relabel cached data as fresh");
  }
  const fresh = { ...priced, pairAddress: "0x3", currentPrice: 0.001, stale: false };
  assert.equal(groupTokenPools([priced, fresh])[0]!.primary, fresh, "do not rank by the highest price");
});

test("slot0 quotes in idle pools cannot displace a recently traded unknown-liquidity pool during refresh", () => {
  const idle = { chainId: 5042, tokenAddress: "0xab", pairAddress: "0x1", totalLiquidity: null, currentPrice: 0.1, stale: false, lastTradeAt: null as string | null };
  const traded = { ...idle, pairAddress: "0x2", currentPrice: 0.007, stale: true, lastTradeAt: new Date(Date.now() - 60000).toISOString() };
  assert.equal(groupTokenPools([idle, traded])[0]!.primary, traded);
  assert.equal(groupTokenPools([traded, idle])[0]!.primary, traded);
  assert.equal(traded.stale, true);
  for (const time of [Date.now() - 16 * 60000, Date.now() + 60000, NaN]) {
    const old = { ...traded, lastTradeAt: Number.isFinite(time) ? new Date(time).toISOString() : "invalid" };
    assert.equal(groupTokenPools([idle, old])[0]!.primary, idle, "expired or future activity is not a ranking signal");
  }
});
