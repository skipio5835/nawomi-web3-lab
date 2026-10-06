import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { poolRef } from "../src/arc-radar-pool-id.js";
import { comparePricePoints } from "../src/arc-radar-v4.js";
import { V3_EVENTS } from "../src/arc-radar-v3.js";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { validObservationTime, oldestFetchTime, priceFreshness } from "../src/arc-radar-freshness.js";
import { observePool, ObservationStore } from "../src/arc-radar-observations.js";
import * as v4 from "./fixtures/arc-radar-v4.js";
import ts from "typescript";
import { decimalValue, fullyDilutedValue } from "../src/arc-radar-core.js";
import { poolStatePrice } from "../src/arc-radar-pool-state.js";
import { snapshotIsStale } from "../src/arc-radar-market-snapshot.js";
import { createDexAdapter, selectDexAdapters } from "../src/arc-radar-dex.js";
import { refineMarkets } from "../src/arc-radar-discovery.js";
import { groupTokenPools } from "../src/arc-radar-market-tools.js";
import { marketUrl } from "../src/arc-radar-navigation.js";
import { observedChartData, chartNumber, type ChartInput } from "../src/arc-radar-chart-data.js";
import { cachedPoolSeeds, dataCacheKey, usableCacheTime, writeMarketCache, rememberFactoryPage } from "../src/arc-radar-cached-markets.js";
import { TokenDirectory, tokenSearchUrl } from "../src/arc-radar-token-search.js";
import { ARC_RADAR_MAINNET, ARC_RADAR_TESTNET } from "../src/arc-radar-networks.js";
import { copy, translate } from "../src/arc-radar-i18n.js";
import { capabilityText, detectCapabilities, nextWatchBatch } from "../src/arc-radar-evidence.js";
import { holderMetrics, holderShare, knownTokenPools, nextOwnershipSnapshot, sourceState, tradeActor, windowPriceChange } from "../src/arc-radar-quality.js";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;
const holder = (id: number, value: string) => ({ address: { hash: address(id) }, value });
const selected = { chainId: 5042002, tokenAddress: address(10), pairAddress: address(1) };

test("background status distinguishes time budgets, classified failures and recovery in each language", () => {
  const context: any = { copy };
  runInNewContext(compileMain(["localFeedNotice"]), context);
  const budget = { error: false, collection: { budgetReached: true, failureCount: 0, failures: [] } };
  const failed = { error: true, collection: { budgetReached: true, failureCount: 2, failures: [{ reason: "rate-limit" }] } };
  for (const language of ["en", "ko", "ja"] as const) {
    const deferred = translate(context.localFeedNotice(budget), language);
    const failure = translate(context.localFeedNotice(failed), language);
    assert.doesNotMatch(deferred, /failed|failures|실패|失敗/i);
    assert.notEqual(deferred, failure);
    assert.match(failure, /2/);
    assert.doesNotMatch(failure, /\{count\}|\{reason\}|\{continuation\}/);
  }
  assert.equal(context.localFeedNotice({ error: false, collection: { budgetReached: false, failureCount: 0, failures: [] } }), null);
  assert.ok(context.localFeedNotice({ error: true }), "older server responses remain supported");
});

function progressiveDetailFixture() {
  const paints: any[] = [], statuses = new Map<string, any>();
  let resolve!: (detail: any) => void, reject!: (error: Error) => void;
  const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
  let checks = 0, observations = 0;
  const context: any = {
    document: { body: { classList: { add() {} } } }, location: { href: "http://localhost/" },
    NETWORK: { id: "arc-testnet" }, linkedPool: null, rpcReader: null,
    marketUrl: () => "http://localhost/token", byId: () => ({}),
    setCopy: (id: string, value: any) => statuses.set(id, value),
    detailRequest: 0, selectedPair: poolRef(selected), poolRef, poolCacheKey: poolRef,
    detailCache: new Map(), markets: [selected], knownTokenPools, DETAIL_CACHE_TTL_MS: 120_000,
    setTimeout: (done: () => void) => done(),
    renderLaunchOrigin() {}, loadLaunchOrigin: async () => {},
    renderDetail: (market: any, detail: any, enrichmentOnly: boolean) => paints.push({ market, detail, enrichmentOnly }),
    getMarketDetail: () => { checks++; return pending; },
    observeDetailChanges: () => { observations++; },
  };
  runInNewContext(compileMain(["unavailableMarketDetail", "loadDetail"]), context);
  return { context, paints, statuses, resolve, reject, checks: () => checks, observations: () => observations };
}

test("detail price and chart can render before any optional request finishes", async () => {
  const fixture = progressiveDetailFixture();
  const market = { ...selected, priceFetchedAt: 123, periodsAsOf: 123 };
  const request = fixture.context.loadDetail(market);
  assert.equal(fixture.paints.length, 1, "initial market content must be synchronous");
  const initial = fixture.paints[0]!;
  assert.equal(initial.market, market);
  assert.equal(initial.market.priceFetchedAt, 123, "opening detail must not freshen the stored quote");
  assert.equal(initial.detail.checkedAt, 0);
  assert.ok(Object.values(initial.detail.sources).every(value => value === "unavailable"));
  assert.equal(initial.detail.top10Share, null);
  assert.equal(fixture.context.detailCache.size, 0, "placeholder is never cached as a completed check");
  assert.equal(fixture.observations(), 0);
  assert.equal(fixture.statuses.get("detailCheckStatus"), "Additional checks in progress...");
  const enriched = { checkedAt: Date.now() };
  fixture.resolve(enriched);
  await request;
  assert.equal(fixture.paints[1]!.detail, enriched);
  assert.equal(fixture.paints[1]!.enrichmentOnly, true, "background evidence must preserve chart viewport");
  assert.equal(fixture.statuses.get("detailCheckStatus"), "");
});

test("optional detail failure leaves initial market information visible", async () => {
  const fixture = progressiveDetailFixture();
  const request = fixture.context.loadDetail(selected);
  fixture.reject(new Error("RPC timeout"));
  await request;
  assert.equal(fixture.paints.length, 1, "failure must not clear or rebuild the chart");
  assert.equal(fixture.statuses.get("detailCheckStatus"), "Additional checks unavailable. Market data remains visible.");
  assert.equal(fixture.observations(), 0);
});

test("switching or closing a detail discards pending paints and progress updates", async () => {
  for (const fails of [false, true]) {
    const fixture = progressiveDetailFixture();
    const request = fixture.context.loadDetail(selected);
    await Promise.resolve();
    assert.equal(fixture.checks(), 1);
    fixture.context.detailRequest++;
    fixture.context.selectedPair = "";
    fixture.statuses.set("detailCheckStatus", "new selection");
    if (fails) fixture.reject(new Error("late failure")); else fixture.resolve({ checkedAt: Date.now() });
    await request;
    assert.equal(fixture.paints.length, 1);
    assert.equal(fixture.observations(), 0);
    assert.equal(fixture.statuses.get("detailCheckStatus"), "new selection");
  }
});

test("cached detail opens without starting another evidence lookup", async () => {
  const fixture = progressiveDetailFixture();
  const detail = { poolScope: selected.pairAddress, checkedAt: Date.now() };
  fixture.context.detailCache.set(poolRef(selected), { data: detail, savedAt: Date.now() });
  await fixture.context.loadDetail(selected);
  assert.equal(fixture.paints[0]!.detail, detail);
  assert.equal(fixture.checks(), 0);
});

test("local dashboard requests the saved server list before legacy browser cache scans", async () => {
  for (const local of [false, true]) {
    for (const available of [false, true]) {
      const steps: string[] = [];
      const context: any = { localMarketMode: local, markets: [],
        loadDashboard: async () => { steps.push("server"); context.markets = available ? [selected] : []; },
        restoreCachedMarkets: async () => { steps.push("legacy"); },
      };
      await runInNewContext(`${compileMain(["initializeMarketDashboard"])}\ninitializeMarketDashboard()`, context);
      assert.deepEqual(steps, local ? available ? ["server"] : ["server", "legacy"] : ["legacy", "server"]);
    }
  }
});

test("launch origin lookup cannot overwrite another selected token and rows stay token-scoped", async () => {
  const paints: any[] = [], rows = [{ dataset: { launchToken: selected.tokenAddress }, copy: null as any },
    { dataset: { launchToken: address(20) }, copy: null as any }];
  let resolve!: (value: any) => void;
  const context: any = { detailRequest: 1, selectedPair: poolRef(selected), poolRef, Date, copy,
    rpcReader: { launches: { peek: () => undefined, read: () => new Promise(done => { resolve = done; }) } },
    document: { querySelectorAll: () => rows }, renderLaunchOrigin: (result: any) => paints.push(result),
    localize: (row: any, value: any) => { row.copy = value; } };
  runInNewContext(compileMain(["launchRowCopy", "loadLaunchOrigin"]), context);
  const request = context.loadLaunchOrigin(selected);
  context.detailRequest = 2; context.selectedPair = address(2);
  resolve({ status: "verified", evidence: { platform: { name: "ArcPad" } } });
  await request;
  assert.deepEqual(paints, [undefined], "late reply must not paint the newly selected detail");
  assert.equal(translate(rows[0]!.copy, "ko"), "발행: ArcPad"); assert.equal(rows[1]!.copy, null);
  assert.equal(translate(context.launchRowCopy(), "ko"), "발행처 미조회");
  assert.equal(translate(context.launchRowCopy({ status: "unknown" }), "ko"), "발행처 미확인");
});

test("launch detail links are cleared while loading another token and cannot preserve old evidence", () => {
  const links: any[] = [], copies = new Map<string, any>();
  const context: any = { EXPLORER_BASE: ARC_RADAR_MAINNET.explorerBase, copy,
    byId: () => ({ replaceChildren: () => { links.length = 0; }, append: (link: any) => links.push(link) }),
    element: (_tag: string, _class: string, text: any) => ({ text }), setCopy: (id: string, value: any) => copies.set(id, value) };
  runInNewContext(compileMain(["renderLaunchOrigin"]), context);
  context.renderLaunchOrigin({ status: "verified", evidence: { transactionHash: "0x123", platform: { name: "ArcPad", emitter: address(1), docs: "https://arcpad.meme/docs" } } });
  assert.equal(links.length, 3); assert.ok(links.every(link => link.rel === "noopener noreferrer"));
  context.renderLaunchOrigin();
  assert.equal(links.length, 0); assert.equal(copies.get("launchOriginStatus"), "Checking issuance...");
});

test("chart buckets preserve real time, last event order, and gaps without synthetic prices or volumes", () => {
  const input: ChartInput = { periodsAsOf: Date.parse("2026-09-16T12:05:00Z"), token: { total_supply: "1000000", decimals: "3" },
    pricePoints: [
      { timestamp: "2026-09-16T12:00:30Z", price: 2, blockNumber: 2, eventIndex: 2 },
      { timestamp: "2026-09-16T12:02:00Z", price: 4 },
      { timestamp: "2026-09-16T12:00:30Z", price: 1, blockNumber: 2, eventIndex: 1 },
    ], trades: [
      { timestamp: "2026-09-16T12:00:30Z", direction: "buy", fallbackAddress: null, transactionHash: "0x123", eventIndex: 1, usdcValue: 3 },
      { timestamp: "2026-09-16T12:00:30Z", direction: "sell", fallbackAddress: null, transactionHash: "0x123", eventIndex: 2, usdcValue: 5 },
    ] };
  const before = JSON.stringify(input);
  const result = observedChartData(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.supply, 1000);
  assert.equal(result.interval, 5);
  assert.equal(result.samples.length, 19);
  assert.equal(result.samples[0]!.price, 2);
  assert.equal(result.samples[0]!.valuation, 2000);
  assert.equal(result.samples[0]!.volume, 8);
  assert.deepEqual(result.samples[1], { time: Date.parse("2026-09-16T12:00:35Z") / 1000 });
  assert.equal(result.samples.at(-1)!.price, 4);
  assert.equal(result.samples.at(-1)!.volume, undefined);
  input.trades.push(input.trades[0]!);
  assert.equal(observedChartData(input).samples[0]!.volume, 8);
});

test("chart rejects malformed, nonpositive and future price samples and bounds sparse history", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  const timestamp = new Date(now).toISOString();
  const result = observedChartData({ periodsAsOf: now, token: { total_supply: null, decimals: "18" }, trades: [], pricePoints: [
    { timestamp: "invalid", price: 2 }, { timestamp: new Date(now + 1).toISOString(), price: 3 },
    ...[NaN, Infinity, 0, -2].map(price => ({ timestamp, price })),
    { timestamp: new Date(now - 7 * 86_400_000).toISOString(), price: 1 }, { timestamp, price: 4 },
  ] });
  assert.equal(result.samples.length, 1441);
  assert.equal(result.interval, 60);
  assert.equal(result.samples.filter(sample => sample.price !== undefined).length, 1);
  assert.equal(result.samples.at(-1)!.price, 4);
  assert.equal(result.supply, null);
  assert.equal(result.samples.some(sample => sample.valuation !== undefined), false);
});

test("chart valuation never substitutes missing supply, maximum supply or historical supply", () => {
  const base: ChartInput = { periodsAsOf: Date.now(), trades: [], token: { total_supply: "1000", decimals: "0" }, pricePoints: [{ timestamp: "2026-01-01T00:00:00Z", price: 2 }] };
  for (const supply of [null, "", "invalid", "0", "-1", "9".repeat(400)]) {
    const result = observedChartData({ ...base, token: { ...base.token, total_supply: supply } });
    assert.equal(result.supply, null);
    assert.equal(result.samples[0]!.valuation, undefined);
  }
  assert.equal(observedChartData(base).samples[0]!.valuation, 2000);
  assert.equal(observedChartData({ ...base, token: { total_supply: "2000", decimals: "0" } }).samples[0]!.valuation, 4000);
  assert.equal(observedChartData({ ...base, pricePoints: [{ ...base.pricePoints[0]!, price: Number.MAX_VALUE }] }).supply, null);
  assert.notEqual(chartNumber(0.0000000000123), "0");
  assert.equal(chartNumber(NaN), "--");
});

test("failed or malformed holders are unknown, never zero concentration", () => {
  for (const source of [null, { data: {}, stale: false }, { data: { items: [holder(2, "invalid")] }, stale: false }]) {
    const result = holderMetrics(source, "1000", new Set());
    assert.equal(result.state, "unavailable");
    assert.equal(result.top(10), null);
    assert.equal(result.burned, null);
    assert.equal(result.shareAt(address(2)), null);
  }
  assert.equal(holderShare(null, "1000"), null);
  assert.equal(holderShare(undefined, "1000"), null);
  assert.equal(holderShare("0", "1000"), 0);
  assert.equal(holderShare("1", null), null);
});

test("all loaded same-chain same-token pools are excluded, unrelated addresses are not", () => {
  const pools = knownTokenPools(selected, [selected, { ...selected, pairAddress: address(2) },
    { ...selected, chainId: 1, pairAddress: address(3) }, { ...selected, tokenAddress: address(11), pairAddress: address(4) }]);
  assert.deepEqual([...pools], [address(1), address(2)]);
  const result = holderMetrics({ data: { items: [holder(1, "400"), holder(2, "300"), holder(3, "200"), holder(4, "100")] }, stale: false }, "1000", pools);
  assert.equal(result.top(1), 20);
  assert.equal(result.top(10), 30);
  assert.equal(result.shareAt(address(1)), 40);
  assert.equal(result.shareAt(address(5)), 0);
});

test("partial holder page does not prove missing balances, burn totals, or full rankings", () => {
  const result = holderMetrics({ data: { items: [holder(2, "100")], next_page_params: { cursor: 1 } }, stale: false }, "1000", new Set());
  assert.equal(result.top(1), 10);
  assert.equal(result.top(5), null);
  assert.equal(result.shareAt(address(3)), null);
  assert.equal(result.burned, null);
  assert.equal(result.partial, true);
});

test("stale fallback stays distinguishable from fresh and missing data", () => {
  assert.equal(sourceState(null), "unavailable");
  const source = { data: { items: [holder(2, "100")] }, stale: true };
  assert.equal(holderMetrics(source, "1000", new Set()).state, "cached");
  assert.equal(sourceState({ ...source, stale: false }), "fresh");
});

test("missing and stale observations preserve previous baselines without alerts", () => {
  const previous = { creatorShare: 30, top10Share: 80, lpBurnedShare: 90, poolScope: "a", timestamp: "before" };
  const allFresh = { creatorShare: true, top10Share: true, lpBurnedShare: true };
  const missing = nextOwnershipSnapshot(previous, { ...previous, creatorShare: null, top10Share: null, lpBurnedShare: null }, allFresh);
  assert.deepEqual(missing.next, previous);
  assert.deepEqual(Object.values(missing.comparable), [false, false, false]);
  const stale = nextOwnershipSnapshot(previous, { ...previous, top10Share: 0 }, { ...allFresh, top10Share: false });
  assert.equal(stale.next.top10Share, 80);
  assert.equal(stale.comparable.top10Share, false);
  const recovered = nextOwnershipSnapshot(stale.next, { ...previous, top10Share: 85 }, allFresh);
  assert.equal(recovered.comparable.top10Share, true);
  assert.equal(recovered.next.top10Share, 85);
});

test("newly discovered pool exclusions rebase concentration without a false reduction alert", () => {
  const previous = { creatorShare: 0, top10Share: 80, lpBurnedShare: 0, poolScope: "a", timestamp: "before" };
  const next = nextOwnershipSnapshot(previous, { ...previous, poolScope: "a,b", top10Share: 30 }, { creatorShare: true, top10Share: true, lpBurnedShare: true });
  assert.equal(next.comparable.top10Share, false);
  assert.equal(next.next.top10Share, 30);
  assert.equal(next.next.poolScope, "a,b");
});

test("window return requires a price at or before its boundary, including new pools", () => {
  const cutoff = Date.parse("2026-09-09T00:00:00Z");
  const short = [{ price: 110, timestamp: "2026-09-09T00:50:00Z" }, { price: 120, timestamp: "2026-09-09T01:00:00Z" }];
  assert.equal(windowPriceChange(short, 120, cutoff), null);
  assert.equal(windowPriceChange([], 120, cutoff), null);
  assert.equal(windowPriceChange([...short, { price: 100, timestamp: "2026-09-09T00:00:00Z" }], 120, cutoff), 20);
  assert.equal(windowPriceChange([{ price: 0, timestamp: "2026-09-08T00:00:00Z" }], 120, cutoff), null);
});

test("swap recipient fallback is never labeled as transaction sender", () => {
  assert.deepEqual(tradeActor(undefined, address(2)), { address: address(2), role: "Recipient" });
  assert.deepEqual(tradeActor(address(1), address(2)), { address: address(1), role: "Sender" });
  assert.equal(tradeActor(undefined, null), null);
});

// Exercise the real detail orchestration with fixture API responses, without a DOM or network.
const mainSource = ts.createSourceFile("arc-radar.ts", readFileSync(new URL("../src/arc-radar.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compileMain(names: string[]): string {
  const program = mainSource.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""))
    .map(node => node.getText(mainSource)).join("\n");
  return ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test("market and header searches stay synchronized; only submitted addresses navigate", () => {
  const inputs = new Map(["searchInput", "marketSearchInput"].map(id => [id, { value: "" }]));
  const navigations: string[] = [];
  const notices: Array<string | undefined> = [];
  const context = {
    byId: (id: string) => inputs.get(id), linkedToken: null as string | null,
    NETWORK: ARC_RADAR_MAINNET, rpcReader: {}, URL, marketUrl,
    location: { href: "http://localhost:4173/public/arc-radar.html?network=arc-mainnet", assign: (url: string) => navigations.push(url) },
    activeQuery: "", activeFilter: "all", applyFilter: () => {}, discoveryOptions: { minimumFdv: 0 },
    searchGeneration: 0, pendingTokenSearch: null, tokenSearchStates: new Map(), queueTokenSearch: () => {},
    visibleMarkets: () => [{}], setNotice: (notice?: string) => notices.push(notice), renderTokenSearch: () => 0,
  };
  const script = compileMain(["setSearchInputs", "runSearch"]);
  runInNewContext(`${script}\nrunSearch(' LoNg ', false)`, context);
  assert.equal(context.activeQuery, "long");
  assert.deepEqual([...inputs.values()].map(input => input.value), [" LoNg ", " LoNg "]);
  assert.equal(notices.at(-1), undefined);
  runInNewContext(`${script}\nrunSearch('${address(10)}', false)`, context);
  assert.equal(navigations.length, 0);
  runInNewContext(`${script}\nrunSearch('${address(10)}')`, context);
  assert.equal(new URL(navigations[0]!).searchParams.get("token"), address(10));
  context.linkedToken = address(10);
  runInNewContext(`${script}\nrunSearch('', false)`, context);
  assert.equal(navigations[1], context.location.href);
  assert.deepEqual([...inputs.values()].map(input => input.value), ["", ""]);
  context.linkedToken = null;
  context.visibleMarkets = () => [];
  runInNewContext(`${script}\nrunSearch('unlisted', false)`, context);
  assert.equal(notices.at(-1), "No match in the loaded pools with these filters.");
  context.renderTokenSearch = () => 1;
  runInNewContext(`${script}\nrunSearch('long', false)`, context);
  assert.equal(notices.at(-1), undefined);
});

test("loaded market search combines volume sorting, address identity and existing filters", () => {
  const makeMarket = (id: number, name: string, symbol: string, volume: number, liquidity: number | null) => ({
    chainId: 5042, tokenAddress: address(id), pairAddress: address(id + 100), token: { name, symbol },
    createdAt: "2026-09-16T00:00:00Z", lastTradeAt: "2026-09-16T01:00:00Z", stale: false,
    totalLiquidity: liquidity, sellCount: 1, periods: { h24: { volumeUsdc: volume, swapCount: volume ? 1 : 0 } },
  });
  const context = {
    activeQuery: "", activeFilter: "all", watchlist: new Set([address(2)]),
    markets: [makeMarket(1, "Long One", "LONG", 20, 200), makeMarket(2, "Long Two", "LONG", 50, null), makeMarket(3, "Quiet", "QUIET", 0, 100)],
    discoveryOptions: { sort: "volume", minimumLiquidity: 0, traded24h: false, sellSeen: false },
    poolRef, refineMarkets, groupTokenPools,
  };
  const script = `${compileMain(["marketCandidates", "visibleMarkets"])}\nvisibleMarkets().map(market => market.tokenAddress)`;
  const results = () => Array.from(runInNewContext(script, context));
  assert.deepEqual(results(), [address(2), address(1), address(3)]);
  context.activeQuery = "LoNg";
  assert.deepEqual(results(), [address(2), address(1)]);
  context.activeQuery = "two";
  assert.deepEqual(results(), [address(2)]);
  context.activeQuery = address(1);
  assert.deepEqual(results(), [address(1)]);
  context.activeQuery = address(102);
  assert.deepEqual(results(), [address(2)]);
  context.activeQuery = "not-loaded";
  assert.deepEqual(results(), []);
  context.activeQuery = "";
  context.activeFilter = "watchlist";
  assert.deepEqual(results(), [address(2)]);
  context.activeFilter = "all";
  context.discoveryOptions.minimumLiquidity = 150;
  assert.deepEqual(results(), [address(1)]);
  context.discoveryOptions.minimumLiquidity = 0;
  context.discoveryOptions.traded24h = true;
  assert.deepEqual(results(), [address(2), address(1)]);
});

test("FDV screening uses the representative pool rather than promoting an inflated outlier", () => {
  const market = { chainId: 5042, tokenAddress: address(1), pairAddress: address(101), token: { name: "LONG", symbol: "LONG" },
    createdAt: "2026-09-16T00:00:00Z", lastTradeAt: "2026-09-16T01:00:00Z", stale: false,
    totalLiquidity: 100, sellCount: 1, periods: { h24: { volumeUsdc: 50, swapCount: 2 } }, fdv: 5_000_000 };
  const context = { activeQuery: "long", activeFilter: "all", watchlist: new Set(),
    markets: [market, { ...market, pairAddress: address(102), totalLiquidity: 1, fdv: 100_000_000 }],
    discoveryOptions: { sort: "volume", minimumLiquidity: 0, minimumFdv: 10_000_000, traded24h: false, sellSeen: false },
    poolRef, refineMarkets, groupTokenPools };
  const script = `${compileMain(["marketCandidates", "visibleMarkets"])}\nvisibleMarkets()`;
  assert.equal(runInNewContext(script, context).length, 0);
  market.fdv = 10_000_000;
  assert.equal(runInNewContext(script, context)[0].pairAddress, market.pairAddress);
});

test("tightening any metric filter cannot switch representatives and admit an FDV outlier", () => {
  const primary = { chainId: 5042, tokenAddress: address(1), pairAddress: address(101), token: { name: "LONG", symbol: "LONG" },
    createdAt: "", lastTradeAt: null, stale: false, currentPrice: 0.005, totalLiquidity: null,
    usdcReserve: 100, sellCount: 0, periods: { h24: { volumeUsdc: 0, swapCount: 0 } }, fdv: 5_000_000 };
  const outlier = { ...primary, pairAddress: address(102), stale: true, currentPrice: 0.1, totalLiquidity: 100, sellCount: 1,
    createdAt: new Date().toISOString(), periods: { h24: { volumeUsdc: 100, swapCount: 1 } }, fdv: 100_000_000 };
  const context = { activeQuery: "long", activeFilter: "all", watchlist: new Set(), markets: [primary, outlier],
    discoveryOptions: { sort: "fdv", minimumLiquidity: 0, minimumFdv: 10_000_000, traded24h: false, sellSeen: false },
    poolRef, refineMarkets, groupTokenPools, needsReview: (m: typeof primary) => m.sellCount === 0 };
  const script = `${compileMain(["marketCandidates", "visibleMarkets"])}\nvisibleMarkets()`;
  for (const filter of ["all", "active", "new", "sells", "risky"]) {
    context.activeFilter = filter;
    for (const minimumLiquidity of [0, 1]) for (const traded24h of [false, true]) for (const sellSeen of [false, true]) {
      Object.assign(context.discoveryOptions, { minimumLiquidity, traded24h, sellSeen });
      assert.equal(runInNewContext(script, context).length, 0, `${filter} cannot promote the secondary pool`);
    }
  }
  Object.assign(context.discoveryOptions, { minimumFdv: 0, minimumLiquidity: 0, traded24h: false, sellSeen: false });
  context.activeFilter = "new";
  primary.createdAt = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(runInNewContext(script, context).length, 0, "future creation time cannot pass the new filter");
});

function searchStorage() {
  const data = new Map<string, string>();
  return { data, get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test("name search restores LONG from metadata outside loaded markets and isolates networks", () => {
  const storage = searchStorage(), now = Date.now();
  const token = { address_hash: address(100), name: "Long Supply", symbol: "LONG" };
  storage.setItem("main:-tokens-" + address(100), JSON.stringify({ savedAt: now, data: token }));
  storage.setItem("test:-tokens-" + address(200), JSON.stringify({ savedAt: now, data: { ...token, address_hash: address(200) } }));
  const directory = new TokenDirectory(storage, "main:directory", ARC_RADAR_MAINNET);
  directory.importCache(storage, "main:");
  assert.equal(directory.search("long").items[0]?.address, address(100));
  assert.equal(directory.search(" LoNg SuP ").items.length, 1);
  assert.equal(directory.search(address(200)).matches, 0);
  assert.equal(new TokenDirectory(storage, "main:directory", ARC_RADAR_MAINNET).search("LONG").matches, 1);
  assert.equal(new TokenDirectory(storage, "main:directory", ARC_RADAR_TESTNET).search("LONG").matches, 0);
});

test("remembered pool identities survive reload without restoring bare names or old metadata", () => {
  const storage = searchStorage(), now = Date.now();
  const directory = new TokenDirectory(storage, "main:directory", ARC_RADAR_MAINNET);
  for (let id = 1; id <= 5; id++) directory.remember({ address_hash: address(id), name: "LONG", symbol: "LONG" }, now - id, address(id + 100));
  directory.remember({ address_hash: address(6), name: "Name only", symbol: "NAME" }, now);
  directory.remember({ address_hash: address(7), name: "Old", symbol: "OLD" }, now - 86_400_001, address(107));
  const reloaded = new TokenDirectory(storage, "main:directory", ARC_RADAR_MAINNET);
  assert.deepEqual(reloaded.remembered(new Set([address(1)])).map(token => token.address), [address(2), address(3), address(4)]);
  assert.equal(new TokenDirectory(storage, "main:directory", ARC_RADAR_TESTNET).remembered().length, 0);
});

test("explicitly viewed pools retain restore priority over newer background metadata across tabs", () => {
  const storage = searchStorage(), now = Date.now();
  const directory = new TokenDirectory(storage, "directory", ARC_RADAR_MAINNET);
  directory.remember({ address_hash: address(1), name: "Viewed", symbol: "VIEWED" }, now - 600_000, address(101));
  const other = new TokenDirectory(storage, "directory", ARC_RADAR_MAINNET);
  directory.viewed(address(1));
  for (let id = 2; id < 7; id++) other.remember({ address_hash: address(id), name: "Background", symbol: "BG" }, now, address(id + 100));
  other.remember({ address_hash: address(1), name: "Viewed", symbol: "VIEWED" }, now, address(101));
  const reloaded = new TokenDirectory(storage, "directory", ARC_RADAR_MAINNET);
  assert.equal(reloaded.remembered()[0]?.address, address(1));
  assert.equal(reloaded.remembered().length, 3, "does not increase the RPC budget");
  assert.equal(reloaded.remembered(new Set([address(1)])).some(token => token.address === address(1)), false);
  const raw = JSON.parse(storage.getItem("directory")!);
  raw.tokens.find((token: any) => token.address === address(2)).viewedAt = Date.now() + 86_400_000;
  storage.setItem("directory", JSON.stringify(raw));
  assert.equal(new TokenDirectory(storage, "directory", ARC_RADAR_MAINNET).remembered()[0]?.address, address(1), "future priority is ignored");
});

test("name collisions remain separate by address; exact symbol precedes partial matches", () => {
  const directory = new TokenDirectory(null, "test", ARC_RADAR_MAINNET), now = Date.now();
  for (const [id, symbol] of [[1, "LONGCAT"], [2, "LONG"], [3, "LONG"]] as const) directory.remember({ address_hash: address(id), name: "Long Name", symbol }, now);
  assert.deepEqual(directory.search("long").items.map(token => token.address), [address(2), address(3), address(1)]);
  assert.equal(directory.search("").matches, 0);
  assert.equal(directory.persistent, false);
});

test("saved search excludes loaded identities before applying the result limit", () => {
  const directory = new TokenDirectory(null, "test", ARC_RADAR_MAINNET), now = Date.now();
  for (let id = 1; id <= 25; id++) directory.remember({ address_hash: address(id), name: "Long Name", symbol: "LONG" }, now);
  const excluded = new Set(Array.from({ length: 20 }, (_, index) => address(index + 1)));
  const result = directory.search("long", excluded);
  assert.equal(result.total, 25);
  assert.equal(result.matches, 5);
  assert.deepEqual(result.items.map(token => token.address), [21, 22, 23, 24, 25].map(address));
});

test("saved watchlist search applies membership before the result cap", () => {
  const directory = new TokenDirectory(null, "watchlist", ARC_RADAR_MAINNET);
  for (let id = 1; id <= 30; id++) directory.remember({ address_hash: address(id), name: "Token", symbol: "TOKEN" }, Date.now() - id);
  const result = directory.search("token", new Set(), new Set([address(30)]));
  assert.equal(result.matches, 1);
  assert.equal(result.items[0]?.address, address(30));
});

test("token search belongs to the market board and shares its rows", () => {
  const html = readFileSync(new URL("../public/arc-radar.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="tokenSearchPanel"') > html.indexOf('id="marketList"'));
  assert.ok(html.indexOf('id="tokenSearchPanel"') < html.indexOf('id="marketRows"'));
  assert.ok(!html.includes('id="tokenSearchResults"'));
  const script = compileMain(["renderTokenSearch"]);
  const directory = new TokenDirectory(null, "test", ARC_RADAR_MAINNET);
  directory.remember({ address_hash: address(1), name: "Long Name", symbol: "LONG" }, Date.now());
  directory.remember({ address_hash: address(2), name: "Long Two", symbol: "LONG" }, Date.now());
  function node(tag = "div", className = "", text?: unknown): any {
    return { tag, className, text, children: [] as any[], hidden: false, scrolled: false,
      classList: { toggle: (_: string, hidden: boolean) => { panel.hidden = hidden; } },
      append(...children: any[]) { this.children.push(...children); },
      querySelectorAll(selector: string) { return this.children.filter((child: any) => child.className.split(" ").includes(selector.slice(1))); },
      remove() { rows.children = rows.children.filter((child: any) => child !== this); },
      scrollIntoView() { this.scrolled = true; } };
  }
  const rows = node(), panel = node(), board = node(), copies = new Map<string, any>();
  rows.append(node("button", "market-row", "Loaded LONG"));
  const context = { byId: (id: string) => id === "marketRows" ? rows : id === "marketList" ? board : panel,
    element: node, NETWORK: ARC_RADAR_MAINNET, routeError: null, tokenDirectory: directory, tokenSearchStates: new Map(),
    activeFilter: "all", activeProtocol: "all", watchlist: new Set<string>(),
    discoveryOptions: { minimumFdv: 0, minimumLiquidity: 0, traded24h: false, sellSeen: false },
    markets: [{ tokenAddress: address(1) }], visibleMarkets: () => [{}],
    setCopy: (id: string, value: any) => copies.set(id, value), copy, localize: () => {}, tokenSearchUrl,
    shortHash: (value: string) => value, URL, location: { href: "https://local.test/", origin: "https://local.test" } };
  runInNewContext(`${script}\nrenderTokenSearch('long', true)`, context);
  assert.equal(rows.children.length, 2);
  assert.equal(rows.children[0].text, "Loaded LONG");
  assert.equal(new URL(rows.children[1].href).searchParams.get("token"), address(2));
  assert.equal(copies.get("tokenSearchCount").values.shown, 2);
  assert.equal(panel.scrolled, true);
  assert.equal(copies.get("marketSummary").values.saved, 1);
  runInNewContext(`${script}\nrenderTokenSearch('long')`, context);
  assert.equal(rows.children.length, 2, "rerenders do not duplicate saved rows");
  context.discoveryOptions.minimumFdv = 10_000_000;
  runInNewContext(`${script}\nrenderTokenSearch('long')`, context);
  assert.equal(rows.children.length, 1, "unvalued saved tokens cannot pass the FDV filter");
  assert.equal(copies.get("tokenSearchUnvalued").values.count, 1);
  assert.equal(copies.get("tokenSearchCount").values.count, 1);
  context.discoveryOptions.minimumFdv = 0;
  for (const setting of ["liquidity", "trades", "sells", "active", "new", "risky", "protocol", "watchlist"]) {
    context.discoveryOptions.minimumLiquidity = setting === "liquidity" ? 1 : 0;
    context.discoveryOptions.traded24h = setting === "trades";
    context.discoveryOptions.sellSeen = setting === "sells";
    context.activeFilter = ["active", "new", "risky", "watchlist"].includes(setting) ? setting : "all";
    context.activeProtocol = setting === "protocol" ? "uniswap-v3" : "all";
    runInNewContext(`${script}\nrenderTokenSearch('long')`, context);
    assert.equal(rows.children.length, 1, `${setting} must not admit unchecked identities`);
  }
  context.watchlist.add(address(2));
  runInNewContext(`${script}\nrenderTokenSearch('long')`, context);
  assert.equal(rows.children.length, 2, "known watchlist identity can appear without market metric restrictions");
  runInNewContext(`${script}\nrenderTokenSearch('')`, context);
  assert.equal(rows.children.length, 1);
  assert.equal(panel.hidden, true);
});

test("search storage tolerates bad data and unavailable storage without unsafe links or HTML", () => {
  const storage = searchStorage(), now = Date.now();
  const directory = new TokenDirectory(storage, "directory", ARC_RADAR_MAINNET);
  for (const token of [{ address_hash: "javascript:alert(1)", name: "Bad", symbol: "BAD" },
    { address_hash: address(1), name: "A".repeat(121), symbol: "BAD" }]) directory.remember(token, now);
  directory.remember({ address_hash: address(2), name: "Future", symbol: "FUTURE" }, now + 10000);
  directory.remember({ address_hash: address(3), name: "Old", symbol: "OLD" }, now - 91 * 86_400_000);
  assert.equal(directory.search("a").total, 0);
  const rawName = "<img src=x onerror=alert(1)>";
  directory.remember({ address_hash: address(4), name: rawName, symbol: "HTML" }, now);
  assert.equal(directory.search("html").items[0]?.name, rawName);
  storage.setItem = () => { throw new Error("Quota"); };
  directory.remember({ address_hash: address(5), name: "Long", symbol: "LONG" }, now);
  assert.equal(directory.search("long").matches, 1); assert.equal(directory.persistent, false);
  assert.throws(() => tokenSearchUrl("https://local.test", ARC_RADAR_MAINNET, { ...directory.search("long").items[0]!, address: "javascript:alert(1)" }));
});

function searchLoadFixture(count = 1) {
  const tokens = Array.from({ length: count }, (_, index) => ({ address: address(index + 10), name: "LONG", symbol: "LONG", pools: [], seenAt: Date.now() }));
  const refresh = { disabled: false }, paints: number[] = [], selected: string[] = [];
  const context: Record<string, any> = {
    NETWORK: ARC_RADAR_MAINNET, localMarketMode: false, loading: false, searchGeneration: 1, activeFilter: "all",
    pendingTokenSearch: { generation: 1, tokens }, tokenSearchStates: new Map(),
    rpcReader: { checkNetwork: async () => {} }, MAX_MARKETS: 150, loadProgress: {},
    markets: [{ chainId: 5042, tokenAddress: address(1), pairAddress: address(101) }],
    byId: () => refresh, renderDiscoveryControls: () => {},
    renderMarketRows: () => paints.push(context.markets.length), poolRef,
    resolveSearchSeeds: async (token: any) => [{ chainId: 5042, tokenAddress: token.address, pairAddress: address(Number(BigInt(token.address)) + 100) }],
    loadMarketPair: async (seed: any, force: boolean, options: any) => { assert.equal(force, false); assert.equal(options.quick, true); return seed; },
    visibleMarkets: () => context.markets.filter((market: any) => tokens.some(token => token.address === market.tokenAddress)),
    selectMarket: async (market: any) => selected.push(market.tokenAddress),
  };
  const script = compileMain(["flushTokenSearch", "mapLimited"]);
  return { context, refresh, paints, selected, tokens, run: () => runInNewContext(`${script}\nflushTokenSearch()`, context) };
}

test("startup revalidates remembered missing markets once and does not override the selected market", async () => {
  const fixture = searchLoadFixture(), directory = new TokenDirectory(null, "test", ARC_RADAR_MAINNET);
  directory.remember({ address_hash: address(10), name: "LONG", symbol: "LONG" }, Date.now(), address(110));
  Object.assign(fixture.context, { tokenDirectory: directory, pendingTokenSearch: null, rememberedMarketsQueued: false,
    activeQuery: "", linkedPool: null, linkedToken: null, routeError: "", selectedPair: address(101) });
  const queue = compileMain(["queueRememberedMarkets"]);
  runInNewContext(`${queue}\nqueueRememberedMarkets()`, fixture.context);
  assert.equal(fixture.context.pendingTokenSearch.tokens[0].address, address(10));
  assert.equal(fixture.context.pendingTokenSearch.background, true);
  await fixture.run();
  assert.equal(fixture.context.markets.length, 2);
  assert.deepEqual(fixture.selected, []);
  fixture.context.markets.pop();
  runInNewContext(`${queue}\nqueueRememberedMarkets()`, fixture.context);
  assert.equal(fixture.context.pendingTokenSearch, null, "no retry loop on automatic refresh");
  runInNewContext(`${queue}\nqueueRememberedMarkets(true)`, fixture.context);
  assert.equal((fixture.context.pendingTokenSearch as { tokens: unknown[] } | null)?.tokens.length, 1, "manual refresh can retry");
  fixture.context.pendingTokenSearch = null;
  fixture.context.activeQuery = "something else";
  runInNewContext(`${queue}\nqueueRememberedMarkets(true)`, fixture.context);
  assert.equal(fixture.context.pendingTokenSearch, null, "restoration cannot replace a user's search");
});

test("FDV coverage distinguishes unknown valuations from tokens removed by a filter", () => {
  const copies = new Map<string, any>();
  const candidates = [null, 2_000_000, Infinity, 500_000].map((fdv, index) => ({ fdv, chainId: 5042, tokenAddress: address(index + 1), pairAddress: address(index + 100), totalLiquidity: null, stale: false }));
  const context = { markets: candidates, marketCandidates: () => candidates,
    discoveryOptions: { minimumFdv: 1_000_000, minimumLiquidity: 1 },
    groupTokenPools, visibleMarkets: () => [], marketLoadFailed: false, setCopy: (id: string, value: any) => copies.set(id, value), copy, formatValue: String };
  runInNewContext(`${compileMain(["renderMarketSummary"])}\nrenderMarketSummary()`, context);
  assert.equal(copies.get("fdvCoverage").values.known, 2);
  assert.equal(copies.get("fdvCoverage").values.total, 4);
  assert.equal(copies.get("fdvCoverage").values.unknown, 2);
  assert.equal(copies.get("fdvFilterSummary").values.passed, 1);
  assert.equal(copies.get("fdvFilterSummary").values.below, 1);
  assert.equal(copies.get("fdvFilterSummary").values.unknown, 2);
  assert.match(copies.get("liquidityFilterSummary"), /unknown/);
});

test("submitted search loads market data in place, preserves earlier markets and avoids duplicate pools", async () => {
  const fixture = searchLoadFixture();
  const resolve = fixture.context.resolveSearchSeeds;
  fixture.context.resolveSearchSeeds = async (token: any) => [...await resolve(token), ...await resolve(token)];
  await fixture.run();
  assert.equal(fixture.context.markets.length, 2);
  assert.equal(fixture.context.markets[0].tokenAddress, address(1));
  assert.equal(fixture.context.markets[1].tokenAddress, address(10));
  assert.ok(fixture.paints.includes(2));
  assert.deepEqual(fixture.selected, [address(10)]);
  assert.equal(fixture.context.loading, false);
  assert.equal(fixture.refresh.disabled, false);
});

test("search waits for a running refresh and bounds automatic work to three identities", async () => {
  const fixture = searchLoadFixture();
  fixture.context.loading = true;
  await fixture.run();
  assert.ok(fixture.context.pendingTokenSearch);
  assert.equal(fixture.context.markets.length, 1);
  fixture.context.loading = false;
  await fixture.run();
  assert.equal(fixture.context.markets.length, 2);
  const queue = searchLoadFixture(5);
  Object.assign(queue.context, { tokenDirectory: { search: () => ({ items: queue.tokens }), viewed: () => {} },
    linkedPool: null, linkedToken: null, routeError: "", flushTokenSearch: () => {} });
  runInNewContext(`${compileMain(["queueTokenSearch"])}\nqueueTokenSearch('long')`, queue.context);
  assert.equal(queue.context.pendingTokenSearch.tokens.length, 3);
});

test("missing pools and failed lookups remain distinct; one failure does not stop other tokens", async () => {
  const fixture = searchLoadFixture(3);
  fixture.context.resolveSearchSeeds = async (token: any) => {
    if (token.address === address(10)) return [];
    if (token.address === address(11)) throw new Error("RPC unavailable");
    return [{ chainId: 5042, tokenAddress: token.address, pairAddress: address(112) }];
  };
  await fixture.run();
  assert.equal(fixture.context.tokenSearchStates.get(address(10)), "No pool found in the supported lookup.");
  assert.equal(fixture.context.tokenSearchStates.get(address(11)), "Market lookup failed. Search again to retry.");
  assert.equal(fixture.context.markets.at(-1).tokenAddress, address(12));
});

test("changing or clearing a query discards in-flight results and restores controls", async () => {
  const fixture = searchLoadFixture();
  let entered!: () => void, release!: (value: any) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  fixture.context.loadMarketPair = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const flight = fixture.run();
  await started;
  fixture.context.searchGeneration++;
  release({ chainId: 5042, tokenAddress: address(10), pairAddress: address(110) });
  await flight;
  assert.equal(fixture.context.markets.length, 1);
  assert.deepEqual(fixture.selected, []);
  assert.equal(fixture.refresh.disabled, false);
});

test("search respects the session cap and rejects mismatched market identity", async () => {
  const capped = searchLoadFixture();
  capped.context.MAX_MARKETS = 1;
  capped.context.resolveSearchSeeds = () => { assert.fail("must not read over the cap"); };
  await capped.run();
  assert.equal(capped.context.tokenSearchStates.get(address(10)), "Session pool limit reached");
  const wrong = searchLoadFixture();
  wrong.context.loadMarketPair = async () => ({ chainId: 5042002, tokenAddress: address(10), pairAddress: address(110) });
  await wrong.run();
  assert.equal(wrong.context.markets.length, 1);
  assert.equal(wrong.context.tokenSearchStates.get(address(10)), "Market lookup failed. Search again to retry.");
});

test("two tabs merge token identities; result URLs retain chain and checked pool routing", () => {
  const storage = searchStorage(), one = new TokenDirectory(storage, "directory", ARC_RADAR_MAINNET), two = new TokenDirectory(storage, "directory", ARC_RADAR_MAINNET), now = Date.now();
  one.remember({ address_hash: address(1), name: "First", symbol: "FIRST" }, now);
  two.remember({ address_hash: address(2), name: "Second", symbol: "SECOND" }, now, address(20));
  assert.equal(one.search("second").matches, 1); assert.equal(two.search("first").matches, 1);
  const byAddress = new URL(tokenSearchUrl("https://local.test/?network=arc-testnet&pool=old", ARC_RADAR_MAINNET, one.search("first").items[0]!));
  assert.equal(byAddress.searchParams.get("network"), "arc-mainnet"); assert.equal(byAddress.searchParams.get("token"), address(1)); assert.equal(byAddress.searchParams.has("pool"), false);
  const byPool = new URL(tokenSearchUrl(byAddress.href, ARC_RADAR_MAINNET, one.search("second").items[0]!));
  assert.equal(byPool.searchParams.get("pool"), address(20)); assert.equal(byPool.searchParams.has("token"), false);
});

test("price age is independent of fetch recency and future timestamps are not observations", () => {
  const now = Date.now();
  const old = new Date(now - 3_600_000).toISOString();
  assert.equal(priceFreshness(old, "sync", now), "old");
  assert.equal(priceFreshness(new Date(now - 60_000).toISOString(), "v4", now), "recent");
  assert.equal(priceFreshness(old, "balance", now), "balance");
  assert.equal(priceFreshness(new Date(now + 1).toISOString(), "v4", now), "unknown");
  assert.equal(validObservationTime("invalid", now), false);
  assert.equal(oldestFetchTime([now - 60_000, now], now), now - 60_000);
  assert.equal(oldestFetchTime([undefined, now], now), null);
  assert.equal(oldestFetchTime([now + 1], now), null);
  const message = runInNewContext(`${compileMain(["priceAgeCopy"])}\npriceAgeCopy(market)`, {
    market: { priceEventAt: old, reserveSource: "sync" }, priceFreshness, copy, relativeTime: () => "1h",
  });
  assert.match(translate(message, "en"), /over 15m/);
  assert.match(translate(message, "ko"), /15분 초과/);
  assert.match(translate(message, "ja"), /15分超/);
});

test("cached and failed fetches retain the original fetchedAt instead of resetting the clock", async () => {
  const fetchedAt = Date.now() - 60_000;
  let requests = 0;
  const context = {
    NETWORK: {}, rpcReader: null, networkError: "", API_BASE: "https://example.invalid", AbortController,
    window: { setTimeout, clearTimeout }, readCache: () => ({ data: { items: [] }, savedAt: fetchedAt }), writeCache: () => {},
    fetch: async () => { requests++; throw new Error("offline"); },
  };
  const script = compileMain(["readData"]);
  const cached = await runInNewContext(`${script}\nreadData('/logs', 120000)`, context);
  assert.equal(cached.fetchedAt, fetchedAt);
  assert.equal(cached.stale, false);
  assert.equal(requests, 0);
  const fallback = await runInNewContext(`${script}\nreadData('/logs', 120000, true)`, context);
  assert.equal(fallback.fetchedAt, fetchedAt);
  assert.equal(fallback.stale, true);
  assert.equal(requests, 1);
});

test("invalid log-page shape fails instead of rendering zero market activity", async () => {
  await assert.rejects(runInNewContext(`${compileMain(["fetchAddressLogs"])}\nfetchAddressLogs('fixture', 10, true, 0)`, {
    URLSearchParams, rpcReader: null, oldestFetchTime, LOG_PAGE_LIMIT: 4, fetchData: async () => ({ data: { error: "unavailable" }, stale: false }),
  }), /Invalid indexed log response/);
});

test("malformed HTTP success cannot overwrite the last valid cached log page", async () => {
  const savedAt = Date.now() - 60_000;
  let writes = 0;
  const result = await runInNewContext(`${compileMain(["readData"])}\nreadData('/addresses/fixture/logs', 10, true)`, {
    NETWORK: {}, rpcReader: null, API_BASE: "https://example.invalid", AbortController, window: { setTimeout, clearTimeout },
    readCache: () => ({ data: { items: [] }, savedAt }), writeCache: () => { writes++; },
    fetch: async () => ({ ok: true, json: async () => ({ error: "unavailable" }) }),
  });
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, savedAt);
  assert.equal(writes, 0);
});

test("real market loading preserves missing FDV instead of fabricating zero", async () => {
  const adapter = createDexAdapter(ARC_RADAR_TESTNET.sources[0]!, ARC_RADAR_TESTNET);
  const seed = { ...selected, sourceId: adapter.source.id, quoteAsset: ARC_RADAR_TESTNET.quoteAsset, token0: selected.tokenAddress, token1: ARC_RADAR_TESTNET.quoteAsset.address };
  const logs = [{ index: 1, block_timestamp: new Date().toISOString(), decoded: { method_call: "Sync(...)", parameters: [
    { name: "reserve0", value: "1000000000000000000" }, { name: "reserve1", value: "9000000" },
  ] } }];
  logs.push({ ...logs[0]!, index: 2, block_timestamp: new Date(Date.now() + 86_400_000).toISOString() });
  const script = compileMain(["loadMarketPair", "marketPeriods", "periodMetrics"]);
  const market = await runInNewContext(`${script}\nloadMarketPair(seed, true)`, {
    rpcReader: null, poolStatePrice,
    observePool, observations: new ObservationStore(null, "test"), poolCacheKey: poolRef, tokenDirectory: null,
    seed, comparePricePoints, oldestFetchTime, validObservationTime, DAY_MS: 86_400_000, decimalValue, fullyDilutedValue, windowPriceChange, adapterFor: () => adapter, observeMarketChanges: () => {},
    fetchData: async () => ({ data: { decimals: "18", total_supply: null }, stale: false }),
    fetchAddressLogs: async () => ({ items: logs, stale: false, truncated: false }),
  });
  assert.equal(market.currentPrice, 9);
  assert.equal(market.fdv, null);
  assert.equal(market.stale, false);
  assert.equal(market.historyTruncated, true);
  assert.equal(market.pricePoints.length, 1);
  assert.equal(market.priceEventAt, logs[0]!.block_timestamp);
  assert.equal(market.priceFetchedAt, null);
});

test("v4 real market loading never reads shared balances or applies v2 exit math", async () => {
  const adapter = createDexAdapter(v4.source, ARC_RADAR_TESTNET);
  const seed = adapter.pairSeeds({ items: [v4.initialize()] })[0]!;
  const logs = [v4.swap(seed.v4!.poolId as `0x${string}`, 1n, -2n, 2n << 96n, 3),
    v4.swap(seed.v4!.poolId as `0x${string}`, 1n, -1n, 1n << 96n, 2)];
  const requested: string[] = [];
  const script = compileMain(["loadMarketPair", "marketPeriods", "periodMetrics", "exitEstimate"]);
  const result = await runInNewContext(`${script}\nloadMarketPair(seed, true).then(market => ({market, exit: exitEstimate(market, 1)}))`, {
    rpcReader: null, poolStatePrice,
    observePool, observations: new ObservationStore(null, "test"), poolCacheKey: poolRef, tokenDirectory: null,
    seed, comparePricePoints, oldestFetchTime, validObservationTime, DAY_MS: 86_400_000, decimalValue, fullyDilutedValue, windowPriceChange,
    adapterFor: () => adapter, observeMarketChanges: () => {},
    fetchData: async (path: string) => {
      requested.push(path);
      if (path !== `/tokens/${seed.tokenAddress}`) throw new Error("Shared balance lookup is forbidden");
      return { data: { decimals: "6", total_supply: "1000000000" }, stale: false };
    },
    fetchAddressLogs: async () => ({ items: logs, stale: false, truncated: true }),
  });
  assert.deepEqual(requested, [`/tokens/${seed.tokenAddress}`]);
  assert.equal(result.market.currentPrice, 4);
  assert.equal(result.market.totalLiquidity, null);
  assert.equal(result.market.usdcReserve, null);
  assert.equal(result.market.reserveSource, "v4");
  assert.equal(result.market.historyTruncated, true);
  assert.equal(result.exit, null);
});

test("concurrent singleton reads share one request and release failed flights", async () => {
  let requests = 0;
  let fail = false;
  const dataFlights = new Map();
  const run = () => runInNewContext(`${compileMain(["fetchData"])}\nPromise.all([fetchData('/logs', 10, true), fetchData('/logs', 10, true)])`, {
    dataFlights, readData: async () => { requests++; await Promise.resolve(); if (fail) throw new Error("Unavailable"); return { data: {}, stale: false }; },
  });
  await run();
  assert.equal(requests, 1);
  assert.equal(dataFlights.size, 0);
  fail = true;
  await assert.rejects(run(), /Unavailable/);
  assert.equal(dataFlights.size, 0);
  fail = false;
  await run();
  assert.equal(requests, 3);
});

test("v3 market loading preserves unknown creation and never reads v2 balances or exit estimates", async () => {
  const source = ARC_RADAR_MAINNET.sources.find(s => s.protocol === "uniswap-v3")!;
  const adapter = createDexAdapter(source, ARC_RADAR_MAINNET);
  const seed = { sourceId: source.id, chainId: 5042, quoteAsset: ARC_RADAR_MAINNET.quoteAsset,
    pairAddress: address(200), token0: address(10), token1: ARC_RADAR_MAINNET.quoteAsset.address,
    tokenAddress: address(10), createdAt: "", creationTx: "", v3: { fee: 3000, tickSpacing: 60 } };
  const logs = [{ address: { hash: seed.pairAddress }, transaction_hash: `0x${"1".repeat(64)}`, block_number: 100, index: 0,
    block_timestamp: new Date(Date.now() - 1000).toISOString(), topics: encodeEventTopics({ abi: V3_EVENTS, eventName: "Initialize" }),
    data: encodeAbiParameters([{ type: "uint160" }, { type: "int24" }], [2n << 96n, 0]) }];
  const requested: string[] = [];
  const script = compileMain(["loadMarketPair", "marketPeriods", "periodMetrics", "exitEstimate"]);
  const result = await runInNewContext(`${script}\nloadMarketPair(seed, true).then(market => ({market, exit: exitEstimate(market, 1)}))`, {
    rpcReader: null, poolStatePrice,
    observePool, observations: new ObservationStore(null, "test"), poolCacheKey: poolRef, tokenDirectory: null,
    seed, comparePricePoints, oldestFetchTime, validObservationTime, DAY_MS: 86_400_000, decimalValue, fullyDilutedValue, windowPriceChange,
    adapterFor: () => adapter, observeMarketChanges: () => {},
    fetchData: async (path: string) => {
      requested.push(path);
      if (path !== `/tokens/${seed.tokenAddress}`) throw new Error("v2 balance lookup forbidden");
      return { data: { decimals: "6", total_supply: "1000000000" }, stale: false, fetchedAt: Date.now() };
    },
    fetchAddressLogs: async () => ({ items: logs, stale: false, truncated: true, fetchedAt: Date.now() }),
  });
  assert.deepEqual(requested, [`/tokens/${seed.tokenAddress}`]);
  assert.equal(result.market.currentPrice, 4); assert.equal(result.market.reserveSource, "v3");
  assert.equal(result.market.totalLiquidity, null); assert.equal(result.market.usdcReserve, null);
  assert.equal(result.market.createdAt, ""); assert.equal(result.market.creationTx, "");
  assert.equal(result.market.historyTruncated, true); assert.equal(result.exit, null);
});

test("quiet v3 pools receive FDV from state without fabricating swaps, price events, or candles", async () => {
  const source = ARC_RADAR_MAINNET.sources.find(s => s.protocol === "uniswap-v3")!;
  const seed = { sourceId: source.id, chainId: 5042, quoteAsset: ARC_RADAR_MAINNET.quoteAsset,
    pairAddress: address(200), token0: address(10), token1: ARC_RADAR_MAINNET.quoteAsset.address,
    tokenAddress: address(10), createdAt: "", creationTx: "", v3: { fee: 3000, tickSpacing: 60 } };
  const state = { address: seed.pairAddress, poolId: null, sqrtPriceX96: String(2n << 96n), blockNumber: 100,
    blockHash: `0x${"1".repeat(64)}`, timestamp: new Date(Date.now() - 1000).toISOString() };
  let quote: any = { data: state, stale: false, fetchedAt: Date.now() };
  const context: any = { rpcReader: {}, poolStatePrice, poolRef, tokenDirectory: null, seed, comparePricePoints, oldestFetchTime, validObservationTime,
    observePool, observations: new ObservationStore(null, "test"), poolCacheKey: poolRef, DAY_MS: 86_400_000,
    decimalValue, fullyDilutedValue, windowPriceChange, adapterFor: () => createDexAdapter(source, ARC_RADAR_MAINNET), observeMarketChanges: () => {},
    fetchData: async () => ({ data: { decimals: "6", total_supply: "1000000000000" }, stale: false, fetchedAt: Date.now() }),
    fetchAddressLogs: async () => ({ items: [], stale: false, truncated: true, fetchedAt: Date.now() }),
    fetchOptional: async (path: string) => { assert.equal(path, `/pools/${seed.pairAddress}/state`); return quote; } };
  runInNewContext(compileMain(["loadMarketPair", "marketPeriods", "periodMetrics"]), context);
  const market = await context.loadMarketPair(seed, false);
  assert.equal(market.currentPrice, 4); assert.equal(market.fdv, 4_000_000);
  assert.equal(market.priceEventAt, null); assert.equal(market.priceStateAt, state.timestamp);
  assert.equal(market.lastTradeAt, null); assert.equal(market.pricePoints.length, 0); assert.equal(market.trades.length, 0);
  assert.equal(refineMarkets([market], { sort: "fdv", minimumFdv: 1_000_000, minimumLiquidity: 0, traded24h: false, sellSeen: false }).length, 1);
  quote = { ...quote, stale: true };
  assert.equal((await context.loadMarketPair(seed, false)).stale, true);
  quote = null;
  assert.equal((await context.loadMarketPair(seed, false)).fdv, null);
  quote = { data: { ...state, address: address(201) }, stale: false };
  assert.equal((await context.loadMarketPair(seed, false)).fdv, null);
  const recentEventAt = new Date().toISOString();
  context.fetchAddressLogs = async () => ({ stale: false, truncated: true, fetchedAt: Date.now(), items: [{
    address: { hash: seed.pairAddress }, transaction_hash: `0x${"2".repeat(64)}`, block_number: 101, index: 0,
    block_timestamp: recentEventAt, topics: encodeEventTopics({ abi: V3_EVENTS, eventName: "Initialize" }),
    data: encodeAbiParameters([{ type: "uint160" }, { type: "int24" }], [3n << 96n, 0]),
  }] });
  quote = { data: state, stale: true, fetchedAt: Date.now() - 60000 };
  const newer = await context.loadMarketPair(seed, false);
  assert.equal(newer.currentPrice, 9); assert.equal(newer.priceEventAt, recentEventAt); assert.equal(newer.priceStateAt, null);
  assert.equal(newer.stale, false, "an unused older state does not taint the newer event quote");
  context.fetchData = async () => ({ data: { decimals: "6", total_supply: null }, stale: false, fetchedAt: Date.now() });
  assert.equal((await context.loadMarketPair(seed, false)).fdv, null, "pool state cannot fabricate missing supply");
  const savedAt = Date.now() - 300_000;
  context.snapshotIsStale = snapshotIsStale;
  const persisted: boolean[] = [];
  context.tokenDirectory = { remember: (_token: unknown, _at: number, _pool: string, persist: boolean) => persisted.push(persist) };
  context.fetchData = context.fetchAddressLogs = context.fetchOptional = async () => { throw new Error("No RPC allowed during snapshot rendering"); };
  const saved = await context.loadMarketPair(seed, false, { snapshot: { seed, fetchedAt: savedAt,
    token: { address_hash: seed.tokenAddress, decimals: "6", total_supply: "1000000000000" }, logs: [],
    state: { ...state, timestamp: new Date(savedAt).toISOString() } } });
  assert.ok(saved, "snapshot materializes even with every RPC path disabled");
  assert.equal(saved.fdv, 4_000_000); assert.equal(saved.periodsAsOf, savedAt);
  assert.equal(saved.priceFetchedAt, savedAt); assert.equal(saved.stale, true);
  assert.equal(saved.historyTruncated, true); assert.equal(saved.trades.length, 0);
  assert.deepEqual(persisted, [false], "snapshot batch must not rewrite the full token directory per pool");
});

test("log pagination deduplicates overlapping events and marks missing identities partial", async () => {
  const first = { transaction_hash: "0xAB", index: 1, block_timestamp: new Date().toISOString() };
  let calls = 0;
  const history = await runInNewContext(`${compileMain(["fetchAddressLogs"])}\nfetchAddressLogs('fixture', 10, true, 0)`, {
    URLSearchParams, rpcReader: null, oldestFetchTime, LOG_PAGE_LIMIT: 4,
    fetchData: async () => {
      calls++;
      return { data: { items: [first, { ...first, transaction_hash: "0xab" }, { ...first, index: undefined }], next_page_params: { page: 1 } }, stale: false };
    },
  });
  assert.equal(history.items.length, 1);
  assert.equal(history.truncated, true);
  assert.equal(calls, 2);
});

test("saved pool discovery stays bounded, isolated, age checked and re-decodes real factory events", () => {
  const adapter = createDexAdapter(v4.source, ARC_RADAR_TESTNET), now = Date.now();
  const log = { ...v4.initialize(), block_timestamp: new Date(now - 1000).toISOString() };
  const base = "main:" + dataCacheKey(adapter.discoveryPath);
  const data = new Map<string, string>([[base, JSON.stringify({ savedAt: now - 1000, data: { items: [log] } })],
    [base + "-before-10-anchor-20", "not json"], ["test:" + dataCacheKey(adapter.discoveryPath), JSON.stringify({ savedAt: now, data: { items: [log] } })]]);
  const storage = { get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null, getItem: (key: string) => data.get(key) ?? null };
  assert.equal(cachedPoolSeeds(storage, "main:", [adapter], now).length, 1);
  assert.equal(cachedPoolSeeds(storage, "other:", [adapter], now).length, 0);
  for (const savedAt of [now + 1, now - 86_400_001, "today", null]) {
    data.set(base, JSON.stringify({ savedAt, data: { items: [log] } }));
    assert.equal(cachedPoolSeeds(storage, "main:", [adapter], now).length, 0);
  }
  assert.deepEqual(cachedPoolSeeds({ ...storage, key: () => { throw new Error("Storage blocked"); } }, "main:", [adapter]), []);
});

test("quota recovery evicts only this network's raw API cache, protecting user records", () => {
  const prefix = "main:", oldKey = prefix + dataCacheKey(`/addresses/${address(1)}/logs?before=1&anchor=2`);
  const entries = new Map<string, string>([[oldKey, JSON.stringify({ data: {}, savedAt: 1 })],
    ["main:watchlist", "[]"], ["main:observations:v1", "{}"], ["main:tracking:pool:v1:token", "{}"],
    ["test:" + dataCacheKey(`/tokens/${address(2)}`), "{}"], ["other-app:key", "protected"]]);
  const storage = { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, removeItem: (key: string) => { entries.delete(key); },
    setItem: (key: string, value: string) => {
      if (entries.has(oldKey)) { const error = new Error("full"); error.name = "QuotaExceededError"; throw error; }
      entries.set(key, value);
    } };
  writeMarketCache(storage, prefix, dataCacheKey(`/tokens/${address(3)}`), "new");
  assert.equal(entries.has(oldKey), false); assert.equal(entries.get("main:watchlist"), "[]");
  assert.equal(entries.get("main:observations:v1"), "{}"); assert.equal(entries.get("main:tracking:pool:v1:token"), "{}");
  assert.equal(entries.get("test:" + dataCacheKey(`/tokens/${address(2)}`)), "{}"); assert.equal(entries.get("other-app:key"), "protected");
  storage.setItem = () => { throw new Error("Storage disabled"); };
  const before = [...entries];
  assert.throws(() => writeMarketCache(storage, prefix, "new", "{}"), /Storage disabled/);
  assert.deepEqual([...entries], before);
});

test("cache-only log reads never contact RPC and stop safely at a missing older page", async () => {
  const first = { transaction_hash: "0xAB", index: 1, block_timestamp: new Date().toISOString() };
  let reads = 0;
  const history = await runInNewContext(`${compileMain(["fetchAddressLogs"])}\nfetchAddressLogs('fixture', 10, false, 0, undefined, 4, true)`, {
    URLSearchParams, rpcReader: {}, oldestFetchTime, LOG_PAGE_LIMIT: 4,
    fetchData: () => { throw new Error("Network must not be used"); },
    readCachedData: () => { if (++reads > 1) throw new Error("Missing"); return { data: { items: [first], next_page_params: { before: 1, anchor: 2 } }, stale: true, fetchedAt: 100 }; },
  });
  assert.equal(reads, 2); assert.equal(history.items.length, 1); assert.equal(history.stale, true);
  assert.equal(history.truncated, true); assert.equal(history.fetchedAt, 100);
});

test("factory event journal retains validated pool identities across moving heads and cursor eviction", () => {
  const adapter = createDexAdapter(v4.source, ARC_RADAR_TESTNET), now = Date.now();
  const log = { ...v4.initialize(), block_timestamp: new Date(now - 1000).toISOString() };
  const entries = new Map<string, string>();
  const storage = { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, removeItem: (key: string) => { entries.delete(key); },
    setItem: (key: string, value: string) => { entries.set(key, value); }, clear: () => entries.clear() };
  rememberFactoryPage(storage, "main:", adapter, { items: [log, { ...log, data: "0x" }] }, now);
  rememberFactoryPage(storage, "main:", adapter, { items: [] }, now + 1);
  assert.equal(cachedPoolSeeds(storage, "main:", [adapter], now + 1).length, 1);
  assert.equal(cachedPoolSeeds(storage, "other:", [adapter], now + 1).length, 0);
});

test("fast list history reads one page and keeps a partial-coverage flag", async () => {
  let reads = 0;
  const history = await runInNewContext(`${compileMain(["fetchAddressLogs"])}\nfetchAddressLogs('fixture', 10, true, 0, undefined, 1)`, {
    URLSearchParams, rpcReader: {}, oldestFetchTime, LOG_PAGE_LIMIT: 4,
    fetchData: async () => { reads++; return { data: { items: [], next_page_params: { before: 1, anchor: 2 } }, stale: false }; },
  });
  assert.equal(reads, 1); assert.equal(history.truncated, true);
});

test("saved market cache rejects expired and future fetch times without relabeling timestamps", () => {
  const context = { dataCacheKey, usableCacheTime, readCache: () => ({ data: { value: 3 }, savedAt: Date.now() - 1000 }) };
  const script = compileMain(["readCachedData"]);
  const result = runInNewContext(`${script}\nreadCachedData('/tokens/example')`, context);
  assert.equal(result.stale, true); assert.equal(result.data.value, 3);
  assert.ok(result.fetchedAt < Date.now());
  context.readCache = () => ({ data: { value: 3 }, savedAt: Date.now() + 10000 });
  assert.throws(() => runInNewContext(`${script}\nreadCachedData('/tokens/example')`, context), /No recent/);
});

test("mainnet restores all saved rows together before live work and keeps them cached", async () => {
  const seeds = Array.from({ length: 24 }, (_, index) => ({ ...selected, pairAddress: address(index + 100) }));
  const paints: number[] = [], modes: unknown[] = [];
  const context: Record<string, any> = {
    rpcReader: {}, NETWORK: {}, linkedPool: null, linkedToken: null, routeError: "", localStorage: {}, CACHE_PREFIX: "main:",
    dexAdapters: [], activeProtocol: "all", selectDexAdapters, cachedPoolSeeds: () => seeds, markets: [],
    loadMarketPair: async (seed: typeof selected, force: boolean, options: unknown) => { assert.equal(force, false); modes.push(options); return { ...seed, stale: true }; },
    MARKET_LIMIT: 8, MAX_MARKETS: 150, marketLimit: 8, hasMoreMarkets: false, discoveryLimited: false, selectedPair: "", poolRef,
    visibleMarkets: () => context.markets, renderMarketRows: () => paints.push(context.markets.length), renderDiscoveryControls: () => {}, setCopy: () => {},
  };
  await runInNewContext(`${compileMain(["restoreCachedMarkets", "mapLimited"])}\nrestoreCachedMarkets()`, context);
  assert.deepEqual(paints, [24]); assert.equal(context.markets.length, 24); assert.equal(context.marketLimit, 24);
  assert.ok(context.markets.every((market: any) => market.stale));
  assert.ok(modes.every((options: any) => options.cachedOnly === true));
  context.linkedToken = address(1); paints.length = 0;
  await runInNewContext(`${compileMain(["restoreCachedMarkets", "mapLimited"])}\nrestoreCachedMarkets()`, context);
  assert.equal(paints.length, 0);
});

function refreshFixture(mode: "failed" | "partial" | "empty", previous = false) {
  const nodes = new Map<string, { textContent: string; disabled?: boolean }>();
  const byId = (id: string) => { if (!nodes.has(id)) nodes.set(id, { textContent: "" }); return nodes.get(id)!; };
  const notices: string[] = [];
  const renderedFailureStates: boolean[] = [];
  const script = compileMain(["loadMarkets", "loadDashboard", "mapLimited"]);
  const context: Record<string, any> = {
    copy, poolRef, rpcReader: null, localMarketMode: false, linkedSnapshotMode: false, loading: false, NETWORK: {}, routeError: "", linkedPool: null, linkedToken: null, marketLimit: 15,
    markets: previous ? [{ ...selected, stale: false }] : [], selectedPair: "", marketLoadFailed: previous,
    dexAdapters: [], selectDexAdapters, activeProtocol: "all", failedMarketCount: 0, hasMoreMarkets: false, discoveryLimited: false, detailRequest: 0, lastRefreshAt: 0, loadProgress: {},
    discoverDexPools: async () => ({ seeds: mode === "empty" ? [] : [selected, { ...selected, pairAddress: address(2) }], stale: false, hasMore: true, limited: false }),
    loadMarketPair: async (seed: typeof selected) => mode === "partial" && seed.pairAddress === selected.pairAddress ? { ...seed, stale: false } : null,
    visibleMarkets: () => context.markets, renderDiscoveryControls: () => {}, refreshRecorderOverview: async () => {}, flushTokenSearch: async () => {}, queueRememberedMarkets: () => {},
    renderMarketRows: () => renderedFailureStates.push(context.marketLoadFailed), checkWatchedPools: async () => {},
    loadDetail: async () => {}, setDetailState: () => {}, adPreview: { setContentAvailable: () => {} }, byId,
    localize: (node: { textContent: string }, message: string) => { node.textContent = message; },
    setCopy: (id: string, message: Parameters<typeof translate>[0] | string) => { byId(id).textContent = typeof message === "string" ? message : translate(message, "en"); },
    setNotice: (message?: Parameters<typeof translate>[0] | string) => notices.push(typeof message === "string" ? message : message ? translate(message, "en") : ""),
  };
  return { context, nodes, notices, renderedFailureStates, run: () => runInNewContext(`${script}\nloadDashboard(true)`, context) };
}

test("all pool loads failing is an error, preserving prior markets only as stale", async () => {
  for (const previous of [false, true]) {
    const fixture = refreshFixture("failed", previous);
    await fixture.run();
    assert.equal(fixture.context.marketLoadFailed, true);
    assert.equal(fixture.context.failedMarketCount, 2);
    assert.equal(fixture.context.markets.length, previous ? 1 : 0);
    if (previous) assert.equal(fixture.context.markets[0].stale, true);
    assert.match(fixture.notices.at(-1)!, /All discovered pools failed/);
    assert.equal(fixture.nodes.get("lastUpdated")!.textContent, "Connection unavailable");
    assert.equal(fixture.nodes.get("refreshButton")!.disabled, false);
  }
});

test("direct links render saved markets before RPC and never wait for optional detail enrichment", async () => {
  const fixture = refreshFixture("empty");
  const context = fixture.context;
  let details = 0;
  Object.assign(context, {
    linkedPool: selected.pairAddress, NETWORK: ARC_RADAR_MAINNET, URL,
    location: { href: "http://localhost:4173/public/arc-radar.html" }, localRecorderAvailable: () => true,
    rpcReader: { checkNetwork: () => { throw new Error("Cached link must not wait on RPC"); } },
    readMarketFeed: async () => ({ bundles: [{ seed: selected, fetchedAt: 123 }] }),
    linkedMarketBundles: (feed: { bundles: unknown[] }, link: { pool: string }) => { assert.equal(link.pool, selected.pairAddress); return feed.bundles; },
    loadMarketPair: async (_seed: unknown, force: boolean, options: { snapshot: { fetchedAt: number } }) => {
      assert.equal(force, false); assert.equal(options.snapshot.fetchedAt, 123); return { ...selected, stale: true };
    },
    tokenDirectory: null,
    loadDetail: () => { details++; return new Promise(() => {}); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fixture.run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Blocked on detail enrichment")), 500); })]);
    assert.equal(details, 1); assert.equal(context.marketLoadFailed, false); assert.equal(context.linkedSnapshotMode, true);
    assert.equal(context.markets.length, 1); assert.equal(context.markets[0].stale, true);
    assert.equal(fixture.nodes.get("refreshButton")!.disabled, false);
    assert.ok(fixture.notices.some(notice => notice.includes("Original data timestamps retained")));
  } finally { clearTimeout(timer); }
});

test("protocol changes restore previously loaded pools, preserve filters and guard in-flight changes", async () => {
  const nodes = new Map<string, any>();
  const context: Record<string, any> = {
    localMarketMode: false, loading: false, linkedPool: null, linkedToken: null, NETWORK: ARC_RADAR_MAINNET, routeError: "", activeProtocol: "all",
    dexAdapters: ARC_RADAR_MAINNET.sources.map(source => createDexAdapter(source, ARC_RADAR_MAINNET)), selectDexAdapters,
    MARKET_LIMIT: 8, marketLimit: 24, markets: [{ ...selected }], selectedPair: "old", hasMoreMarkets: true,
    discoveryLimited: true, failedMarketCount: 2, marketLoadFailed: true, detailRequest: 5, discoveryPages: new Map([["old", {}]]), refreshCursor: 12,
    activeQuery: "LONG", activeFilter: "watchlist", discoveryOptions: { sort: "volume", traded24h: true },
    setDetailState: () => {}, renderMarketRows: () => {}, copy,
    byId: (id: string) => { if (!nodes.has(id)) nodes.set(id, { textContent: "", replaceChildren() {} }); return nodes.get(id); },
    element: () => ({}), setCopy: () => {}, restoreCachedMarkets: async () => {},
    MAX_MARKETS: 150, protocolMarketCache: new Map(), poolRef, searchGeneration: 0, pendingTokenSearch: null,
    tokenSearchStates: new Map(), rememberedMarketsQueued: true, queueTokenSearch: () => {},
    applyFilter: () => {}, renderDiscoveryControls: () => {},
  };
  let reloads = 0;
  context.loadDashboard = async () => { reloads++; assert.equal(context.markets.length, 0); assert.equal(context.selectedPair, ""); };
  const script = compileMain(["applyProtocol"]);
  const apply = (value: string) => runInNewContext(`${script}\napplyProtocol(${JSON.stringify(value)})`, context);
  await apply("uniswap-v3");
  assert.equal(reloads, 1); assert.equal(context.activeProtocol, "uniswap-v3"); assert.equal(context.marketLimit, 8);
  assert.equal(context.activeQuery, "LONG"); assert.equal(context.activeFilter, "watchlist");
  assert.deepEqual(context.discoveryOptions, { sort: "volume", traded24h: true });
  assert.equal(context.failedMarketCount, 0); assert.equal(context.detailRequest, 6);
  assert.equal(nodes.get("pulseVolume").textContent, "--");
  context.loading = true; await apply("uniswap-v4"); assert.equal(reloads, 1);
  context.loading = false; context.linkedToken = selected.tokenAddress; await apply("uniswap-v4"); assert.equal(reloads, 1);
  context.linkedToken = null; await apply("invalid"); assert.equal(reloads, 1);
  await apply("all"); assert.equal(reloads, 2); assert.equal(context.activeProtocol, "all");
  const v3 = { ...selected, sourceId: ARC_RADAR_MAINNET.sources.find(source => source.protocol === "uniswap-v3")!.id };
  context.markets = [v3];
  context.loadDashboard = async () => { reloads++; };
  await apply("uniswap-v4");
  assert.equal(context.markets.length, 0, "v3 must not leak into v4");
  const beforeRestore = reloads;
  await apply("uniswap-v3");
  assert.equal(context.markets.length, 1, "searched old v3 pools survive switching back");
  assert.equal(context.markets[0], v3);
  assert.equal(context.rememberedMarketsQueued, false);
  await apply("all");
  assert.equal(context.markets.length, 1, "all restores the union without duplicate rows");
  assert.equal(reloads, beforeRestore, "known protocol views switch without network reloading");
});

test("protocol discovery receives only selected adapters, including when loading more", async () => {
  const fixture = refreshFixture("empty");
  fixture.context.dexAdapters = ARC_RADAR_MAINNET.sources.map(source => createDexAdapter(source, ARC_RADAR_MAINNET));
  fixture.context.activeProtocol = "uniswap-v3";
  fixture.context.marketLimit = 16;
  fixture.context.discoverDexPools = async (adapters: any[], limit: number) => {
    assert.deepEqual(adapters.map(a => a.source.protocol), ["uniswap-v3"]);
    assert.equal(limit, 16);
    return { seeds: [], stale: false, hasMore: false, limited: true };
  };
  await fixture.run();
  assert.equal(fixture.context.marketLoadFailed, false);
});

test("auto refresh waits after completion, backs off failures and never overlaps or runs hidden", () => {
  const context = { localMarketMode: false, rpcReader: {}, AUTO_REFRESH_MS: 60_000, marketLoadFailed: false, loading: false, document: { hidden: false }, lastRefreshAt: 90_000 };
  const due = (now: number) => runInNewContext(`${compileMain(["autoRefreshDue"])}\nautoRefreshDue(${now})`, context);
  assert.equal(due(120_000), false);
  assert.equal(due(209_999), false);
  assert.equal(due(210_000), true);
  context.loading = true; assert.equal(due(500_000), false);
  context.loading = false; context.document.hidden = true; assert.equal(due(500_000), false);
  context.document.hidden = false; context.marketLoadFailed = true;
  assert.equal(due(389_999), false); assert.equal(due(390_000), true);
});

test("discovery pagination pins its first snapshot, shares requests and retries failures", async () => {
  let calls = 0;
  const context = { discoveryPages: new Map(), fetchData: async (path: string) => {
    calls++;
    if (path === "failed" && calls === 3) throw new Error("offline");
    return { data: { items: [], next_page_params: { anchor: 100 - calls, before: 90 } }, stale: false };
  } };
  const script = compileMain(["readDiscoveryPage"]);
  const read = (path: string) => runInNewContext(`${script}\nreadDiscoveryPage(${JSON.stringify(path)})`, context);
  const first = await read("/factory/logs");
  assert.equal(await read("/factory/logs"), first); assert.equal(calls, 1);
  await read("/factory/logs?anchor=99&before=90"); assert.equal(calls, 2);
  await assert.rejects(read("failed"), /offline/);
  await read("failed"); assert.equal(calls, 4);
  context.discoveryPages.clear();
  assert.notEqual(await read("/factory/logs"), first); assert.equal(calls, 5);
});

function rpcListFixture() {
  const seeds = Array.from({ length: 24 }, (_, i) => ({ ...selected, pairAddress: address(i + 100), tokenAddress: address(i + 200) }));
  const attempts: string[] = [], progress: number[] = [];
  let discoveries = 0;
  const context: Record<string, any> = {
    markets: [], selectedPair: "", refreshCursor: 0, MARKET_LIMIT: 8, MAX_MARKETS: 150, marketLimit: 8,
    activeProtocol: "all", dexAdapters: [], selectDexAdapters, readDiscoveryPage: () => {},
    discoveryPages: new Map(), hasMoreMarkets: false, discoveryLimited: false, loadProgress: {}, failedMarketCount: 0,
    poolRef, renderDiscoveryControls: () => {}, renderMarketRows: () => progress.push(context.markets.length),
    loadDetail: async () => {}, visibleMarkets: () => context.markets, setDetailState: () => {}, detailRequest: 0,
    discoverDexPools: async (_: unknown, limit: number) => { discoveries++; return { seeds: seeds.slice(0, limit), hasMore: limit < seeds.length, limited: false, stale: false }; },
    loadMarketPair: async (seed: typeof selected, _force: boolean, options: { quick: boolean }) => { assert.equal(options.quick, true); attempts.push(poolRef(seed)); return { ...seed, stale: false }; },
  };
  const script = compileMain(["loadRpcMarkets", "nextRefreshSeeds", "mapLimited"]);
  return { context, attempts, progress, discoveries: () => discoveries,
    run: (force = false, extend = false) => runInNewContext(`${script}\nloadRpcMarkets(${force}, ${extend})`, context) };
}

test("mainnet streams eight results, appends only new pools and retains the previous list", async () => {
  const fixture = rpcListFixture();
  assert.equal(await fixture.run(), false);
  assert.equal(fixture.context.markets.length, 8);
  assert.ok(fixture.progress.includes(1)); assert.ok(fixture.progress.includes(7));
  assert.equal(fixture.context.loadProgress.completed, 8);
  const original = fixture.context.markets.map(poolRef);
  fixture.context.marketLimit = 16;
  fixture.attempts.length = 0;
  assert.equal(await fixture.run(false, true), false);
  assert.equal(fixture.context.markets.length, 16); assert.equal(fixture.attempts.length, 8);
  assert.ok(fixture.attempts.every(id => !original.includes(id)));
  assert.deepEqual(fixture.context.markets.slice(0, 8).map(poolRef), original);
  assert.equal(fixture.context.selectedPair, "", "list loading does not auto-select a token");
  fixture.context.selectedPair = original[0];
  fixture.attempts.length = 0;
  await fixture.run();
  assert.equal(fixture.discoveries(), 2, "auto refresh must not restart discovery");
  assert.equal(fixture.attempts.length, 8); assert.equal(fixture.context.markets.length, 16);
  assert.ok(fixture.attempts.includes(fixture.context.selectedPair));
  const updated = new Set(fixture.attempts);
  fixture.attempts.length = 0; await fixture.run();
  assert.ok(fixture.attempts.some(id => !updated.has(id)), "nonselected pools rotate through bounded batches");
});

test("failed mainnet updates retain rows as cached and release progress with an error", async () => {
  const fixture = rpcListFixture();
  await fixture.run();
  fixture.context.loadMarketPair = async () => null;
  await assert.rejects(fixture.run(), /All discovered pools failed/);
  assert.equal(fixture.context.markets.length, 8);
  assert.ok(fixture.context.markets.every((market: any) => market.stale));
  assert.equal(fixture.context.loadProgress.completed, 8);
  assert.equal(fixture.context.failedMarketCount, 8);
});

test("manual mainnet discovery adds recent pools without evicting earlier rows", async () => {
  const fixture = rpcListFixture();
  await fixture.run();
  const previous = fixture.context.markets.map(poolRef);
  fixture.context.discoveryPages.set("old-snapshot", Promise.resolve({}));
  fixture.context.discoverDexPools = async () => ({ seeds: [{ ...selected, pairAddress: address(999) }], hasMore: true, limited: false, stale: false });
  await fixture.run(true);
  assert.equal(fixture.context.discoveryPages.size, 0);
  assert.equal(fixture.context.markets.length, 9);
  assert.deepEqual(fixture.context.markets.slice(0, 8).map(poolRef), previous);
  assert.equal(fixture.context.markets.at(-1).pairAddress, address(999));
});

test("partial loading is labeled partial, and a genuine empty recovery clears the failure view", async () => {
  const partial = refreshFixture("partial");
  await partial.run();
  assert.equal(partial.context.marketLoadFailed, false);
  assert.equal(partial.context.markets.length, 1);
  assert.match(partial.nodes.get("lastUpdated")!.textContent, /^Partial update /);
  assert.match(partial.notices.at(-1)!, /Pool loads failed: 1/);
  const empty = refreshFixture("empty", true);
  await empty.run();
  assert.equal(empty.context.marketLoadFailed, false);
  assert.equal(empty.context.markets.length, 0);
  assert.deepEqual(empty.renderedFailureStates, [false]);
  assert.match(empty.nodes.get("lastUpdated")!.textContent, /^Checked /);
});

test("unavailable initial market data renders unknown activity, not zero volume", () => {
  const nodes = new Map<string, { textContent: string }>();
  const byId = (id: string) => { if (!nodes.has(id)) nodes.set(id, { textContent: "" }); return nodes.get(id)!; };
  runInNewContext(`${compileMain(["renderMarketSummary", "renderMarketPulse"])}\nrenderMarketSummary(); renderMarketPulse();`, {
    marketLoadFailed: true, markets: [], byId, groupTokenPools, copy,
    marketCandidates: () => [], visibleMarkets: () => [], discoveryOptions: { minimumFdv: 0, minimumLiquidity: 0 },
    setCopy: (id: string, value: Parameters<typeof translate>[0] | string) => { byId(id).textContent = typeof value === "string" ? value : translate(value, "en"); },
  });
  assert.equal(byId("pulseVolume").textContent, "--");
  assert.equal(byId("pulseTrades").textContent, "--");
  assert.match(byId("pulseStatus").textContent, /unknown/);
  assert.match(byId("marketSummary").textContent, /unknown/);
});

test("liquidity UI totals all fetched in-window events while rendering only eight rows", () => {
  const now = Date.now();
  const events = Array.from({ length: 13 }, (_, index) => ({ timestamp: new Date(now - (index + 1) * 60_000).toISOString(),
    direction: index === 12 ? "remove" : "add", usdcAmount: 1, tokenAmount: 1, changePercent: 10, transactionHash: `0x${index}`, fallbackAddress: null }));
  events.push({ ...events[0]!, timestamp: new Date(now - 2 * 86_400_000).toISOString(), usdcAmount: 100 },
    { ...events[0]!, timestamp: new Date(now + 86_400_000).toISOString(), usdcAmount: 100 });
  const nodes = new Map<string, any>();
  const element = () => ({ textContent: "", children: [] as unknown[], append(...children: unknown[]) { this.children.push(...children); }, replaceChildren() { this.children = []; } });
  const byId = (id: string) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  runInNewContext(`${compileMain(["renderLiquidityMonitor"])}\nrenderLiquidityMonitor(market, detail);`, {
    market: { liquidityEvents: events, token: { symbol: "Price" }, usdcReserve: 9, historyTruncated: false },
    detail: { lpBurnedShare: null, lpTopHolderShare: null, sources: { lp: "unavailable" }, transactionSenders: {} },
    DAY_MS: 86_400_000, copy, byId, element, EXPLORER_BASE: "https://example.invalid", relativeTime: () => "1m", shortHash: (value: string) => value,
    formatValue: String, shareText: () => "--", setCopy: (id: string, value: Parameters<typeof translate>[0]) => { byId(id).textContent = translate(value, "en"); },
  });
  assert.equal(byId("liquidityAdded").textContent, "12");
  assert.equal(byId("liquidityRemoved").textContent, "1");
  assert.equal(byId("liquidityEventList").children.length, 8);
  assert.match(byId("liquidityHistoryNote").textContent, /Showing 8 of 15/);
});
const detailFunctions = new Set(["fetchOptional", "fetchTokenTransfers", "mapLimited", "fetchMarketDetail", "mergeContracts", "contractFunctions", "buildWarnings", "classifyWalletSignals", "analyzeHolderConnections"]);
const detailProgram = mainSource.statements.filter(node => ts.isFunctionDeclaration(node) && detailFunctions.has(node.name?.text ?? ""))
  .map(node => node.getText(mainSource)).join("\n");
const fixtureMarket = { ...selected, token: { total_supply: "1000", decimals: "0" }, creationTx: "0xcreation", createdAt: "2026-09-01T00:00:00Z", trades: [], liquidityEvents: [],
  sellCount: 0, totalLiquidity: 100, usdcReserve: 50, reserveSource: "sync", periods: { h24: { priceChange: null } } };
function detailFixture(mode: "failed" | "cached" | "fresh") {
  const fetchData = async (path: string) => {
    if (mode === "failed") throw new Error("fixture: HTTP 503");
    const stale = mode === "cached";
    if (path.endsWith("/holders")) return { data: { items: [holder(1, "300"), holder(2, "200"), holder(3, "500")] }, stale };
    if (path.endsWith("/transfers")) return { data: { items: [
      { type: "token_transfer", from: { hash: address(2) }, to: { hash: address(1) }, total: { value: "50", decimals: "0" }, timestamp: "2026-09-09T00:00:00Z", transaction_hash: "0xpooltopool" },
      { type: "token_transfer", from: { hash: address(4) }, to: { hash: address(1) }, total: { value: "50", decimals: "0" }, timestamp: "2026-09-09T00:01:00Z", transaction_hash: "0xtopool" },
    ] }, stale };
    if (path.startsWith("/transactions/")) return { data: { from: { hash: address(3) } }, stale };
    if (path.startsWith("/addresses/")) return { data: { is_verified: true }, stale };
    if (path.startsWith("/smart-contracts/")) return { data: { abi: [{ type: "function", name: "mint", stateMutability: "nonpayable" }] }, stale };
    return { data: { total_supply: "1000" }, stale };
  };
  const script = ts.transpileModule(detailProgram, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(`${script}\nfetchMarketDetail(fixtureMarket, true).then(detail => ({...detail, warnings: buildWarnings(fixtureMarket, detail)}))`, {
    fetchData, fixtureMarket, copy, markets: [fixtureMarket, { ...fixtureMarket, pairAddress: address(2) }],
    holderMetrics, holderShare, knownTokenPools, sourceState, decimalValue, detectCapabilities, capabilityText, URLSearchParams,
    formatValue: (value: number) => String(value), relativeTime: () => "1m",
    TRANSFER_PAGE_LIMIT: 3, BURN_ADDRESSES: new Set([address(0), "0x000000000000000000000000000000000000dead"]),
  });
}

test("detail API failures retain unavailable provenance through the real fetch pipeline", async () => {
  const detail = await detailFixture("failed");
  assert.equal(detail.top10Share, null);
  assert.equal(detail.lpBurnedShare, null);
  assert.equal(detail.creatorShare, null);
  assert.equal(detail.sources.holders, "unavailable");
  assert.equal(detail.sources.transfers, "unavailable");
  assert.equal(detail.walletSignals.length, 0);
});

test("real detail pipeline retains cached source states instead of fresh ownership", async () => {
  const detail = await detailFixture("cached");
  for (const source of ["holders", "lp", "contract", "creator", "transfers"]) assert.equal(detail.sources[source], "cached");
  assert.equal(detail.top10Share, 50);
});

test("real wallet classification excludes pool-to-pool movements and never infers full exit", async () => {
  const detail = await detailFixture("fresh");
  assert.equal(detail.holderPositions.length, 1);
  assert.equal(detail.holderPositions[0].address, address(3));
  assert.equal(detail.walletSignals.length, 1);
  assert.equal(detail.walletSignals[0].title, "Wallet sent to pool");
  assert.equal(detail.holderConnections.length, 0);
});

test("real detail warnings never promote a matching mint ABI into verified supply permission", async () => {
  const detail = await detailFixture("fresh");
  const mint = detail.warnings.find((warning: { title: string }) => warning.title === "Supply-related function names");
  assert.equal(mint.basis, "unverified");
  assert.match(translate(mint.detail, "en"), /ABI: mint/);
  assert.match(translate(mint.detail, "ko"), /실행 가능하다는 뜻은 아닙니다/);
  assert.ok(detail.warnings.every((warning: { basis?: string }) => ["observed", "estimate", "unverified"].includes(warning.basis ?? "")));
  assert.ok(detail.warnings.some((warning: { title: string; detail: string }) => warning.title === "Execution paths not verified"
    && warning.detail.includes("No sell simulation or full permission audit")));
});

test("real watch scheduler bounds failed reads, cools down retries, and pauses when hidden", async () => {
  const node = mainSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "checkWatchedPools")!;
  const script = ts.transpileModule(node.getText(mainSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pools = Array.from({ length: 5 }, (_, index) => ({ ...fixtureMarket, pairAddress: address(index + 20), stale: false }));
  const attempted: string[] = [];
  let observations = 0;
  const context = {
    document: { hidden: false }, linkedPool: null, marketLoadFailed: false, watchScanRunning: false, lastWatchScanAt: 0,
    AUTO_REFRESH_MS: 60_000, DETAIL_CACHE_TTL_MS: 120_000, nextWatchBatch, markets: pools,
    watchlist: new Set([fixtureMarket.tokenAddress.toLowerCase()]), watchCheckAttempts: new Map(), detailCache: new Map(),
    poolCacheKey: (pool: typeof fixtureMarket) => pool.pairAddress, renderWatchDigest: () => {},
    getMarketDetail: async (pool: typeof fixtureMarket) => { attempted.push(pool.pairAddress); throw new Error("HTTP 503"); },
    observeDetailChanges: () => { observations++; },
  };
  await runInNewContext(`${script}\ncheckWatchedPools().then(() => checkWatchedPools())`, context);
  assert.equal(attempted.length, 3);
  assert.equal(observations, 0);
  assert.equal(context.watchScanRunning, false);
  assert.equal(context.watchCheckAttempts.size, 3);
  context.document.hidden = true;
  context.lastWatchScanAt = 0;
  await runInNewContext(`${script}\ncheckWatchedPools()`, context);
  assert.equal(attempted.length, 3);
});

test("detail panel and watch scan share a concurrent request for the same pool scope", async () => {
  const node = mainSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getMarketDetail")!;
  const script = ts.transpileModule(node.getText(mainSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let requests = 0;
  const context = {
    fixtureMarket, markets: [fixtureMarket], knownTokenPools, DETAIL_CACHE_TTL_MS: 120_000,
    poolCacheKey: (pool: typeof fixtureMarket) => pool.pairAddress, detailCache: new Map(), detailFlights: new Map(),
    fetchMarketDetail: async () => { requests++; return { checkedAt: Date.now(), poolScope: fixtureMarket.pairAddress }; },
  };
  await runInNewContext(`${script}\nPromise.all([getMarketDetail(fixtureMarket, false), getMarketDetail(fixtureMarket, false)])`, context);
  assert.equal(requests, 1);
  assert.equal(context.detailCache.size, 1);
  assert.equal(context.detailFlights.size, 0);
});

test("analysis keeps the prior holder snapshot before the detail cache is replaced", async () => {
  const previous = { checkedAt: Date.now() - 60_000, poolScope: selected.pairAddress, top10Share: 30,
    sources: { holders: "fresh" }, holderHistoryPartial: false };
  const current = { ...previous, checkedAt: Date.now(), top10Share: 40 };
  const context = { fixtureMarket, markets: [fixtureMarket], knownTokenPools, DETAIL_CACHE_TTL_MS: 120_000,
    poolCacheKey: () => "selected", detailCache: new Map([["selected", { data: previous, savedAt: previous.checkedAt }]]), detailFlights: new Map(),
    fetchMarketDetail: async () => current };
  const result = await runInNewContext(`${compileMain(["getMarketDetail"])}\ngetMarketDetail(fixtureMarket, true)`, context);
  assert.equal(result.analysisPrevious.top10Share, 30);
  assert.equal(result.analysisPrevious.checkedAt, previous.checkedAt);
  assert.equal(result.top10Share, 40);
  assert.equal(context.detailCache.get("selected")!.data.top10Share, 40);
  assert.equal(previous.top10Share, 30);
  assert.equal("analysisPrevious" in result.analysisPrevious, false);
});

test("manual state reads cool down, clear failed retries, and cannot overwrite another token", async () => {
  const node = mainSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "readSelectedAuthority")!;
  const script = ts.transpileModule(node.getText(mainSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const other = { ...fixtureMarket, pairAddress: address(51), tokenAddress: address(52) };
  let finish!: (value: unknown) => void;
  let requests = 0;
  const rendered: string[] = [];
  const entries = new Map<string, { attemptedAt: number; snapshot?: unknown; error?: string }>();
  const context = { poolRef, markets: [fixtureMarket, other], selectedPair: fixtureMarket.pairAddress.toLowerCase(), NETWORK: {},
    authorityRunning: "", authorityReads: entries, window: { setTimeout: () => {} },
    renderAuthority: (market: typeof fixtureMarket) => rendered.push(market.tokenAddress),
    readAuthoritySnapshot: async () => { requests++; return new Promise(resolve => { finish = resolve; }); },
  };
  const pending = runInNewContext(`${script}\nreadSelectedAuthority()`, context);
  await runInNewContext(`${script}\nreadSelectedAuthority()`, context);
  assert.equal(requests, 1);
  context.selectedPair = other.pairAddress;
  finish({ marker: "original token" });
  await pending;
  assert.equal(rendered.at(-1), other.tokenAddress);
  const key = `${fixtureMarket.chainId}:${fixtureMarket.tokenAddress.toLowerCase()}`;
  assert.deepEqual(entries.get(key)?.snapshot, { marker: "original token" });
  assert.equal(entries.has(`${other.chainId}:${other.tokenAddress}`), false);
  context.selectedPair = fixtureMarket.pairAddress;
  await runInNewContext(`${script}\nreadSelectedAuthority()`, context);
  assert.equal(requests, 1);
  entries.get(key)!.attemptedAt = Date.now() - 61_000;
  context.readAuthoritySnapshot = async () => { requests++; throw new Error("RPC unavailable"); };
  await runInNewContext(`${script}\nreadSelectedAuthority()`, context);
  assert.equal(entries.get(key)?.snapshot, undefined);
  assert.ok(entries.get(key)?.error);
  await runInNewContext(`${script}\nreadSelectedAuthority()`, context);
  assert.equal(requests, 2);
});
