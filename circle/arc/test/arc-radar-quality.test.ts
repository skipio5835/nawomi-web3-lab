import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { decimalValue } from "../src/arc-radar-core.js";
import { capabilityText, detectCapabilities, nextWatchBatch } from "../src/arc-radar-evidence.js";
import { holderMetrics, holderShare, knownTokenPools, nextOwnershipSnapshot, sourceState, tradeActor, windowPriceChange } from "../src/arc-radar-quality.js";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;
const holder = (id: number, value: string) => ({ address: { hash: address(id) }, value });
const selected = { chainId: 5042002, tokenAddress: address(10), pairAddress: address(1) };

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
    fetchData, fixtureMarket, markets: [fixtureMarket, { ...fixtureMarket, pairAddress: address(2) }],
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
  assert.match(mint.detail, /ABI: mint/);
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

test("manual state reads cool down, clear failed retries, and cannot overwrite another token", async () => {
  const node = mainSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "readSelectedAuthority")!;
  const script = ts.transpileModule(node.getText(mainSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const other = { ...fixtureMarket, pairAddress: address(51), tokenAddress: address(52) };
  let finish!: (value: unknown) => void;
  let requests = 0;
  const rendered: string[] = [];
  const entries = new Map<string, { attemptedAt: number; snapshot?: unknown; error?: string }>();
  const context = { markets: [fixtureMarket, other], selectedPair: fixtureMarket.pairAddress.toLowerCase(), NETWORK: {},
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
