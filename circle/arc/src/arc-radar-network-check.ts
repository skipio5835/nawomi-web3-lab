import { radarNetworkEntry, validateRadarNetwork, type RadarNetwork } from "./arc-radar-networks.js";
import { RpcMarketReader } from "./arc-radar-rpc.js";
import { createDexAdapter, type DexLogPage } from "./arc-radar-dex.js";

export type NetworkCheck = {
  network: string;
  status: "passed" | "failed" | "unconfigured";
  checks: string[];
  error?: string;
};

const hash = /^0x[0-9a-f]{64}$/i;
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;

// Connectivity and a shared block sample, not proof of DEX identity or complete indexing.
export async function probeRadarNetwork(network: RadarNetwork, fetcher: typeof fetch = fetch): Promise<NetworkCheck> {
  const checks: string[] = [];
  let stage = "Configuration";
  let requestId = 0;
  const deadline = AbortSignal.timeout(60_000);
  function requireValue(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  async function json(url: string, init?: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, credentials: "omit", cache: "no-store", redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]) });
    } catch { throw new Error(`${stage}: request failed or timed out.`); }
    requireValue(response.ok, `${stage}: HTTP ${response.status}.`);
    try { return await response.json(); } catch { throw new Error(`${stage}: invalid JSON.`); }
  }
  async function rpc(method: string, params: unknown[]): Promise<any> {
    const id = ++requestId;
    const body = await json(network.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    requireValue(body?.jsonrpc === "2.0" && body.id === id && !body.error && body.result !== undefined,
      `${stage}: invalid RPC response.`);
    return body.result;
  }
  try {
    validateRadarNetwork(network);
    checks.push("Configuration shape");
    if (network.dataMode === "rpc-dex") {
      const reader = new RpcMarketReader(network, fetcher);
      const head = await reader.checkNetwork();
      checks.push(`RPC chain ID / fresh block ${head.number} / USDC decimals / DEX code`);
      for (const source of network.sources) {
        const adapter = createDexAdapter(source, network);
        const page = await reader.read(adapter.discoveryPath, deadline) as DexLogPage;
        requireValue(!adapter.historyIncomplete?.(page.items ?? []), "Invalid raw DEX events.");
        checks.push(`${source.id}: ${adapter.pairSeeds(page).length} recent USDC pools / raw event decoding / block hash and timestamp (empty samples are possible)`);
      }
      const recheck = await rpc("eth_getBlockByNumber", [`0x${head.number.toString(16)}`, false]);
      requireValue(recheck?.hash?.toLowerCase() === head.hash, "RPC sample block changed during checks.");
      return { network: network.id, status: "passed", checks };
    }
    stage = "RPC chain ID";
    const chain = await rpc("eth_chainId", []);
    requireValue(typeof chain === "string" && quantity.test(chain) && BigInt(chain) === BigInt(network.chainId), "RPC chain ID mismatch.");
    checks.push(stage);
    stage = "Explorer block";
    const blocks = await json(`${network.apiBase}/blocks?type=block`);
    const block = Array.isArray(blocks?.items) ? blocks.items[0] : null;
    requireValue(block && Number.isSafeInteger(block.height) && block.height >= 0 && hash.test(block.hash), "Explorer block is unavailable.");
    const blockTag = `0x${block.height.toString(16)}`;
    const anchor = await rpc("eth_getBlockByNumber", [blockTag, false]);
    const timestamp = typeof anchor?.timestamp === "string" && quantity.test(anchor.timestamp) ? Number(BigInt(anchor.timestamp)) * 1000 : NaN;
    requireValue(anchor?.number === blockTag && typeof anchor.hash === "string" && anchor.hash.toLowerCase() === block.hash.toLowerCase(),
      "RPC and explorer block hashes disagree.");
    const age = Date.now() - timestamp;
    requireValue(Number.isFinite(age) && age >= -30_000 && age <= 300_000, "Explorer block is too old or has an invalid timestamp.");
    checks.push(`RPC / explorer shared block ${block.height}`);
    stage = "USDC";
    const decimals = await rpc("eth_call", [{ to: network.quoteAsset.address, data: "0x313ce567" }, blockTag]);
    requireValue(typeof decimals === "string" && hash.test(decimals) && BigInt(decimals) === 6n, "USDC decimals mismatch.");
    const token = await json(`${network.apiBase}/tokens/${network.quoteAsset.address}`);
    requireValue(typeof token?.address_hash === "string" && token.address_hash.toLowerCase() === network.quoteAsset.address.toLowerCase()
      && String(token.decimals) === "6" && token.symbol === "USDC" && token.type === "ERC-20", "Explorer USDC metadata mismatch.");
    checks.push("USDC RPC decimals / index metadata");
    for (const source of network.sources) {
      stage = `DEX ${source.id}`;
      const code = await rpc("eth_getCode", [source.factoryAddress, blockTag]);
      requireValue(typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(code) && !/^0x0+$/i.test(code), `${stage}: contract code missing.`);
      const logs = await json(`${network.apiBase}/addresses/${source.factoryAddress}/logs`);
      requireValue(Array.isArray(logs?.items) && logs.items.every((log: any) => typeof log?.address?.hash === "string"
        && log.address.hash.toLowerCase() === source.factoryAddress.toLowerCase()), `${stage}: incompatible log response.`);
      checks.push(`${stage}: code present / log API available (${logs.items.length} sample logs)`);
    }
    stage = "Block recheck";
    const finalAnchor = await rpc("eth_getBlockByNumber", [blockTag, false]);
    requireValue(finalAnchor?.hash === anchor.hash, "Shared block changed during checks.");
    return { network: network.id, status: "passed", checks };
  } catch (error) {
    return { network: network.id, status: "failed", checks, error: error instanceof Error ? error.message : `${stage}: check failed.` };
  }
}

export async function checkRadarNetwork(id: string, fetcher: typeof fetch = fetch): Promise<NetworkCheck> {
  let entry;
  try { entry = radarNetworkEntry(id); }
  catch { return { network: id, status: "failed", checks: [], error: "Unsupported network." }; }
  if (entry.status === "unconfigured") return { network: id, status: "unconfigured", checks: [], error: "Official network and DEX settings have not been configured. No requests made." };
  if (entry.network.id !== id) return { network: id, status: "failed", checks: [], error: "Network registry ID mismatch." };
  return probeRadarNetwork(entry.network, fetcher);
}
