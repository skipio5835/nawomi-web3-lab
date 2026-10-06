import { ARC_TESTNET_USDC_ADDRESS, type RadarQuoteAsset } from "./arc-radar-core.js";

export type RadarDexSource = {
  id: string;
  label: string;
  protocol: "uniswap-v2" | "uniswap-v3" | "uniswap-v4";
  factoryAddress: string;
  // v4 sources must explicitly identify the singleton, not a v2 factory.
  poolManagerAddress?: string;
};

export type RadarNetwork = {
  id: string;
  label: string;
  chainId: number;
  testnet: boolean;
  apiBase: string;
  rpcUrl: string;
  explorerBase: string;
  dataMode?: "rpc-dex";
  quoteAsset: RadarQuoteAsset;
  nativeQuoteAsset?: RadarQuoteAsset;
  sources: readonly RadarDexSource[];
};

export const ARC_RADAR_TESTNET: RadarNetwork = {
  id: "arc-testnet",
  label: "Arc Testnet",
  chainId: 5042002,
  testnet: true,
  apiBase: "https://testnet.arcscan.app/api/v2",
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerBase: "https://testnet.arcscan.app",
  quoteAsset: { address: ARC_TESTNET_USDC_ADDRESS, decimals: 6, symbol: "USDC" },
  nativeQuoteAsset: { address: "0x0000000000000000000000000000000000000000", decimals: 18, symbol: "USDC" },
  sources: [{
    id: "arc-usdc-v2",
    label: "Arc USDC pools",
    protocol: "uniswap-v2",
    factoryAddress: "0x7483847D46Db2920DD64eFa676CF72dcF765814f",
  }],
};

export type RadarNetworkEntry =
  | { status: "unconfigured"; label: string }
  | { status: "candidate" | "ready"; network: RadarNetwork };

// Arc RPC reference and Uniswap's chain-5042 deployment list, checked 2026-09-16.
export const ARC_RADAR_MAINNET: RadarNetwork = {
  id: "arc-mainnet", label: "Arc Mainnet", chainId: 5042, testnet: false,
  rpcUrl: "https://rpc.mainnet.arc.io", apiBase: "https://explorer.arc.io/api/v2",
  explorerBase: "https://explorer.arc.io", dataMode: "rpc-dex",
  quoteAsset: { address: "0x3600000000000000000000000000000000000000", decimals: 6, symbol: "USDC" },
  nativeQuoteAsset: { address: "0x0000000000000000000000000000000000000000", decimals: 18, symbol: "USDC" },
  sources: [{ id: "uniswap-v4-arc", label: "Uniswap v4", protocol: "uniswap-v4",
    factoryAddress: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    poolManagerAddress: "0x8366a39CC670B4001A1121B8F6A443A643e40951" },
    { id: "uniswap-v3-arc", label: "Uniswap v3", protocol: "uniswap-v3",
      factoryAddress: "0xf0db7b58379503491d857db50ac9ece64c653918" }],
};

// Use candidate for published settings until the read-only check and manual review pass.
export const RADAR_NETWORKS: Record<string, RadarNetworkEntry> = {
  "arc-testnet": { status: "ready", network: ARC_RADAR_TESTNET },
  "arc-mainnet": { status: "ready", network: ARC_RADAR_MAINNET },
};

export function readRadarNetworkId(url: URL): string {
  const values = url.searchParams.getAll("network");
  if (values.length > 1 || (values.length === 1 && !values[0])) throw new Error("Invalid network link.");
  return values[0] ?? "arc-mainnet";
}

export function radarNetworkEntry(id: string): RadarNetworkEntry {
  if (!Object.hasOwn(RADAR_NETWORKS, id)) throw new Error("This network is not supported by ARCROW.");
  return RADAR_NETWORKS[id]!;
}

export function validateRadarNetwork(network: RadarNetwork): void {
  const fail = (): never => { throw new Error("Invalid ARCROW network configuration."); };
  const address = (value: string) => /^0x[0-9a-f]{40}$/i.test(value);
  if (!/^[a-z0-9-]+$/.test(network.id) || !network.label.trim()
    || !Number.isSafeInteger(network.chainId) || network.chainId <= 0
    || typeof network.testnet !== "boolean") fail();
  const urls = [network.rpcUrl, network.apiBase, network.explorerBase].map(value => {
    let url: URL;
    try { url = new URL(value); } catch { return fail(); }
    // These are public, source-controlled endpoints, never credential-bearing URLs.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.port || !url.hostname.includes(".") || url.hostname === "localhost") fail();
    return url;
  });
  if (!network.apiBase.endsWith("/api/v2") || network.explorerBase.endsWith("/")) fail();
  if (!address(network.quoteAsset.address) || /^0x0{40}$/i.test(network.quoteAsset.address)
    || network.quoteAsset.decimals !== 6 || network.quoteAsset.symbol !== "USDC") fail();
  if (network.nativeQuoteAsset && (network.nativeQuoteAsset.address !== "0x0000000000000000000000000000000000000000"
    || network.nativeQuoteAsset.decimals !== 18 || network.nativeQuoteAsset.symbol !== "USDC")) fail();
  if (network.sources.length === 0 || network.sources.length > 4) fail();
  if (network.dataMode !== undefined && network.dataMode !== "rpc-dex") fail();
  if (network.dataMode === "rpc-dex" && network.sources.some(source => !["uniswap-v3", "uniswap-v4"].includes(source.protocol))) fail();
  const ids = new Set<string>();
  const emitters = new Set<string>();
  for (const source of network.sources) {
    if (!/^[a-z0-9-]+$/.test(source.id) || ids.has(source.id) || !source.label.trim()
      || !address(source.factoryAddress) || /^0x0{40}$/i.test(source.factoryAddress)
      || emitters.has(source.factoryAddress.toLowerCase())) fail();
    ids.add(source.id);
    emitters.add(source.factoryAddress.toLowerCase());
    if (source.protocol === "uniswap-v4") {
      if (!source.poolManagerAddress || source.poolManagerAddress.toLowerCase() !== source.factoryAddress.toLowerCase()) fail();
    } else if (!["uniswap-v2", "uniswap-v3"].includes(source.protocol) || source.poolManagerAddress) fail();
  }
  if (network.id === "arc-testnet" && (!network.testnet || network.chainId !== 5042002)) fail();
  if (network.id === "arc-mainnet" && (network.testnet || network.chainId !== 5042)) fail();
  if (!network.testnet && (network.chainId === 5042002
    || urls.some(url => /(^|[.-])(testnet|sepolia)([.-]|$)/i.test(url.hostname)))) fail();
}

export function resolveRadarNetwork(id = "arc-testnet"): RadarNetwork {
  const entry = radarNetworkEntry(id);
  if (entry.status !== "ready") throw new Error(`${entry.status === "unconfigured" ? entry.label : entry.network.label} is not available in ARCROW yet.`);
  if (entry.network.id !== id) throw new Error("Invalid ARCROW network configuration.");
  validateRadarNetwork(entry.network);
  return entry.network;
}

export function radarStoragePrefix(network: RadarNetwork): string {
  return `arcrow:v2:${network.id}:${network.chainId}:`;
}

export function radarPoolKey(network: RadarNetwork, pairAddress: string): string {
  return `${radarStoragePrefix(network)}pool:${pairAddress.toLowerCase()}`;
}
