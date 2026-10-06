import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Hex } from "viem";
import { ARC_RADAR_TESTNET, resolveRadarNetwork } from "../src/arc-radar-networks.js";
import { VENUE_REFERENCES, configuredVenue } from "../src/arc-radar-sources.js";
import { localRecorderAvailable, parseRecorderSnapshot } from "../src/arc-radar-recorder.js";
import { CollectorStore, COLLECTOR_LIMITS } from "../scripts/radar-collector-store.js";
import { RadarCollector, type CollectorTransport } from "../scripts/radar-collector.js";
import { collectorPage, collectDecoded, logKey, validateCursor, V2_COLLECTOR_EVENTS, type CollectorLog } from "../scripts/radar-collector-codec.js";
import { validateCollectorRequest } from "../scripts/radar-collector-api.js";
import * as v4 from "./fixtures/arc-radar-v4.js";

const network = ARC_RADAR_TESTNET, source = network.sources[0]!;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
function creation(n: number, block = n): CollectorLog {
  return { address: { hash: source.factoryAddress }, block_number: block, block_hash: hash(10_000 + block), block_timestamp: new Date(Date.now() - 100_000 + block).toISOString(),
    transaction_hash: hash(n), index: 1,
    topics: encodeEventTopics({ abi: V2_COLLECTOR_EVENTS, eventName: "PairCreated", args: { token0: network.quoteAsset.address as Hex, token1: address(1000 + n) } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("address, uint256"), [address(n), BigInt(n)]) };
}
const page = (items: CollectorLog[], next: number | null = null) => ({ items, next_page_params: next === null ? null : { block_number: next, index: 1, items_count: 50 } });
function fixture(transport?: CollectorTransport) {
  const store = new CollectorStore(network, ":memory:");
  const collector = new RadarCollector(store, transport ?? { chainId: async () => network.chainId, get: async () => page([creation(1)]) }, "test");
  store.acquire("test", Date.now());
  return { store, collector };
}

test("venue announcements cannot authorize collection or substitute deployments", () => {
  assert.equal(VENUE_REFERENCES.filter(v => v.status === "announced").length, 1);
  assert.ok(configuredVenue(network, source.id));
  assert.equal(configuredVenue(network, "parabola-arc"), undefined);
  assert.equal(configuredVenue({ ...network, sources: [{ ...source, factoryAddress: address(123) }] }, source.id), undefined);
  const mainnet = resolveRadarNetwork("arc-mainnet");
  assert.ok(configuredVenue(mainnet, mainnet.sources[0]!.id));
  const mainnetStore = new CollectorStore(mainnet, ":memory:");
  try { assert.throws(() => new RadarCollector(mainnetStore, {} as CollectorTransport, "test"), /background recorder/); }
  finally { mainnetStore.close(); }
  for (const venue of VENUE_REFERENCES) { const url = new URL(venue.url); assert.equal(url.protocol, "https:"); assert.equal(url.username, ""); }
});

test("raw event decoding ignores forged explorer labels and keeps exact USDC values", () => {
  const log = creation(1); log.decoded = { method_call: "Swap(...)" };
  const parsed = collectDecoded(network, source, [log], [], Date.now());
  assert.equal(parsed.discovered.length, 1); assert.equal(parsed.events[0].kind, "pool-created");
  const pool = parsed.discovered[0];
  const swap: CollectorLog = { ...creation(2), address: { hash: pool.pairAddress }, topics: encodeEventTopics({ abi: V2_COLLECTOR_EVENTS, eventName: "Swap", args: { sender: address(88), to: address(89) } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("uint256,uint256,uint256,uint256"), [123456789123456789n, 0n, 0n, 1n]) };
  const events = collectDecoded(network, source, [swap], [pool], Date.now()).events;
  assert.equal(events[0].kind, "buy"); assert.equal(events[0].amount, "123456789123.456789");
  assert.throws(() => collectDecoded(network, source, [{ ...swap, data: "0x" }], [pool], Date.now()));
});

test("two pool creations in one transaction remain assigned to their own log", () => {
  const a = creation(1), b = { ...creation(2), transaction_hash: a.transaction_hash, index: 2 };
  const result = collectDecoded(network, source, [a, b], [], Date.now());
  assert.equal(result.events.length, 2); assert.equal(result.events[0].pool, address(1)); assert.equal(result.events[1].pool, address(2));
});

test("invalid emitters, hashes, timestamps, ordering and pagination fail closed", () => {
  const log = creation(1);
  for (const bad of [{ ...log, address: { hash: address(4) } }, { ...log, block_hash: "bad" }, { ...log, index: -1 }, { ...log, block_timestamp: new Date(Date.now() + 10000).toISOString() }]) {
    assert.throws(() => collectorPage(page([bad]), source.factoryAddress));
  }
  assert.throws(() => collectorPage(page([creation(1), creation(2)]), source.factoryAddress), /Unordered/);
  assert.throws(() => validateCursor({ url: "https://evil.invalid" }), /Invalid/);
  assert.throws(() => collectorPage({ error: "429" }, source.factoryAddress), /Invalid/);
  assert.equal(collectorPage(page([log, log]), source.factoryAddress).items.length, 1);
});

test("bootstrap is explicitly partial and duplicate refreshes do not rewrite event observation time", async () => {
  const log = creation(1);
  const { store, collector } = fixture({ chainId: async () => network.chainId, get: async () => page([log], 100) });
  try {
    await collector.collectStream(store.streams()[0], AbortSignal.timeout(5000));
    const initial = store.snapshot(); assert.equal(initial.eventCount, 1); assert.equal(initial.streams.find(s => s.pool === null)!.bootstrapPartial, true);
    await collector.collectStream(store.stream("source:" + source.id), AbortSignal.timeout(5000));
    assert.equal(store.snapshot().eventCount, 1); assert.equal(store.snapshot().events[0].observedAt, initial.events[0].observedAt);
  } finally { store.close(); }
});

test("bounded catch-up commits cursor and data together and resumes after database reopen", async () => {
  mkdirSync("artifacts", { recursive: true }); const dir = mkdtempSync(path.resolve("artifacts", "recorder-test-")); const file = path.join(dir, "test.sqlite");
  const old = creation(1), b = creation(2), c = creation(3), newest = creation(4);
  let count = 0;
  const transport: CollectorTransport = { chainId: async () => network.chainId, get: async url => {
    count++; if (count === 1) return page([old]); if (count === 2) return page([newest, c], 3); if (count === 3) return page([b], 2);
    assert.match(url, /block_number=2/); return page([old]);
  } };
  let store = new CollectorStore(network, file); let collector = new RadarCollector(store, transport, "owner"); store.acquire("owner", Date.now());
  await collector.collectStream(store.streams()[0], AbortSignal.timeout(5000));
  await collector.collectStream(store.stream("source:" + source.id), AbortSignal.timeout(5000));
  assert.ok(store.stream("source:" + source.id).state.cursor); assert.equal(store.stream("source:" + source.id).state.anchor, logKey(old));
  store.release("owner"); store.close();
  store = new CollectorStore(network, file); collector = new RadarCollector(store, transport, "resumed"); store.acquire("resumed", Date.now());
  try {
    await collector.collectStream(store.stream("source:" + source.id), AbortSignal.timeout(5000));
    assert.equal(store.stream("source:" + source.id).state.anchor, logKey(newest)); assert.equal(store.stream("source:" + source.id).state.cursor, null);
    assert.equal(store.snapshot().eventCount, 4);
  } finally { store.release("resumed"); store.close(); }
});

test("page failure and repeated cursor cannot move the previous committed checkpoint", async () => {
  const old = creation(1); let response: unknown = page([old]);
  const { store, collector } = fixture({ chainId: async () => network.chainId, get: async () => response });
  try {
    await collector.collectStream(store.streams()[0], AbortSignal.timeout(5000));
    const original = store.stream("source:" + source.id).state.anchor;
    response = { items: [{ ...creation(2), block_hash: "bad" }] };
    await assert.rejects(collector.collectStream(store.stream("source:" + source.id), AbortSignal.timeout(5000)));
    assert.equal(store.stream("source:" + source.id).state.anchor, original); assert.equal(store.snapshot().eventCount, 1);
    response = page([creation(3)], 30);
    await assert.rejects(collector.collectStream(store.stream("source:" + source.id), AbortSignal.timeout(5000)), /repeated/);
    assert.equal(store.stream("source:" + source.id).state.anchor, original); assert.equal(store.snapshot().eventCount, 2);
    assert.ok(store.stream("source:" + source.id).state.cursor);
  } finally { store.close(); }
});

test("changed stored event rolls back the entire page rather than quietly rewriting history", () => {
  const { store } = fixture();
  try {
    const a = collectDecoded(network, source, [creation(1)], [], Date.now());
    store.transaction(() => { store.insertPools(a.discovered); store.insertEvents(a.events); });
    const b = collectDecoded(network, source, [creation(2)], [], Date.now());
    assert.throws(() => store.transaction(() => { store.insertPools(b.discovered); store.insertEvents(b.events); store.insertEvents([{ ...a.events[0], blockHash: hash(999) }]); }), /conflict/);
    assert.equal(store.pools().length, 1); assert.equal(store.snapshot().eventCount, 1);
  } finally { store.close(); }
});

test("missing old anchor records a coverage gap", async () => {
  let data = page([creation(1)]);
  const { store, collector } = fixture({ chainId: async () => network.chainId, get: async () => data });
  try { await collector.collectStream(store.streams()[0], AbortSignal.timeout(5000)); data = page([creation(2)]);
    await collector.collectStream(store.stream("source:" + source.id), AbortSignal.timeout(5000)); assert.equal(store.stream("source:" + source.id).state.gaps, 1);
  } finally { store.close(); }
});

test("wrong RPC chain and competing writer fail before log collection", async () => {
  let calls = 0;
  const { store, collector } = fixture({ chainId: async () => 1, get: async () => { calls++; return page([]); } });
  try { await assert.rejects(collector.cycle(), /chain ID mismatch/); assert.equal(calls, 0);
    assert.throws(() => store.acquire("other", Date.now()), /already holds/);
  } finally { store.close(); }
});

test("storage is network-bound, capacity limited and failed streams cool down", async () => {
  const { store, collector } = fixture({ chainId: async () => network.chainId, get: async () => { throw new Error("Public data HTTP 503"); } });
  try {
    await collector.cycle(); const stream = store.streams()[0]; assert.match(stream.state.error!, /503/); assert.ok(stream.state.retryAt > Date.now());
    const data = collectDecoded(network, source, Array.from({ length: COLLECTOR_LIMITS.pools + 1 }, (_, i) => creation(i + 1)), [], Date.now());
    store.insertPools(data.discovered); assert.equal(store.pools().length, COLLECTOR_LIMITS.pools); assert.equal(store.snapshot().poolLimitReached, true);
  } finally { store.close(); }
});

test("read-only endpoint rejects foreign origins, mutations, arbitrary paths and mainnet", () => {
  const request = { method: "GET", url: "/api/arcrow/collector?network=arc-testnet", headers: { host: "localhost:4173" } };
  assert.equal(validateCollectorRequest(request, 4173).network.id, "arc-testnet");
  for (const bad of [{ ...request, method: "POST" }, { ...request, headers: { host: "evil.invalid" } }, { ...request, headers: { host: "localhost:4173", origin: "https://evil.invalid" } }, { ...request, headers: { host: "localhost:4173", "sec-fetch-site": "cross-site" } }, { ...request, url: request.url + "&pool=../../.env" }, { ...request, url: request.url + "&network=arc-testnet" }, { ...request, url: "/api/arcrow/collector?network=arc-mainnet" }]) assert.throws(() => validateCollectorRequest(bad, 4173));
  assert.equal(localRecorderAvailable(new URL("https://arc-hackathon-export.vercel.app")), false);
  assert.equal(localRecorderAvailable(new URL("http://localhost.evil.invalid")), false);
});

test("browser validates chain, data age, pool scope and event links", () => {
  const { store } = fixture();
  try {
    const decoded = collectDecoded(network, source, [creation(1)], [], Date.now()); store.insertPools(decoded.discovered); store.insertEvents(decoded.events);
    const data = store.snapshot(address(1)); assert.equal(parseRecorderSnapshot(data, network, address(1)).events.length, 1);
    for (const bad of [{ ...data, chainId: 1 }, { ...data, generatedAt: Date.now() - 60_000 }, { ...data, events: [{ ...data.events[0], hash: "javascript:alert(1)" }] }]) assert.throws(() => parseRecorderSnapshot(bad, network, address(1)));
    assert.throws(() => parseRecorderSnapshot(data, network, address(2)));
  } finally { store.close(); }
});

test("v4 singleton raw events preserve pool IDs without creating shared-balance liquidity", () => {
  const a = v4.initialize(), b = v4.initialize({ fee: 500, index: 2 });
  const logs = [a, b].map(log => ({ ...log, block_hash: hash(log.block_number), block_timestamp: new Date(Date.now() - 10000).toISOString() })) as CollectorLog[];
  const result = collectDecoded(network, v4.source, logs, [], Date.now());
  assert.equal(result.discovered.length, 2); assert.equal(result.events.length, 2);
  assert.notEqual(result.events[0].pool, result.events[1].pool); assert.ok(result.events.every(e => e.amount === null));
});
