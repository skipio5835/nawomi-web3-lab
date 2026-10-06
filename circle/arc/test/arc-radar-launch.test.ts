import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { ARC_RADAR_MAINNET as network, ARC_RADAR_TESTNET } from "../src/arc-radar-networks.js";
import { LAUNCH_ABI, LAUNCH_TOPIC, LAUNCH_PLATFORMS, LAUNCH_LOOKBACK_BLOCKS, LaunchOriginReader, verifyLaunchReceipt } from "../src/arc-radar-launch.js";
import { V3_EVENTS, createV3Adapter } from "../src/arc-radar-v3.js";
import { RpcMarketReader } from "../src/arc-radar-rpc.js";

const token = "0x2100000000000000000000000000000000000000", creator = "0x9900000000000000000000000000000000000000";
const pool = "0x7400000000000000000000000000000000000000", pad = LAUNCH_PLATFORMS[0];
const source = network.sources.find(s => s.protocol === "uniswap-v3")!;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const hex = (n: number) => `0x${n.toString(16)}`;
const canonical = { number: 21_139_739, hash: hash(8), timestamp: Date.now() - 10_000 };
function fixture() {
  const common = { transactionHash: hash(1), blockHash: canonical.hash, blockNumber: hex(canonical.number), removed: false };
  const launch = { ...common, address: pad.emitter as string, logIndex: "0x2",
    topics: encodeEventTopics({ abi: LAUNCH_ABI, args: { token, creator } }) as Hex[],
    data: encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "address" }, ...Array.from({ length: 4 }, () => ({ type: "string" } as const))],
      ["<img src=x onerror=alert(1)>", "ArcPad", pool, "https://untrusted.invalid/image", "javascript:alert(1)", "", ""]) };
  const factory = { ...common, address: source.factoryAddress, logIndex: "0x1",
    topics: encodeEventTopics({ abi: V3_EVENTS, eventName: "PoolCreated", args: { token0: token, token1: network.quoteAsset.address as Hex, fee: 10000 } }) as Hex[],
    data: encodeAbiParameters([{ type: "int24" }, { type: "address" }], [200, pool]) };
  const receipt = { ...common, status: "0x1", logs: [factory, launch] };
  const seed = createV3Adapter(source, network).pairSeeds({ items: [{ address: { hash: factory.address }, topics: factory.topics, data: factory.data,
    transaction_hash: hash(1), block_number: canonical.number, index: 1, block_timestamp: new Date(canonical.timestamp).toISOString() }] })[0]!;
  let now = Date.now();
  const calls: Array<{ method: string; value?: any }> = [];
  const head = { ...canonical, number: canonical.number + 10, timestamp: canonical.timestamp + 1000 };
  const transport = {
    head: async () => { calls.push({ method: "head" }); return head; },
    block: async (number: number) => { calls.push({ method: "block", value: number }); return canonical; },
    receipt: async (tx: string): Promise<unknown> => { calls.push({ method: "receipt", value: tx }); return receipt; },
    logs: async (filter: any): Promise<unknown> => { calls.push({ method: "logs", value: filter }); return [launch]; },
  };
  return { seed, launch, factory, receipt, head, transport, calls, advance: (ms: number) => { now += ms; },
    reader: new LaunchOriginReader(network, transport, () => now) };
}

test("ArcPad evidence uses the observed 9-argument event and an independent V3 creation log", () => {
  assert.equal(LAUNCH_TOPIC, "0x875522b092d9e19a1de359e4bd218090d582fa521c9733889acf1a5ff1941255");
  const f = fixture(), result = verifyLaunchReceipt(network, token, hash(1), f.receipt, canonical)!;
  assert.equal(result.platform.name, "ArcPad"); assert.equal(result.creator, creator); assert.equal(result.pool, pool);
  assert.equal(result.transactionHash, hash(1)); assert.equal(result.token, token);
  assert.equal(JSON.stringify(result).includes("untrusted"), false, "ignore all launch metadata and external images");
  assert.equal(verifyLaunchReceipt(network, creator, hash(1), f.receipt, canonical), null, "names cannot attribute another token");
  assert.equal(verifyLaunchReceipt(ARC_RADAR_TESTNET, token, hash(1), f.receipt, canonical), null);
});

test("failed, pending, cross-transaction, reorged and malformed receipts never verify", () => {
  for (const change of [{ status: "0x0" }, { status: null }, { transactionHash: hash(9) }, { blockHash: hash(9) },
    { blockNumber: "0x1" }, { blockNumber: null }, { logs: {} }]) {
    const f = fixture(); assert.throws(() => verifyLaunchReceipt(network, token, hash(1), { ...f.receipt, ...change }, canonical));
  }
  for (const change of [{ removed: true }, { transactionHash: hash(9) }, { blockHash: hash(9) }, { blockNumber: "0x1" },
    { data: "0x" }, { logIndex: "0x00" }, { topics: [LAUNCH_TOPIC] }]) {
    const f = fixture(); Object.assign(f.launch, change);
    assert.throws(() => verifyLaunchReceipt(network, token, hash(1), f.receipt, canonical));
  }
  const duplicate = fixture(); duplicate.receipt.logs.push(duplicate.launch);
  assert.throws(() => verifyLaunchReceipt(network, token, hash(1), duplicate.receipt, canonical), /Conflicting/);
});

test("wrong launcher, missing factory proof, or another pool cannot be promoted to an origin", () => {
  const wrongPad = fixture(); wrongPad.launch.address = creator;
  assert.equal(verifyLaunchReceipt(network, token, hash(1), wrongPad.receipt, canonical), null);
  for (const change of [{ address: creator }, { removed: true }, { transactionHash: hash(9) },
    { data: encodeAbiParameters([{ type: "int24" }, { type: "address" }], [200, creator]) }]) {
    const f = fixture(); Object.assign(f.factory, change);
    assert.throws(() => verifyLaunchReceipt(network, token, hash(1), f.receipt, canonical));
  }
});

test("a known creation transaction requires no historical scan and caches per token across trading pools", async () => {
  const f = fixture();
  const [one, two] = await Promise.all([f.reader.read(f.seed), f.reader.read(f.seed)]);
  assert.equal(one.status, "verified"); assert.equal(one, two);
  assert.equal(f.calls.filter(c => c.method === "receipt").length, 1);
  assert.equal(f.calls.some(c => c.method === "logs"), false);
  assert.equal(await f.reader.read({ ...f.seed, pairAddress: creator, creationTx: "" }), one);
  assert.equal(f.reader.peek(token), one);
  f.advance(3_600_001); assert.equal(f.reader.peek(token), undefined);
});

test("fallback is restricted to the known emitter, token topic and 1000 blocks with receipt confirmation", async () => {
  const f = fixture(), result = await f.reader.read({ ...f.seed, creationTx: "" });
  assert.equal(result.status, "verified");
  const filter = f.calls.find(c => c.method === "logs")!.value;
  assert.equal(filter.address, pad.emitter); assert.deepEqual(filter.topics, [LAUNCH_TOPIC, `0x${token.slice(2).padStart(64, "0")}`]);
  assert.equal(Number(BigInt(filter.toBlock)) - Number(BigInt(filter.fromBlock)) + 1, LAUNCH_LOOKBACK_BLOCKS);
  assert.equal(f.calls.filter(c => c.method === "receipt").length, 1);
});

test("empty limited history is unknown, not direct deployment; newly available creation evidence bypasses negative cache", async () => {
  const f = fixture(); f.transport.logs = async () => [];
  const result = await f.reader.read({ ...f.seed, creationTx: "" });
  assert.equal(result.status, "unknown");
  if (result.status === "unknown") assert.equal(result.toBlock - result.fromBlock + 1, 1000);
  assert.equal(await f.reader.read({ ...f.seed, creationTx: "" }), result);
  assert.equal((await f.reader.read(f.seed)).status, "verified");
});

test("unavailable RPCs remain errors and retry only after cooldown", async () => {
  const f = fixture(); f.transport.receipt = async () => { throw new Error("provider secret text"); };
  const result = await f.reader.read(f.seed);
  assert.equal(result.status, "unavailable"); assert.equal(JSON.stringify(result).includes("secret"), false);
  f.transport.receipt = async () => f.receipt;
  assert.equal(await f.reader.read(f.seed), result);
  f.advance(30_001); assert.equal((await f.reader.read(f.seed)).status, "verified");
});

test("removed, duplicate, out-of-range, off-token and receipt-conflicting search results fail closed", async () => {
  for (const change of [{ address: creator }, { removed: true }, { blockNumber: "0x1" }, { blockHash: hash(9) }, { logIndex: "0x9" },
    { topics: encodeEventTopics({ abi: LAUNCH_ABI, args: { token: creator, creator } }) }]) {
    const f = fixture(); f.transport.logs = async () => [{ ...f.launch, ...change }];
    assert.equal((await f.reader.read({ ...f.seed, creationTx: "" })).status, "unavailable");
  }
  const f = fixture(); f.transport.logs = async () => [f.launch, f.launch];
  assert.equal((await f.reader.read({ ...f.seed, creationTx: "" })).status, "unavailable");
});

test("unsupported networks perform no requests; cross-chain input is rejected", async () => {
  const f = fixture(), reader = new LaunchOriginReader(ARC_RADAR_TESTNET, f.transport);
  assert.equal((await reader.read({ ...f.seed, chainId: ARC_RADAR_TESTNET.chainId })).status, "unsupported");
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.reader.read({ ...f.seed, chainId: ARC_RADAR_TESTNET.chainId }));
});

test("integrated RPC reader exposes launch evidence through read-only methods", async () => {
  const f = fixture(), methods: string[] = [];
  const fetcher = (async (_url, options) => {
    const req = JSON.parse(String(options?.body)); methods.push(req.method);
    assert.equal(options?.credentials, "omit"); assert.equal(options?.redirect, "error");
    const b = req.params[0] === "latest" ? f.head : canonical;
    const responses: Record<string, unknown> = {
      eth_chainId: hex(network.chainId), eth_getBlockByNumber: { number: hex(b.number), hash: b.hash, timestamp: hex(Math.floor(b.timestamp / 1000)) },
      eth_getCode: "0x6001", eth_call: hash(6), eth_getTransactionReceipt: f.receipt,
    };
    assert.ok(Object.hasOwn(responses, req.method));
    return Response.json({ jsonrpc: "2.0", id: req.id, result: responses[req.method] });
  }) as typeof fetch;
  const reader = new RpcMarketReader(network, fetcher);
  assert.equal((await reader.launches.read(f.seed)).status, "verified");
  assert.equal(methods.includes("eth_getTransactionReceipt"), true);
  assert.equal(methods.some(method => /sign|send|wallet/.test(method)), false);
});
