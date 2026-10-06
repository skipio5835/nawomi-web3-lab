import test from "node:test";
import assert from "node:assert/strict";
import { ARC_RADAR_TESTNET, RADAR_NETWORKS, readRadarNetworkId, resolveRadarNetwork, validateRadarNetwork, radarStoragePrefix, type RadarNetwork } from "../src/arc-radar-networks.js";
import { checkRadarNetwork, probeRadarNetwork } from "../src/arc-radar-network-check.js";
import { marketUrl } from "../src/arc-radar-navigation.js";

test("URL selection rejects ambiguous networks and chain switching clears pool and preview state", () => {
  assert.equal(readRadarNetworkId(new URL("https://example.invalid/")), "arc-mainnet");
  assert.equal(readRadarNetworkId(new URL("https://example.invalid/?network=arc-mainnet")), "arc-mainnet");
  for (const query of ["network=", "network=arc-mainnet&network=arc-testnet", "network=arc-testnet&network=arc-testnet"]) {
    assert.throws(() => readRadarNetworkId(new URL(`https://example.invalid/?${query}`)), /Invalid network link/);
  }
  const switched = new URL(marketUrl("https://example.invalid/circle/arc/public/arc-radar.html?network=arc-testnet&pool=0x123&ads=preview#activity", "arc-mainnet"));
  assert.equal(switched.pathname, "/circle/arc/public/arc-radar.html");
  assert.equal(switched.search, "?network=arc-mainnet");
  assert.equal(switched.hash, "");
  for (const id of ["__proto__", "constructor", "unknown"]) assert.throws(() => resolveRadarNetwork(id));
});

test("unconfigured and candidate networks cannot load markets or fall back to testnet", async () => {
  let calls = 0;
  const noFetch = (async () => { calls++; throw new Error("unexpected network"); }) as typeof fetch;
  const mainnet = RADAR_NETWORKS["arc-mainnet"];
  try {
    RADAR_NETWORKS["arc-mainnet"] = { status: "unconfigured", label: "Arc Mainnet" };
    assert.equal((await checkRadarNetwork("arc-mainnet", noFetch)).status, "unconfigured");
    assert.throws(() => resolveRadarNetwork("arc-mainnet"), /not available/);
  } finally { RADAR_NETWORKS["arc-mainnet"] = mainnet; }
  assert.equal((await checkRadarNetwork("unknown", noFetch)).status, "failed");
  assert.equal(calls, 0);
  const saved = RADAR_NETWORKS["arc-testnet"];
  try {
    RADAR_NETWORKS["arc-testnet"] = { status: "candidate", network: ARC_RADAR_TESTNET };
    assert.throws(() => resolveRadarNetwork("arc-testnet"), /not available/);
    RADAR_NETWORKS["arc-testnet"] = { status: "ready", network: { ...ARC_RADAR_TESTNET, id: "mismatch" } };
    assert.throws(() => resolveRadarNetwork("arc-testnet"), /configuration/);
  } finally { RADAR_NETWORKS["arc-testnet"] = saved; }
});

test("configuration validation rejects testnet mainnet mixes, credentials, duplicate sources and invalid decimals", () => {
  validateRadarNetwork(ARC_RADAR_TESTNET);
  const variants: RadarNetwork[] = [
    { ...ARC_RADAR_TESTNET, id: "arc-mainnet" },
    { ...ARC_RADAR_TESTNET, testnet: false },
    { ...ARC_RADAR_TESTNET, id: "arc-mainnet", testnet: false, chainId: 999999 },
    { ...ARC_RADAR_TESTNET, rpcUrl: "http://example.invalid" },
    { ...ARC_RADAR_TESTNET, rpcUrl: "https://user:secret@example.invalid" },
    { ...ARC_RADAR_TESTNET, rpcUrl: "https://example.invalid?api_key=secret" },
    { ...ARC_RADAR_TESTNET, chainId: NaN },
    { ...ARC_RADAR_TESTNET, id: "unsafe:namespace" },
    { ...ARC_RADAR_TESTNET, apiBase: "https://example.invalid/api/v1" },
    { ...ARC_RADAR_TESTNET, quoteAsset: { ...ARC_RADAR_TESTNET.quoteAsset, decimals: 18 } },
    { ...ARC_RADAR_TESTNET, nativeQuoteAsset: { ...ARC_RADAR_TESTNET.nativeQuoteAsset!, decimals: 6 } },
    { ...ARC_RADAR_TESTNET, sources: [] },
    { ...ARC_RADAR_TESTNET, sources: [...ARC_RADAR_TESTNET.sources, ...ARC_RADAR_TESTNET.sources] },
    { ...ARC_RADAR_TESTNET, sources: [{ ...ARC_RADAR_TESTNET.sources[0]!, protocol: "uniswap-v4" }] },
  ];
  for (const network of variants) assert.throws(() => validateRadarNetwork(network), /configuration/);
  assert.notEqual(radarStoragePrefix(ARC_RADAR_TESTNET), radarStoragePrefix({ ...ARC_RADAR_TESTNET, id: "arc-mainnet", chainId: 999999 }));
  assert.notEqual(radarStoragePrefix(ARC_RADAR_TESTNET), radarStoragePrefix({ ...ARC_RADAR_TESTNET, chainId: 999999 }));
});

function fixture(mode = "ok") {
  const calls: string[] = [];
  const blockHash = `0x${"ab".repeat(32)}`;
  let blockReads = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    let data: any;
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      calls.push(request.method);
      assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(request.method));
      let result;
      if (request.method === "eth_chainId") result = mode === "chain" ? "0x1" : `0x${ARC_RADAR_TESTNET.chainId.toString(16)}`;
      if (request.method === "eth_getBlockByNumber") {
        blockReads++;
        result = { number: "0x7b", hash: mode === "hash" || (mode === "reorg" && blockReads === 2) ? `0x${"cd".repeat(32)}` : blockHash,
          timestamp: `0x${Math.floor((Date.now() - (mode === "stale" ? 600_000 : 1000)) / 1000).toString(16)}` };
      }
      if (request.method === "eth_call") {
        assert.equal(request.params[1], "0x7b");
        assert.equal(request.params[0].data, "0x313ce567");
        result = `0x${(mode === "decimals" ? "12" : "6").padStart(64, "0")}`;
      }
      if (request.method === "eth_getCode") {
        assert.equal(request.params[1], "0x7b");
        result = mode === "code" ? "0x" : "0x6001";
      }
      data = { jsonrpc: "2.0", id: mode === "rpc-id" ? 0 : request.id, result };
    } else {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path.endsWith("/blocks")) data = { items: [{ height: 123, hash: blockHash }] };
      else if (path.includes("/tokens/")) data = { address_hash: ARC_RADAR_TESTNET.quoteAsset.address, decimals: "6", symbol: mode === "token" ? "FAKE" : "USDC", type: "ERC-20" };
      else if (path.endsWith("/logs")) data = mode === "logs" ? { error: "limit" } : { items: [{ address: { hash: mode === "emitter" ? ARC_RADAR_TESTNET.quoteAsset.address : ARC_RADAR_TESTNET.sources[0]!.factoryAddress } }] };
      else throw new Error("Unexpected request");
    }
    return new Response(mode === "json" ? "not JSON" : JSON.stringify(data), { status: mode === "http" ? 503 : 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("readiness checker uses read-only calls at one block and verifies RPC / index agreement", async () => {
  const { fetcher, calls } = fixture();
  const result = await probeRadarNetwork(ARC_RADAR_TESTNET, fetcher);
  assert.equal(result.status, "passed", result.error);
  assert.equal(calls.filter(call => call === "eth_getBlockByNumber").length, 2);
  assert.equal(result.checks.length, 5);
  assert.equal(RADAR_NETWORKS["arc-mainnet"].status, "ready");
});

test("readiness checker fails closed on chain, hash, stale index, decimals, code, and malformed responses", async () => {
  for (const mode of ["chain", "hash", "reorg", "stale", "decimals", "token", "code", "logs", "emitter", "rpc-id", "json", "http"]) {
    const { fetcher, calls } = fixture(mode);
    const result = await probeRadarNetwork(ARC_RADAR_TESTNET, fetcher);
    assert.equal(result.status, "failed", mode);
    assert.ok(result.error, mode);
    if (mode === "chain") assert.deepEqual(calls, ["eth_chainId"]);
  }
});

test("invalid config makes no requests and transport errors do not echo credentials", async () => {
  const fail = (async () => { throw new Error("secret-url-token"); }) as typeof fetch;
  const invalid = await probeRadarNetwork({ ...ARC_RADAR_TESTNET, chainId: 1 }, fail);
  assert.match(invalid.error!, /configuration/);
  const offline = await probeRadarNetwork(ARC_RADAR_TESTNET, fail);
  assert.match(offline.error!, /request failed/);
  assert.doesNotMatch(JSON.stringify(offline), /secret-url-token/);
});
