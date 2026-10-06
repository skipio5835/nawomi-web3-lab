import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, type Hex } from "viem";
import { ARC_RADAR_MAINNET, ARC_RADAR_TESTNET, radarStoragePrefix, validateRadarNetwork } from "../src/arc-radar-networks.js";
import { RpcMarketReader } from "../src/arc-radar-rpc.js";
import { createDexAdapter, type DexLogPage } from "../src/arc-radar-dex.js";
import { probeRadarNetwork } from "../src/arc-radar-network-check.js";
import { initialize, swap, token } from "./fixtures/arc-radar-v4.js";

const network = ARC_RADAR_MAINNET, manager = network.sources[0]!.factoryAddress;
const path = `/addresses/${manager}/logs`;
const hex = (n: number) => `0x${n.toString(16)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function fixture(mode = "ok") {
  const now = Math.floor(Date.now() / 1000) - 2, head = 50_000;
  const init = initialize();
  const raw = (event = init, block = head - 2) => ({ address: manager, topics: event.topics, data: event.data,
    blockNumber: hex(block), blockHash: hash(block), transactionHash: event.transaction_hash,
    logIndex: hex(event.index), removed: false });
  let logs: any[] = [raw()];
  const calls: Array<{ method: string; params: any[] }> = [];
  const fetcher = (async (url, options) => {
    assert.equal(url, network.rpcUrl); assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "omit");
    const req = JSON.parse(String(options?.body)); calls.push(req);
    assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs", "eth_call", "eth_getTransactionByHash", "eth_getTransactionReceipt"].includes(req.method));
    let result: unknown;
    if (req.method === "eth_chainId") result = mode === "chain" ? "0x4cf4b2" : "0x13b2";
    else if (req.method === "eth_getBlockByNumber") {
      const n = req.params[0] === "latest" ? head : Number(BigInt(req.params[0]));
      result = { number: hex(n), hash: hash(mode === "block-hash" && n < head ? n + 1 : n),
        timestamp: hex(now - (head - n) - (mode === "stale" ? 600 : 0)) };
    } else if (req.method === "eth_getCode") result = mode === "code" ? "0x" : "0x6001";
    else if (req.method === "eth_getLogs") {
      const filter = req.params[0];
      if ((mode === "range" && Number(BigInt(filter.toBlock)) - Number(BigInt(filter.fromBlock)) > 9) || mode === "range-always") {
        return Response.json({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "max results range" } });
      }
      result = mode === "shape" ? {} : filter.address.toLowerCase() !== manager.toLowerCase() ? []
        : mode === "block-budget" ? Array.from({ length: 25 }, (_, i) => ({ ...raw(init, head - i), logIndex: hex(i) }))
          .filter(log => Number(BigInt(log.blockNumber)) >= Number(BigInt(filter.fromBlock))) : logs;
    } else if (req.method === "eth_call") {
      const call = req.params[0];
      if (mode === "metadata" && call.to.toLowerCase() === token.toLowerCase()) result = "0x";
      else if (call.data === "0x313ce567") result = encodeAbiParameters([{ type: "uint256" }], [mode === "decimals" ? 18n : 6n]);
      else if (call.data === "0x18160ddd") result = encodeAbiParameters([{ type: "uint256" }], [12345678901234567890123456n]);
      else result = encodeAbiParameters([{ type: "string" }], [call.data === "0x06fdde03" ? "<img src=x onerror=alert(1)>" : "TOKEN"]);
    } else if (req.method === "eth_getTransactionByHash") result = { hash: req.params[0], from: token, blockNumber: hex(head - 1) };
    else if (req.method === "eth_getTransactionReceipt") result = { transactionHash: req.params[0], status: "0x1", blockNumber: hex(head - 2), blockHash: hash(head - 2), logs };
    return Response.json({ jsonrpc: "2.0", id: mode === "id" ? -1 : req.id, result });
  }) as typeof fetch;
  return { reader: new RpcMarketReader(network, fetcher), fetcher, calls, raw, init, setLogs: (value: any[]) => { logs = value; } };
}

test("mainnet is official chain 5042 and all storage remains distinct from testnet", () => {
  validateRadarNetwork(network);
  assert.notEqual(radarStoragePrefix(network), radarStoragePrefix(ARC_RADAR_TESTNET));
  assert.throws(() => validateRadarNetwork({ ...network, chainId: 5042002 }));
  assert.throws(() => validateRadarNetwork({ ...network, dataMode: "other" as "rpc-dex" }));
  assert.throws(() => new RpcMarketReader(ARC_RADAR_TESTNET));
});

test("saved creation references are recovered only from canonical configured-factory receipts", async () => {
  const f = fixture(), route = `/creations/${f.init.transaction_hash}`;
  const seeds = await f.reader.read(route) as Array<{ chainId: number; creationTx: string }>;
  assert.equal(seeds.length, 1); assert.equal(seeds[0]!.chainId, network.chainId);
  assert.equal(seeds[0]!.creationTx, f.init.transaction_hash);
  f.setLogs([{ ...f.raw(), address: token }]);
  assert.deepEqual(await f.reader.read(route), []);
  for (const change of [{ blockHash: hash(1) }, { transactionHash: hash(2) }, { removed: true }, { data: "bad" }]) {
    f.setLogs([{ ...f.raw(), ...change }]);
    await assert.rejects(f.reader.read(route), /creation log/i);
  }
  await assert.rejects(f.reader.read(route + "?url=https://evil.invalid"), /scope/);
});

test("RPC bootstrap fails closed on chain, stale block, missing code, decimals, and response identity", async () => {
  for (const mode of ["chain", "stale", "code", "decimals", "id"]) {
    const f = fixture(mode); await assert.rejects(f.reader.read(path), /RPC/);
    assert.equal(f.calls.some(call => call.method === "eth_getLogs"), false);
  }
});

test("real ABI fixtures decode through RPC with pool ID, block hash and timestamp checks", async () => {
  const f = fixture();
  const page = await f.reader.read(path) as DexLogPage & { partial: boolean };
  assert.equal(page.partial, true);
  const adapter = createDexAdapter(network.sources[0]!, network), pools = adapter.pairSeeds(page);
  assert.equal(pools.length, 1); assert.equal(pools[0]!.chainId, 5042);
  assert.equal(page.next_page_params?.before, 49950);
  f.setLogs([f.raw(swap(pools[0]!.v4!.poolId as Hex), 49999)]);
  const trades = await f.reader.read(`${path}?pool=${pools[0]!.v4!.poolId}`) as DexLogPage;
  assert.equal(adapter.trade(trades.items![0]!, pools[0]!)!.direction, "buy");
  assert.equal(adapter.trade(trades.items![0]!, pools[0]!)!.usdcValue, 2);
  assert.equal(adapter.latestReserves(trades.items!, pools[0]!, "6"), null);
  assert.ok(f.calls.filter(c => c.method === "eth_getLogs").at(-1)!.params[0].topics[1] === pools[0]!.v4!.poolId);
});

test("unknown or malformed paths cannot turn the reader into a generic RPC proxy", async () => {
  const f = fixture();
  for (const p of ["https://evil.invalid", "//evil.invalid/path", "/tokens/../../.env", `/tokens/${token}/holders`, `/addresses/${token}/logs`, `${path}?url=https://evil.invalid`, `${path}?pool=bad`, `${path}?pool=${hash(1)}&pool=${hash(2)}`, `${path}?before=-1`, `${path}?anchor=99999999`, `${path}?before=1`]) {
    await assert.rejects(f.reader.read(p));
  }
  assert.equal(f.calls.some(c => c.method === "eth_getLogs"), false);
  assert.equal(f.calls.some(c => /send|sign|wallet/i.test(c.method)), false);
});

test("off-scope, removed, duplicate, out-of-range or hash-conflicting logs cannot become market data", async () => {
  for (const change of [{ address: token }, { removed: true }, { topics: [hash(0)] }, { blockNumber: "0x1" }, { blockHash: hash(3) }, { logIndex: "0x00" }, { transactionHash: "bad" }, { data: "0xz1" }]) {
    const f = fixture(); f.setLogs([{ ...f.raw(), ...change }]); await assert.rejects(f.reader.read(path));
  }
  const duplicate = fixture(); duplicate.setLogs([duplicate.raw(), duplicate.raw()]); await assert.rejects(duplicate.reader.read(path), /duplicate/);
  const mismatch = fixture(); await assert.rejects(mismatch.reader.read(`${path}?pool=${hash(99)}`), /scope/);
  await assert.rejects(fixture("shape").reader.read(path), /log response/);
  await assert.rejects(fixture("block-hash").reader.read(path), /mismatch/);
});

test("provider result limits shrink the range and expose a resumable boundary without dropping logs", async () => {
  const f = fixture("range");
  const page = await f.reader.read(path) as DexLogPage;
  assert.equal(f.calls.filter(c => c.method === "eth_getLogs").length, 4);
  assert.equal(page.next_page_params!.before, 49994);
  const failed = fixture("range-always"); await assert.rejects(failed.reader.read(path));
  assert.ok(failed.calls.filter(c => c.method === "eth_getLogs").length <= 11);
});

test("metadata is untrusted text with exact supply, missing holders and no verification claims", async () => {
  const f = fixture();
  const tokenData = await f.reader.read(`/tokens/${token}`) as any;
  assert.equal(tokenData.total_supply, "12345678901234567890123456");
  assert.equal(tokenData.decimals, "6"); assert.equal(tokenData.holders_count, null);
  assert.equal(tokenData.is_verified, undefined); assert.match(tokenData.name, /<img/);
  const missing = await fixture("metadata").reader.read(`/tokens/${token}`) as any;
  for (const key of ["name", "symbol", "decimals", "total_supply", "holders_count"]) assert.equal(missing[key], null);
});

test("busy ranges shrink before timestamp reads and preserve the omitted older boundary", async () => {
  const f = fixture("block-budget");
  const page = await f.reader.read(path) as DexLogPage;
  assert.ok(page.items!.length > 0 && page.items!.length <= 12);
  const blocks = f.calls.filter(c => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest");
  assert.equal(blocks.length, page.items!.length);
  const oldest = Math.min(...page.items!.map(log => log.block_number!));
  assert.equal(page.next_page_params!.before, oldest - 1);
});

test("transactions expose only checked sender identity, not an inferred developer", async () => {
  const f = fixture();
  assert.deepEqual(await f.reader.read(`/transactions/${hash(123)}`), { from: { hash: token } });
});

test("mainnet readiness uses only RPC and leaves configuration untouched", async () => {
  const f = fixture(); const before = JSON.stringify(network);
  const result = await probeRadarNetwork(network, f.fetcher);
  assert.equal(result.status, "passed", result.error); assert.equal(JSON.stringify(network), before);
  assert.ok(result.checks.some(v => v.includes("raw event decoding")));
});
