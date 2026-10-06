import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { observePool, observationActivity, observationDelta, observationFresh, observeOwnership, decodeObservations, ObservationStore, OBSERVATION_LIMITS, type ObservationMarket } from "../src/arc-radar-observations.js";
import { ARC_RADAR_TESTNET, radarPoolKey } from "../src/arc-radar-networks.js";
import { poolRef } from "../src/arc-radar-pool-id.js";
import { KOREAN, JAPANESE } from "../src/arc-radar-i18n.js";

const now = Date.UTC(2026, 8, 15, 10);
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const iso = (time: number) => new Date(time).toISOString();
function market(at = now): ObservationMarket {
  return { chainId: 5042002, sourceId: "test", quoteAsset: ARC_RADAR_TESTNET.quoteAsset,
    createdAt: iso(now - 86_400_000), creationTx: hash(1), pairAddress: address(1), token0: address(2), token1: address(3), tokenAddress: address(2),
    stale: false, periodsAsOf: at, priceFetchedAt: at, priceEventAt: iso(at - 10_000), reserveSource: "sync",
    currentPrice: 1, usdcReserve: 100, token: { holders_count: "10" },
    trades: [{ direction: "buy", fallbackAddress: null, timestamp: iso(now - 20_000), transactionHash: hash(2), eventIndex: 2, usdcValue: 5 }],
    liquidityEvents: [{ direction: "add", fallbackAddress: null, timestamp: iso(now - 30_000), transactionHash: hash(3), eventIndex: 3, usdcAmount: 100, tokenAmount: 100, changePercent: null }],
  };
}
const key = (m: ObservationMarket) => radarPoolKey(ARC_RADAR_TESTNET, poolRef(m));
const serialized = (pools: unknown[]) => JSON.stringify({ version: 1, pools });

test("first observation is the read time, not launch or the earliest indexed transaction", () => {
  const m = market(), state = observePool(key(m), m, undefined, now)!;
  assert.equal(state.first.at, now);
  assert.equal(state.latest.price, 1);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[0].observedAt, now);
  assert.ok(state.events[0].at < state.first.at);
  assert.deepEqual(decodeObservations(serialized([state]), now), [state]);
});

test("reload retains the initial baseline and compares actual snapshot values", () => {
  const m = market(), initial = observePool(key(m), m, undefined, now)!;
  const restored = decodeObservations(serialized([initial]), now)[0];
  const next = market(now + 600_000); next.currentPrice = 1.25; next.usdcReserve = 80; next.token.holders_count = "12";
  const state = observePool(key(next), next, restored, now + 600_000)!;
  assert.equal(state.first.price, 1); assert.equal(state.latest.price, 1.25);
  assert.equal(observationDelta(state.first.price, state.latest.price), 25);
  assert.ok(Math.abs(observationDelta(state.first.reserve, state.latest.reserve)! + 20) < 1e-9);
  assert.equal(state.events.length, 2);
  assert.equal(initial.latest.price, 1, "previous object must not mutate");
});

test("cached, stale, future or undated input cannot create or advance history", () => {
  const m = market(), initial = observePool(key(m), m, undefined, now)!;
  for (const patch of [{ stale: true }, { priceFetchedAt: null }, { priceFetchedAt: now + 1 }, { priceFetchedAt: now - 300_001 }, { periodsAsOf: now - 120_001 }, { periodsAsOf: now + 1 }]) {
    const bad = { ...m, ...patch };
    assert.equal(observationFresh(bad, now), false);
    assert.equal(observePool(key(m), bad, initial, now), initial);
    assert.equal(observePool(key(m), bad, undefined, now), undefined);
    assert.equal(observationActivity(bad, now), null);
  }
});

test("balance fallback, stale price and invalid holder counts stay incomparable", () => {
  for (const patch of [{ reserveSource: "balance" }, { priceEventAt: iso(now - 900_001) }, { priceEventAt: null }]) {
    const m = { ...market(), ...patch }, state = observePool(key(m), m, undefined, now)!;
    assert.equal(state.first.price, null); assert.equal(state.first.reserve, null);
  }
  for (const count of [null, "", "-1", "Infinity", "3.2", "9007199254740992"]) {
    const m = market(); m.token.holders_count = count;
    assert.equal(observePool(key(m), m, undefined, now)!.first.holders, null);
  }
  assert.equal(observationDelta(null, 10), null); assert.equal(observationDelta(0, 10), null);
  assert.equal(observationDelta(Number.MIN_VALUE, Number.MAX_VALUE), null);
});

test("event dedup uses transaction plus log index; conflicting observations are withheld", () => {
  const m = market(); m.trades.push({ ...m.trades[0] });
  const initial = observePool(key(m), m, undefined, now)!;
  assert.equal(initial.events.length, 2);
  m.trades.push({ ...m.trades[0], eventIndex: 4 });
  assert.equal(observePool(key(m), m, initial, now)!.events.length, 3);
  m.trades.push({ ...m.trades[0], usdcValue: 50 });
  const conflicting = observePool(key(m), m, initial, now)!;
  assert.equal(conflicting.events.some(e => e.hash === hash(2) && e.index === 2), false);
  assert.equal(observationActivity(m, now)!.swaps, 1);
});

test("invalid identities, future events, and events before creation are excluded", () => {
  for (const patch of [{ eventIndex: undefined }, { eventIndex: -1 }, { transactionHash: "javascript:alert(1)" }, { timestamp: iso(now + 1) }, { timestamp: iso(now - 172_800_000) }, { usdcValue: Infinity }, { usdcValue: 0 }]) {
    const m = market(); m.trades = [{ ...m.trades[0], ...patch }];
    assert.equal(observationActivity(m, now)!.swaps, 0);
  }
});

test("activity is occupied five-minute windows, not independent wallets or requests", () => {
  const m = market();
  m.trades = [10_000, 20_000, 310_000, 620_000, 3_600_000].map((age, i) => ({ ...m.trades[0], timestamp: iso(now - age), eventIndex: i }));
  assert.deepEqual(observationActivity(m, now), { swaps: 4, windows: 3 });
});

test("v4 manager plus pool id isolates histories and never uses shared reserves or v2 liquidity events", () => {
  const a = market(); a.v4 = { poolId: hash(8), fee: 3000, tickSpacing: 60, hooks: address(0) }; a.reserveSource = "v4";
  const b = { ...a, v4: { ...a.v4, poolId: hash(9) } };
  const initial = observePool(key(a), a, undefined, now)!;
  assert.equal(initial.first.reserve, null); assert.equal(initial.events.length, 1);
  assert.notEqual(key(a), key(b));
  const separate = observePool(key(b), b, initial, now)!;
  assert.equal(separate.identity, key(b)); assert.notEqual(separate, initial);
});

test("complete same-time ownership can enrich snapshots; partial, cached and old reads cannot", () => {
  const m = market(), initial = observePool(key(m), m, undefined, now)!;
  const detail = { checkedAt: now, sources: { holders: "fresh" as const }, holderHistoryPartial: false, poolScope: address(1), top10Share: 50 };
  const state = observeOwnership(initial, detail, now);
  assert.equal(state.first.top10, 50); assert.equal(initial.first.top10, null);
  for (const patch of [{ checkedAt: now - 1 }, { checkedAt: now + 1 }, { sources: { holders: "cached" as const } }, { holderHistoryPartial: true }, { top10Share: 101 }, { poolScope: "" }]) {
    assert.equal(observeOwnership(initial, { ...detail, ...patch }, now), initial);
  }
  assert.deepEqual(decodeObservations(serialized([state]), now), [state]);
});

test("frequent refreshes are bounded, preserving the first snapshot and earliest retained swap", () => {
  let m = market(), state = observePool(key(m), m, undefined, now)!;
  for (let i = 1; i <= 100; i++) {
    const at = now + i * 300_000; m = market(at); m.currentPrice = i + 1;
    m.trades = [{ ...m.trades[0], timestamp: iso(at - 1), transactionHash: hash(100 + i) }];
    state = observePool(key(m), m, state, at)!;
  }
  assert.equal(state.history.length, OBSERVATION_LIMITS.samples);
  assert.equal(state.events.length, OBSERVATION_LIMITS.events);
  assert.equal(state.first.price, 1); assert.equal(state.latest.price, 101);
  assert.equal(state.events[0].hash, hash(2));
  assert.equal(decodeObservations(serialized([state]), now + 100 * 300_000).length, 1);
});

test("corrupt, oversized, future and expired persisted data fails closed", () => {
  const m = market(), state = observePool(key(m), m, undefined, now)!;
  for (const raw of ["{", JSON.stringify({ version: 2, pools: [state] }), " ".repeat(OBSERVATION_LIMITS.bytes + 1), serialized([{ ...state, first: { ...state.first, at: now + 1 } }]), serialized([{ ...state, latest: { ...state.latest, holders: -1 } }]), serialized([{ ...state, events: [state.events[0], state.events[0]] }])]) {
    assert.deepEqual(decodeObservations(raw, now), []);
  }
  assert.deepEqual(decodeObservations(serialized([state]), now + 31 * 86_400_000), []);
  const noExtra = { ...state, secret: "ignored", first: { ...state.first, html: "<script>" } };
  assert.deepEqual(decodeObservations(serialized([noExtra]), now), [state]);
});

test("storage boundaries, eviction and quota failure preserve in-tab operation", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = new ObservationStore(storage, "testnet", now);
  for (let i = 0; i < 151; i++) { const m = market(); m.pairAddress = address(i); store.set(observePool(key(m), m, undefined, now)!); }
  store.save(now);
  assert.equal(decodeObservations(values.get("testnet")!, now).length, 150);
  const other = new ObservationStore(storage, "mainnet", now);
  assert.equal(other.get(key(market())), undefined);
  const blocked = new ObservationStore({ ...storage, setItem() { throw new Error("quota"); } }, "blocked", now);
  const m = market(), record = observePool(key(m), m, undefined, now)!;
  blocked.set(record); blocked.save(now);
  assert.equal(blocked.persistent, false); assert.equal(blocked.get(key(m)), record);
  assert.equal(new ObservationStore(null, "private", now).persistent, false);
});

test("new discovery and timeline copy is translated and untrusted strings stay text-only", () => {
  for (const label of ["Pool discoveries", "Since first observation", "Observation timeline", "Created in 24H", "Trading across intervals", "Current observation unavailable"]) {
    assert.ok(KOREAN[label]); assert.ok(JAPANESE[label]);
  }
  const source = readFileSync(new URL("../src/arc-radar.ts", import.meta.url), "utf8");
  const render = source.slice(source.indexOf("function renderDiscoveries"), source.indexOf("function renderDetail"));
  assert.doesNotMatch(render, /innerHTML|fetch\(|ethereum|requestAccounts/);
  assert.match(render, /record\.first\.scope !== record\.latest\.scope/);
  assert.match(render, /noopener noreferrer/);
});
