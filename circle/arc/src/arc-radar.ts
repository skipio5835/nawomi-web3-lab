import {
  decimalValue,
  fullyDilutedValue,
} from "./arc-radar-core.js";
import { refineMarkets, type DiscoveryOptions, type MarketSort } from "./arc-radar-discovery.js";
import { createDexAdapter, discoverDexPools, selectDexAdapters, type RadarProtocolFilter, type RadarPool, type DexPricePoint, type DexTrade, type DexLiquidityEvent } from "./arc-radar-dex.js";
import { RADAR_NETWORKS, readRadarNetworkId, resolveRadarNetwork, radarStoragePrefix, radarPoolKey } from "./arc-radar-networks.js";
import { initializeAdPreview } from "./arc-radar-ads.js";
import { readPoolRoute, readTokenRoute, marketUrl, resolveLinkedPool, recentWatchChanges, type CreationPage } from "./arc-radar-navigation.js";
import { observeSellEvents, groupTokenPools, type SellObservation } from "./arc-radar-market-tools.js";
import { holderShare, holderMetrics, knownTokenPools, windowPriceChange, tradeActor, sourceState, nextOwnershipSnapshot, type SourceState } from "./arc-radar-quality.js";
import { detectCapabilities, capabilityText, evidenceSummary, marketBriefs, nextWatchBatch, type CapabilityFinding, type EvidenceBasis } from "./arc-radar-evidence.js";
import { readAuthoritySnapshot, type AuthoritySnapshot } from "./arc-radar-authority.js";
import { copy, localize, initializeLanguage, type UiCopy } from "./arc-radar-i18n.js";
import { poolRef } from "./arc-radar-pool-id.js";
import { comparePricePoints } from "./arc-radar-v4.js";
import { validObservationTime, oldestFetchTime, priceFreshness } from "./arc-radar-freshness.js";
import { analyzeToken, formatAnalysisTime, type AnalysisOwnership } from "./arc-radar-analysis.js";
import { ObservationStore, observePool, observeOwnership, observationActivity, observationFresh, observationDelta, type ObservationSnapshot } from "./arc-radar-observations.js";
import { VENUE_REFERENCES, configuredVenue } from "./arc-radar-sources.js";
import { localRecorderAvailable, readRecorderSnapshot, type RecorderSnapshot } from "./arc-radar-recorder.js";
import { RpcMarketReader } from "./arc-radar-rpc.js";
import type { LaunchOrigin } from "./arc-radar-launch.js";
import { poolStatePrice, type PoolState } from "./arc-radar-pool-state.js";
import { createMarketChart } from "./arc-radar-chart.js";
import { createQuoteComparison } from "./arc-radar-quote-panel.js";
import { cachedPoolSeeds, dataCacheKey, usableCacheTime, writeMarketCache, rememberFactoryPage } from "./arc-radar-cached-markets.js";
import { TokenDirectory, tokenSearchUrl, type TokenIdentity } from "./arc-radar-token-search.js";
import { readMarketFeed, linkedMarketBundles, snapshotIsStale, type MarketBundle, type MarketFeed } from "./arc-radar-market-snapshot.js";
import { createElement as createIcon, RotateCcw, X } from "lucide";

let routeError = "";
const linkedPool = (() => {
  try { return readPoolRoute(new URL(location.href)); }
  catch (error) { routeError = error instanceof Error ? error.message : "Invalid pool link."; return null; }
})();
const linkedToken = (() => {
  try { return readTokenRoute(new URL(location.href)); }
  catch (error) { routeError = error instanceof Error ? error.message : "Invalid token link."; return null; }
})();

let networkError = "";
let requestedNetwork = "";
const NETWORK = (() => {
  try {
    requestedNetwork = readRadarNetworkId(new URL(location.href));
    const network = resolveRadarNetwork(requestedNetwork);
    network.sources.forEach(source => createDexAdapter(source, network));
    return network;
  }
  catch (error) { networkError = error instanceof Error ? error.message : "Network unavailable."; return null; }
})();
const dexAdapters = NETWORK ? NETWORK.sources.map(source => createDexAdapter(source, NETWORK)) : [];
const rpcReader = NETWORK?.dataMode === "rpc-dex" ? new RpcMarketReader(NETWORK) : null;
const localMarketMode = Boolean(rpcReader && localRecorderAvailable(new URL(location.href)) && !linkedPool && !linkedToken);
let localFeed: MarketFeed | null = null;
let linkedSnapshotMode = false;
let localSeedsQueued = false;
const adPreview = initializeAdPreview(Boolean(NETWORK));
const API_BASE = NETWORK?.apiBase ?? "";
const EXPLORER_BASE = NETWORK?.explorerBase ?? "";
const CACHE_PREFIX = NETWORK ? radarStoragePrefix(NETWORK) : "arcrow:unavailable:";
const WATCHLIST_STORAGE_KEY = `${CACHE_PREFIX}watchlist`;
const TRACKING_STORAGE_PREFIX = `${CACHE_PREFIX}tracking:pool:v1:`;
const tokenDirectory = (() => {
  if (!NETWORK) return null;
  const key = `${CACHE_PREFIX}token-directory:v1`;
  let storage: Pick<Storage, "getItem" | "setItem"> | null = null;
  try {
    const browserStorage = localStorage;
    storage = { getItem: name => browserStorage.getItem(name),
      setItem: (_name, value) => writeMarketCache(browserStorage, CACHE_PREFIX, "token-directory:v1", value) };
  } catch { /* Search still works for tokens seen in this tab. */ }
  const directory = new TokenDirectory(storage, key, NETWORK);
  if (!localMarketMode) {
    try { directory.importCache(localStorage, CACHE_PREFIX); } catch { /* Optional migration. */ }
  }
  return directory;
})();
const observations = (() => {
  let storage: Storage | null = null;
  try { if (NETWORK) storage = localStorage; } catch { /* Observations remain in memory. */ }
  return new ObservationStore(storage, `${CACHE_PREFIX}observations:v1`);
})();
const MARKET_LIMIT = rpcReader ? 8 : 15;
const MAX_MARKETS = 150;
const LOG_PAGE_LIMIT = 4;
const TRANSFER_PAGE_LIMIT = 3;
const DAY_MS = 86_400_000;
const DETAIL_CACHE_TTL_MS = 120_000;
const AUTO_REFRESH_MS = 60_000;
const BURN_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

type MarketFilter = "all" | "watchlist" | "active" | "new" | "sells" | "risky";
type WarningTone = "warning" | "info" | "good";
type PeriodKey = "m5" | "h1" | "h6" | "h24";
type WalletSignalCategory = "creator" | "whale" | "entry" | "exit";
type WalletSignalFilter = "all" | WalletSignalCategory;

type Token = {
  address_hash: string;
  decimals: string | null;
  holders_count: string | null;
  name: string | null;
  symbol: string | null;
  total_supply: string | null;
  type: string;
};

type AddressSummary = {
  hash?: string;
  is_contract?: boolean;
  is_verified?: boolean;
  name?: string | null;
};

type AddressDetails = {
  hash: string;
  implementations?: Array<{ address_hash?: string }>;
  is_verified?: boolean;
  proxy_type?: string | null;
};

type AbiEntry = {
  name?: string;
  stateMutability?: string;
  type?: string;
};

type ContractDetails = {
  abi?: AbiEntry[] | null;
  is_fully_verified?: boolean;
  is_verified?: boolean;
};

type TransactionDetails = {
  from?: AddressSummary;
};

type LogParameter = {
  name?: string;
  value?: string;
};

type AddressLog = {
  address?: { hash?: string };
  data?: string;
  topics?: Array<string | null>;
  block_number?: number;
  block_timestamp?: string;
  decoded?: { method_call?: string; parameters?: LogParameter[] } | null;
  index?: number;
  transaction_hash?: string;
};

type LogPageParams = Record<string, string | number>;
type LogResponse = { items?: AddressLog[]; next_page_params?: LogPageParams | null; partial?: boolean };
type TokenBalance = { token: Token; value: string };
type TokenHolder = { address?: AddressSummary; value: string };
type HolderResponse = { items?: TokenHolder[]; next_page_params?: LogPageParams | null };

type TokenTransfer = {
  from?: AddressSummary;
  log_index?: number;
  timestamp?: string;
  to?: AddressSummary;
  total?: { decimals?: string | null; value?: string | null };
  transaction_hash?: string;
  type?: string;
};

type TransferResponse = { items?: TokenTransfer[]; next_page_params?: LogPageParams | null };

type PairSeed = RadarPool;

type PricePoint = DexPricePoint;

type MarketTrade = DexTrade;

type LiquidityEvent = DexLiquidityEvent;

type PeriodMetrics = {
  buyCount: number;
  netFlowUsdc: number;
  priceChange: number | null;
  sellCount: number;
  swapCount: number;
  volumeUsdc: number;
};

type MarketPeriods = Record<PeriodKey, PeriodMetrics>;

type MarketPair = PairSeed & {
  periodsAsOf: number;
  priceEventAt: string | null;
  priceFetchedAt: number | null;
  priceStateAt?: string | null;
  priceStateBlock?: number;
  buyCount: number;
  currentPrice: number;
  fdv: number | null;
  historyTruncated: boolean;
  lastSellAt: string | null;
  lastTradeAt: string | null;
  liquidityEvents: LiquidityEvent[];
  periods: MarketPeriods;
  priceChange: number | null;
  pricePoints: PricePoint[];
  reserveSource: "sync" | "balance" | "v3" | "v4";
  sellCount: number;
  stale: boolean;
  swapCount: number;
  token: Token;
  tokenReserve: number | null;
  totalLiquidity: number | null;
  trades: MarketTrade[];
  usdcReserve: number | null;
  volumeUsdc: number;
};

type HolderPosition = {
  address: string;
  balance: number;
  isContract: boolean;
  isCreator: boolean;
  name: string | null;
  share: number | null;
};

type HolderConnection = {
  addressA: string;
  addressB: string;
  kind: "direct" | "shared-source";
  source: string | null;
  transactionHash: string | null;
};

type HolderCluster = {
  members: string[];
  share: number;
};

type ObservedAlert = {
  detail: string;
  observedAt: string;
  title: string;
  tone: "warning" | "info" | "good";
  type: "system" | "liquidity" | "price" | "holders" | "sell" | "ownership" | "lp";
};

type MarketSnapshot = {
  holderCount: number | null;
  price: number;
  sellCount: number;
  timestamp: string;
  usdcReserve: number | null;
};

type DetailSnapshot = {
  poolScope?: string;
  creatorShare: number | null;
  lpBurnedShare: number | null;
  timestamp: string;
  top10Share: number | null;
};

type TokenTracking = {
  sellObservation?: SellObservation;
  alerts: ObservedAlert[];
  detailSnapshot?: DetailSnapshot;
  marketSnapshot?: MarketSnapshot;
  startedAt: string;
};

type WalletSignal = {
  amount: number;
  categories: WalletSignalCategory[];
  detail: string;
  fromAddress: string;
  share: number | null;
  timestamp: string;
  title: string;
  toAddress: string;
  tone: "warning" | "info" | "good";
  transactionHash: string;
};

type MarketDetail = {
  analysisPrevious?: AnalysisOwnership;
  checkedAt: number;
  sources: { holders: SourceState; lp: SourceState; contract: SourceState; creator: SourceState; transfers: SourceState; senders: SourceState };
  holderHistoryPartial: boolean;
  lpHistoryPartial: boolean;
  poolScope: string;
  burnedTokenShare: number | null;
  capabilities: CapabilityFinding[];
  contractVisible: boolean;
  creatorShare: number | null;
  holderClusters: HolderCluster[];
  holderConnections: HolderConnection[];
  holderPositions: HolderPosition[];
  lpBurnedShare: number | null;
  lpTopHolderIsContract: boolean;
  lpTopHolderShare: number | null;
  poolShare: number | null;
  top1Share: number | null;
  top5Share: number | null;
  top10Share: number | null;
  transferHistoryTruncated: boolean;
  transactionSenders: Record<string, string>;
  walletSignals: WalletSignal[];
};

type RiskWarning = {
  basis: EvidenceBasis;
  detail: string | UiCopy;
  title: string;
  tone: WarningTone;
};

type CacheEntry<T> = { data: T; savedAt: number };
type FetchResult<T> = { data: T; stale: boolean; fetchedAt?: number };
type LogHistory = { items: AddressLog[]; stale: boolean; truncated: boolean; fetchedAt: number | null };
type TransferHistory = { items: TokenTransfer[]; stale: boolean; truncated: boolean };
type DetailCacheEntry = { data: MarketDetail; savedAt: number };

let markets: MarketPair[] = [];
const protocolMarketCache = new Map<string, MarketPair>();
let selectedPair = "";
let activeQuery = "";
let activeFilter: MarketFilter = "all";
let activeProtocol: RadarProtocolFilter = "all";
let marketLimit = MARKET_LIMIT;
let hasMoreMarkets = false;
let discoveryLimited = false;
let failedMarketCount = 0;
let marketLoadFailed = false;
const discoveryOptions: DiscoveryOptions = { sort: "volume", minimumLiquidity: 0, minimumFdv: 0, traded24h: false, sellSeen: false };
let activeWalletSignalFilter: WalletSignalFilter = "all";
let loading = false;
let searchGeneration = 0;
let pendingTokenSearch: { generation: number; tokens: TokenIdentity[]; background?: boolean } | null = null;
let rememberedMarketsQueued = false;
const tokenSearchStates = new Map<string, string>();
let detailRequest = 0;
let lastRefreshAt = 0;
let refreshCursor = 0;
let loadProgress = { completed: 0, total: 0, refreshing: false };
const discoveryPages = new Map<string, Promise<FetchResult<LogResponse>>>();
let watchlist = NETWORK ? readWatchlist() : new Set<string>();
const detailCache = new Map<string, DetailCacheEntry>();
const detailFlights = new Map<string, Promise<MarketDetail>>();
const authorityReads = new Map<string, { attemptedAt: number; snapshot?: AuthoritySnapshot; error?: string }>();
let authorityRunning = "";
let recorderRequest = 0;
let recorderDetailRequest = 0;
const watchCheckAttempts = new Map<string, number>();
let watchScanRunning = false;
let lastWatchScanAt = 0;
const trackingMemory = new Map<string, TokenTracking>();
let watchReviewedAt = (() => {
  if (!NETWORK || linkedPool || routeError) return null;
  try {
    const previous = Number(localStorage.getItem(`${CACHE_PREFIX}watch-reviewed-at`) ?? localStorage.getItem(`${CACHE_PREFIX}last-market-visit`));
    const now = Date.now();
    return previous > 0 && previous <= now ? previous : null;
  } catch { return null; }
})();

function byId<T extends Element = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as unknown as T;
}

function poolCacheKey(pool: PairSeed): string {
  if (!NETWORK) throw new Error(networkError);
  return radarPoolKey(NETWORK, poolRef(pool));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string | UiCopy): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) {
    if (typeof text === "string") node.textContent = text;
    else localize(node, text);
  }
  return node;
}

function setCopy(id: string, message: string | UiCopy): void {
  localize(byId(id), message);
}

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function shortHash(value: string | null | undefined, start = 7, end = 5): string {
  if (!value) return "--";
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function readCache<T>(key: string): CacheEntry<T> | null {
  try {
    const value = localStorage.getItem(`${CACHE_PREFIX}${key}`);
    return value ? JSON.parse(value) as CacheEntry<T> : null;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, data: T): void {
  try {
    writeMarketCache(localStorage, CACHE_PREFIX, key, JSON.stringify({ data, savedAt: Date.now() }));
    if (rpcReader) {
      const factory = dexAdapters.find(adapter => key === dataCacheKey(adapter.discoveryPath)
        || key.startsWith(`${dataCacheKey(adapter.discoveryPath)}-before-`) && !key.includes("-pool-"));
      if (factory && Array.isArray((data as LogResponse)?.items)) rememberFactoryPage(localStorage, CACHE_PREFIX, factory, data as LogResponse);
    }
  } catch {
    // Live data remains usable when browser storage is unavailable or full.
  }
}

function readWatchlist(): Set<string> {
  try {
    const legacy = NETWORK?.id === "arc-testnet" ? localStorage.getItem("arc-meme-radar:v1:watchlist") : null;
    const stored = JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? legacy ?? "[]") as unknown;
    if (!Array.isArray(stored)) return new Set();
    return new Set(stored.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase()));
  } catch {
    return new Set();
  }
}

function saveWatchlist(): void {
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify([...watchlist]));
  } catch {
    // Watchlist remains available for the current tab when storage is unavailable.
  }
}

function readTracking(address: string): TokenTracking | null {
  const memory = trackingMemory.get(address.toLowerCase());
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(`${TRACKING_STORAGE_PREFIX}${address.toLowerCase()}`);
    const value = raw ? JSON.parse(raw) as TokenTracking : null;
    if (!value || typeof value.startedAt !== "string" || !Array.isArray(value.alerts)) return null;
    if (value.sellObservation && !Array.isArray(value.sellObservation.seen)) value.sellObservation = undefined;
    if (value.detailSnapshot && !value.detailSnapshot.poolScope) value.detailSnapshot = undefined;
    value.alerts = value.alerts.filter(alert => alert && typeof alert.title === "string" && typeof alert.detail === "string"
      && typeof alert.observedAt === "string" && ["warning", "info", "good"].includes(alert.tone)).slice(0, 30);
    trackingMemory.set(address.toLowerCase(), value);
    return value;
  } catch {
    return null;
  }
}

function saveTracking(address: string, tracking: TokenTracking): void {
  trackingMemory.set(address.toLowerCase(), tracking);
  try {
    localStorage.setItem(`${TRACKING_STORAGE_PREFIX}${address.toLowerCase()}`, JSON.stringify(tracking));
  } catch {
    // Tracking continues in memory through the current render when storage is unavailable.
  }
}

function appendObservedAlerts(tracking: TokenTracking, alerts: ObservedAlert[]): void {
  if (alerts.length === 0) return;
  tracking.alerts = [...alerts, ...(tracking.alerts ?? [])].slice(0, 30);
}

const dataFlights = new Map<string, Promise<FetchResult<unknown>>>();
function fetchData<T>(path: string, ttlMs: number, force = false): Promise<FetchResult<T>> {
  const key = `${path}:${ttlMs}:${force}`;
  const active = dataFlights.get(key);
  if (active) return active as Promise<FetchResult<T>>;
  const request = readData<T>(path, ttlMs, force).finally(() => dataFlights.delete(key));
  dataFlights.set(key, request);
  return request;
}

async function readData<T>(path: string, ttlMs: number, force = false): Promise<FetchResult<T>> {
  if (!NETWORK) throw new Error(networkError);
  const key = path.replace(/[^a-z0-9]+/gi, "-");
  const cached = readCache<T>(key);
  if (!force && cached && Date.now() - cached.savedAt >= 0 && Date.now() - cached.savedAt < ttlMs) return { data: cached.data, stale: false, fetchedAt: cached.savedAt };
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), rpcReader ? 20_000 : 12_000);
  try {
    let data: T;
    if (rpcReader) data = await rpcReader.read(path, controller.signal) as T;
    else {
      const response = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`ArcScan returned HTTP ${response.status}`);
      data = await response.json() as T;
    }
    if (/\/logs(?:\?|$)/.test(path) && (!data || !Array.isArray((data as { items?: unknown }).items))) {
      throw new Error("Invalid indexed log response.");
    }
    writeCache(key, data);
    return { data, stale: false, fetchedAt: Date.now() };
  } catch (error) {
    if (cached) return { data: cached.data, stale: true, fetchedAt: cached.savedAt };
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchOptional<T>(path: string, ttlMs: number, force = false): Promise<FetchResult<T> | null> {
  try {
    return await fetchData<T>(path, ttlMs, force);
  } catch {
    return null;
  }
}

function readCachedData<T>(path: string): FetchResult<T> {
  const cached = readCache<T>(dataCacheKey(path));
  if (!cached || !usableCacheTime(cached.savedAt)) throw new Error("No recent saved market data.");
  return { data: cached.data, stale: true, fetchedAt: cached.savedAt };
}

async function fetchAddressLogs(address: string, ttlMs: number, force: boolean, cutoffMs: number, poolId?: string, pageLimit = LOG_PAGE_LIMIT, cachedOnly = false): Promise<LogHistory> {
  const items: AddressLog[] = [];
  const fetchedAt: Array<number | undefined> = [];
  const seen = new Set<string>();
  const pages = new Set<string>();
  let nextPath = `/addresses/${address}/logs${rpcReader && poolId ? `?pool=${poolId}` : ""}`;
  let stale = false;
  let truncated = false;
  for (let page = 0; page < pageLimit; page += 1) {
    if (pages.has(nextPath)) { truncated = true; break; }
    pages.add(nextPath);
    let result: FetchResult<LogResponse>;
    try { result = cachedOnly ? readCachedData<LogResponse>(nextPath) : await fetchData<LogResponse>(nextPath, ttlMs, force); }
    catch (error) {
      if (!cachedOnly || page === 0) throw error;
      truncated = true; break;
    }
    if (!Array.isArray(result.data.items)) throw new Error("Invalid indexed log response.");
    truncated ||= result.data.partial === true;
    fetchedAt.push(result.fetchedAt);
    stale ||= result.stale;
    for (const log of result.data.items ?? []) {
      if (!log.transaction_hash || !Number.isSafeInteger(log.index) || log.index! < 0) {
        truncated = true;
        continue;
      }
      const key = `${log.transaction_hash.toLowerCase()}:${log.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(log);
    }
    const oldestTimestamp = items.at(-1)?.block_timestamp;
    if (oldestTimestamp && new Date(oldestTimestamp).getTime() <= cutoffMs) break;
    const next = result.data.next_page_params;
    if (!next) break;
    if (page === pageLimit - 1) {
      truncated = true;
      break;
    }
    const query = new URLSearchParams(Object.entries(next).map(([name, value]) => [name, String(value)])).toString();
    nextPath = `/addresses/${address}/logs?${query}`;
  }
  return { items, stale, truncated, fetchedAt: oldestFetchTime(fetchedAt, Date.now()) };
}

async function fetchTokenTransfers(address: string, force: boolean): Promise<TransferHistory> {
  const items: TokenTransfer[] = [];
  const seen = new Set<string>();
  let nextPath = `/tokens/${address}/transfers`;
  let stale = false;
  let truncated = false;
  for (let page = 0; page < TRANSFER_PAGE_LIMIT; page += 1) {
    const result = await fetchData<TransferResponse>(nextPath, 120_000, force);
    stale ||= result.stale;
    for (const transfer of result.data.items ?? []) {
      const key = `${transfer.transaction_hash ?? ""}:${transfer.log_index ?? ""}:${transfer.type ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(transfer);
    }
    const next = result.data.next_page_params;
    if (!next) break;
    if (page === TRANSFER_PAGE_LIMIT - 1) {
      truncated = true;
      break;
    }
    const query = new URLSearchParams(Object.entries(next).map(([name, value]) => [name, String(value)])).toString();
    nextPath = `/tokens/${address}/transfers?${query}`;
  }
  items.sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime());
  return { items, stale, truncated };
}

function fullNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(number);
}

function formatValue(value: number | null, maximumFractionDigits = 2): string {
  if (value === null || !Number.isFinite(value)) return "--";
  if (value >= 1_000) return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
  if (value > 0 && value < 0.01) return "<0.01";
  return new Intl.NumberFormat("en", { maximumFractionDigits }).format(value);
}

interface PriceFormat {
  full: string;
  leadingZeros: number | null;
  significant: string;
  text: string;
}

const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

function subscriptNumber(value: number): string {
  return String(value).split("").map((digit) => SUBSCRIPT_DIGITS[Number(digit)]).join("");
}

function formatFullPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "--";
  const exponent = Math.floor(Math.log10(value));
  const fractionDigits = exponent < 0 ? Math.min(20, Math.max(9, -exponent + 5)) : 4;
  return value.toLocaleString("en", { maximumFractionDigits: fractionDigits });
}

function priceFormat(value: number): PriceFormat {
  if (!Number.isFinite(value) || value <= 0) return { full: "--", leadingZeros: null, significant: "", text: "--" };
  const full = formatFullPrice(value);
  if (value >= 1) {
    const text = value.toLocaleString("en", { maximumFractionDigits: 4 });
    return { full, leadingZeros: null, significant: "", text };
  }
  if (value >= 0.01) {
    const text = value.toLocaleString("en", { maximumFractionDigits: 6 });
    return { full, leadingZeros: null, significant: "", text };
  }
  if (value >= 0.0001) {
    const text = value.toLocaleString("en", { maximumFractionDigits: 9 });
    return { full, leadingZeros: null, significant: "", text };
  }

  const [coefficient, exponentText] = value.toExponential(3).split("e");
  const leadingZeros = Math.max(1, -Number(exponentText) - 1);
  const significant = coefficient.replace(".", "").replace(/0+$/, "");
  return {
    full,
    leadingZeros,
    significant,
    text: `0.0${subscriptNumber(leadingZeros)}${significant}`,
  };
}

function formatPrice(value: number): string {
  return priceFormat(value).text;
}

function priceElement(value: number, includeUnit = false): HTMLElement {
  const formatted = priceFormat(value);
  const node = element("strong", "price-value");
  if (formatted.leadingZeros === null) {
    node.textContent = formatted.text;
  } else {
    node.append("0.0", element("sub", "price-zero-count", String(formatted.leadingZeros)), formatted.significant);
  }
  if (includeUnit) node.append(element("span", "price-unit", "USDC"));
  node.title = formatted.full === "--" ? "Price unavailable" : `${formatted.full} USDC`;
  node.setAttribute("aria-label", formatted.full === "--" ? "Price unavailable" : `${formatted.full} USDC`);
  return node;
}

function formatChange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "No price history";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function compactChange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatSignedUsdc(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.0005) return "0 USDC";
  return `${value > 0 ? "+" : "-"}${formatValue(Math.abs(value), 3)} USDC`;
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return "--";
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}

function adapterFor(pool: PairSeed) {
  const adapter = dexAdapters.find(entry => entry.source.id === pool.sourceId);
  if (!adapter) throw new Error("Unknown DEX source");
  return adapter;
}

function periodMetrics(trades: MarketTrade[], pricePoints: PricePoint[], currentPrice: number, durationMs: number, nowMs: number): PeriodMetrics {
  const cutoff = nowMs - durationMs;
  const windowTrades = trades.filter((trade) => new Date(trade.timestamp).getTime() >= cutoff);
  const buys = windowTrades.filter((trade) => trade.direction === "buy");
  const sells = windowTrades.filter((trade) => trade.direction === "sell");
  return {
    buyCount: buys.length,
    netFlowUsdc: buys.reduce((sum, trade) => sum + trade.usdcValue, 0) - sells.reduce((sum, trade) => sum + trade.usdcValue, 0),
    priceChange: windowPriceChange(pricePoints, currentPrice, cutoff),
    sellCount: sells.length,
    swapCount: windowTrades.length,
    volumeUsdc: windowTrades.reduce((sum, trade) => sum + trade.usdcValue, 0),
  };
}

function marketPeriods(trades: MarketTrade[], pricePoints: PricePoint[], currentPrice: number, nowMs: number): MarketPeriods {
  return {
    m5: periodMetrics(trades, pricePoints, currentPrice, 5 * 60_000, nowMs),
    h1: periodMetrics(trades, pricePoints, currentPrice, 60 * 60_000, nowMs),
    h6: periodMetrics(trades, pricePoints, currentPrice, 6 * 60 * 60_000, nowMs),
    h24: periodMetrics(trades, pricePoints, currentPrice, DAY_MS, nowMs),
  };
}

function snapshotForMarket(market: MarketPair): MarketSnapshot {
  const holderCount = market.token.holders_count === null ? null : Number(market.token.holders_count);
  return {
    holderCount: holderCount !== null && Number.isFinite(holderCount) ? holderCount : null,
    price: market.currentPrice,
    sellCount: market.sellCount,
    timestamp: new Date().toISOString(),
    usdcReserve: market.usdcReserve,
  };
}

function startTracking(market: MarketPair): TokenTracking {
  const now = new Date().toISOString();
  const tracking: TokenTracking = readTracking(poolRef(market)) ?? {
    alerts: [],
    startedAt: now,
  };
  if (!tracking.marketSnapshot) {
    tracking.marketSnapshot = snapshotForMarket(market);
    appendObservedAlerts(tracking, [{
      detail: "A local market and risk baseline was recorded for this token.",
      observedAt: now,
      title: "Watch started",
      tone: "info",
      type: "system",
    }]);
  }
  if (!tracking.sellObservation) tracking.sellObservation = observeSellEvents(market.trades).state;
  saveTracking(poolRef(market), tracking);
  return tracking;
}

function observeMarketChanges(market: MarketPair): void {
  if (market.stale || !watchlist.has(market.tokenAddress.toLowerCase())) return;
  const tracking = readTracking(poolRef(market)) ?? startTracking(market);
  const previous = tracking.marketSnapshot;
  const next = snapshotForMarket(market);
  if (!previous) {
    tracking.marketSnapshot = next;
    saveTracking(poolRef(market), tracking);
    return;
  }

  const alerts: ObservedAlert[] = [];
  const observedAt = next.timestamp;
  if (previous.usdcReserve !== null && next.usdcReserve !== null && previous.usdcReserve > 0) {
    const reserveChange = ((next.usdcReserve - previous.usdcReserve) / previous.usdcReserve) * 100;
    if (Math.abs(reserveChange) >= 10 && Math.abs(next.usdcReserve - previous.usdcReserve) >= 0.001) {
      alerts.push({
        detail: `USDC exit-side changed from ${formatValue(previous.usdcReserve, 3)} to ${formatValue(next.usdcReserve, 3)} (${reserveChange > 0 ? "+" : ""}${reserveChange.toFixed(1)}%).`,
        observedAt,
        title: reserveChange < 0 ? "Liquidity dropped" : "Liquidity increased",
        tone: reserveChange < 0 ? "warning" : "good",
        type: "liquidity",
      });
    }
  }
  if (previous.price > 0 && next.price > 0) {
    const priceChange = ((next.price - previous.price) / previous.price) * 100;
    if (Math.abs(priceChange) >= 30) {
      alerts.push({
        detail: `Pool price moved ${priceChange > 0 ? "+" : ""}${priceChange.toFixed(1)}% from the previous observed baseline.`,
        observedAt,
        title: priceChange < 0 ? "Price moved sharply down" : "Price moved sharply up",
        tone: priceChange < 0 ? "warning" : "info",
        type: "price",
      });
    }
  }
  if (next.holderCount !== null && previous.holderCount !== null && next.holderCount !== previous.holderCount) {
    const difference = next.holderCount - previous.holderCount;
    alerts.push({
      detail: `Indexed holder count changed from ${fullNumber(previous.holderCount)} to ${fullNumber(next.holderCount)}.`,
      observedAt,
      title: difference > 0 ? `${difference} holder${difference === 1 ? "" : "s"} added` : `${Math.abs(difference)} holder${difference === -1 ? "" : "s"} left`,
      tone: difference > 0 ? "good" : "warning",
      type: "holders",
    });
  }
  const sellObservation = observeSellEvents(market.trades, tracking.sellObservation);
  tracking.sellObservation = sellObservation.state;
  if (sellObservation.added > 0) {
    const difference = sellObservation.added;
    alerts.push({
      detail: `${difference} previously unseen token-to-USDC sell event${difference === 1 ? " was" : "s were"} found in the available indexed history. This may include delayed indexing.`,
      observedAt,
      title: "Newly observed sell events",
      tone: "info",
      type: "sell",
    });
  }
  appendObservedAlerts(tracking, alerts);
  tracking.marketSnapshot = next;
  saveTracking(poolRef(market), tracking);
}

function observeDetailChanges(market: MarketPair, detail: MarketDetail): void {
  if (market.stale || Date.now() - detail.checkedAt >= DETAIL_CACHE_TTL_MS || !watchlist.has(market.tokenAddress.toLowerCase())) return;
  const tracking = readTracking(poolRef(market)) ?? startTracking(market);
  const previous = tracking.detailSnapshot;
  const { next, comparable } = nextOwnershipSnapshot(previous, {
    creatorShare: detail.creatorShare,
    lpBurnedShare: detail.lpBurnedShare,
    timestamp: new Date().toISOString(),
    top10Share: detail.top10Share,
    poolScope: detail.poolScope,
  }, {
    creatorShare: detail.sources.holders === "fresh" && detail.sources.creator === "fresh",
    lpBurnedShare: detail.sources.lp === "fresh",
    top10Share: detail.sources.holders === "fresh",
  });
  if (previous) {
    const alerts: ObservedAlert[] = [];
    if (comparable.top10Share && previous.top10Share !== null && next.top10Share !== null && Math.abs(next.top10Share - previous.top10Share) >= 3) {
      const difference = next.top10Share - previous.top10Share;
      alerts.push({
        detail: `Top 10 non-pool ownership changed from ${shareText(previous.top10Share)} to ${shareText(next.top10Share)}.`,
        observedAt: next.timestamp,
        title: difference > 0 ? "Holder concentration increased" : "Holder concentration decreased",
        tone: difference > 0 ? "warning" : "good",
        type: "ownership",
      });
    }
    if (comparable.creatorShare && previous.creatorShare !== null && next.creatorShare !== null && Math.abs(next.creatorShare - previous.creatorShare) >= 1) {
      const difference = next.creatorShare - previous.creatorShare;
      alerts.push({
        detail: `Pool-creation sender holding changed from ${shareText(previous.creatorShare)} to ${shareText(next.creatorShare)}. This sender is not necessarily the token team.`,
        observedAt: next.timestamp,
        title: difference < 0 ? "Creation sender reduced holdings" : "Creation sender holdings increased",
        tone: difference < 0 ? "warning" : "info",
        type: "ownership",
      });
    }
    if (comparable.lpBurnedShare && previous.lpBurnedShare !== null && next.lpBurnedShare !== null && Math.abs(next.lpBurnedShare - previous.lpBurnedShare) >= 1) {
      const difference = next.lpBurnedShare - previous.lpBurnedShare;
      alerts.push({
        detail: `LP tokens held by burn addresses changed from ${shareText(previous.lpBurnedShare)} to ${shareText(next.lpBurnedShare)}.`,
        observedAt: next.timestamp,
        title: difference > 0 ? "More LP tokens burned" : "Burned LP share decreased",
        tone: difference > 0 ? "good" : "warning",
        type: "lp",
      });
    }
    appendObservedAlerts(tracking, alerts);
  }
  tracking.detailSnapshot = next;
  saveTracking(poolRef(market), tracking);
}

async function mapLimited<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return output;
}

async function loadMarketPair(seed: PairSeed, force: boolean, options: { cachedOnly?: boolean; quick?: boolean; snapshot?: MarketBundle } = {}): Promise<MarketPair | null> {
  try {
    const adapter = adapterFor(seed);
    const cutoffMs = Math.max(Date.now() - DAY_MS, Date.parse(seed.createdAt) || 0);
    const saved = options.snapshot;
    const [tokenResult, logResult] = saved ? [
      { data: saved.token, fetchedAt: saved.fetchedAt, stale: snapshotIsStale(saved.fetchedAt) },
      { items: saved.logs, fetchedAt: saved.fetchedAt, stale: snapshotIsStale(saved.fetchedAt), truncated: true },
    ] : await Promise.all([
      options.cachedOnly ? readCachedData<Token>(`/tokens/${seed.tokenAddress}`) : fetchData<Token>(`/tokens/${seed.tokenAddress}`, 300_000, force),
      fetchAddressLogs(seed.pairAddress, 30_000, force, cutoffMs, seed.v4?.poolId, options.quick ? 1 : undefined, options.cachedOnly),
    ]);
    const token = tokenResult.data;
    if (options.cachedOnly && (!token || token.address_hash?.toLowerCase() !== seed.tokenAddress.toLowerCase()
      || ![token.name, token.symbol].every(value => value === null || typeof value === "string" && value.length <= 120)
      || !(token.decimals === null || typeof token.decimals === "string" && /^\d{1,3}$/.test(token.decimals) && Number(token.decimals) <= 255)
      || !(token.total_supply === null || typeof token.total_supply === "string" && /^\d{1,78}$/.test(token.total_supply)))) return null;
    tokenDirectory?.remember(token, tokenResult.fetchedAt ?? Date.now(), poolRef(seed), !saved);
    let stateResult: FetchResult<PoolState> | null = null;
    if (rpcReader && (seed.v3 || seed.v4)) {
      const path = `/pools/${seed.pairAddress}/state${seed.v4 ? `?pool=${seed.v4.poolId}` : ""}`;
      if (saved) stateResult = { data: saved.state, fetchedAt: saved.fetchedAt, stale: snapshotIsStale(saved.fetchedAt) };
      else if (options.cachedOnly) {
        try { stateResult = readCachedData<PoolState>(path); } catch { /* Old caches may not have a state quote yet. */ }
      } else stateResult = await fetchOptional<PoolState>(path, 30_000, force);
    }
    const nowMs = saved?.fetchedAt ?? Date.now();
    const logs = logResult.items.filter(log => validObservationTime(log.block_timestamp, nowMs));
    let priceFetchedAt = oldestFetchTime([logResult.fetchedAt, tokenResult.fetchedAt], nowMs);
    const latestSync = adapter.latestReserves(logs, seed, token.decimals);
    let tokenReserve: number | null = latestSync?.tokenReserve ?? null;
    let usdcReserve: number | null = latestSync?.usdcReserve ?? null;
    let balanceStale = false;
    const reserveSource: MarketPair["reserveSource"] = seed.v4 ? "v4" : seed.v3 ? "v3" : latestSync ? "sync" : "balance";
    if (!latestSync && !seed.v4 && !seed.v3) {
      const balanceResult = await fetchData<TokenBalance[]>(`/addresses/${seed.pairAddress}/token-balances`, 30_000, force);
      const tokenBalance = balanceResult.data.find((balance) => balance.token.address_hash.toLowerCase() === seed.tokenAddress.toLowerCase());
      const usdcBalance = balanceResult.data.find((balance) => balance.token.address_hash.toLowerCase() === seed.quoteAsset.address.toLowerCase());
      tokenReserve = tokenBalance ? decimalValue(tokenBalance.value, tokenBalance.token.decimals) : null;
      usdcReserve = usdcBalance ? decimalValue(usdcBalance.value, usdcBalance.token.decimals) : null;
      balanceStale = balanceResult.stale;
      priceFetchedAt = oldestFetchTime([balanceResult.fetchedAt, tokenResult.fetchedAt], Date.now());
    }
    const trades = logs
      .map((log) => adapter.trade(log, seed))
      .filter((trade): trade is MarketTrade => trade !== null)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || (b.eventIndex ?? 0) - (a.eventIndex ?? 0));
    const buys = trades.filter((trade) => trade.direction === "buy");
    const sells = trades.filter((trade) => trade.direction === "sell");
    const liquidityEvents = adapter.liquidityEvents(logs, seed, token.decimals);
    const pricePoints = logs
      .map((log) => adapter.pricePoint(log, seed, token.decimals))
      .filter((point): point is PricePoint => point !== null)
      .sort(comparePricePoints);
    const statePrice = poolStatePrice(stateResult?.data, seed, token.decimals, nowMs);
    // A state quote is not a swap: never append it to the trade/chart history.
    // Older cached state must not replace a newer observed event.
    const useState = statePrice !== null && Date.parse(stateResult!.data.timestamp) >= (Date.parse(pricePoints.at(-1)?.timestamp ?? "") || 0);
    const currentPrice = useState ? statePrice : seed.v4 || seed.v3 ? pricePoints.at(-1)?.price ?? 0
      : tokenReserve !== null && tokenReserve > 0 && usdcReserve !== null ? usdcReserve / tokenReserve : 0;
    if (useState) priceFetchedAt = oldestFetchTime([stateResult!.fetchedAt, tokenResult.fetchedAt], nowMs);
    const firstPrice = pricePoints[0]?.price;
    const priceChange = firstPrice && currentPrice ? ((currentPrice - firstPrice) / firstPrice) * 100 : null;
    const market: MarketPair = {
      ...seed,
      periodsAsOf: nowMs,
      priceEventAt: useState || reserveSource === "balance" || currentPrice <= 0 ? null : latestSync?.timestamp ?? pricePoints.at(-1)?.timestamp ?? null,
      priceFetchedAt,
      priceStateAt: useState ? stateResult!.data.timestamp : null,
      ...(useState ? { priceStateBlock: stateResult!.data.blockNumber } : {}),
      buyCount: buys.length,
      currentPrice,
      fdv: fullyDilutedValue(currentPrice, token.total_supply, token.decimals),
      historyTruncated: logResult.truncated || logs.length !== logResult.items.length || (adapter.historyIncomplete?.(logs) ?? false),
      lastSellAt: sells[0]?.timestamp ?? null,
      lastTradeAt: trades[0]?.timestamp ?? null,
      liquidityEvents,
      periods: marketPeriods(trades, pricePoints, currentPrice, nowMs),
      priceChange,
      pricePoints,
      reserveSource,
      sellCount: sells.length,
      stale: tokenResult.stale || logResult.stale || balanceStale || Boolean(useState && stateResult!.stale),
      swapCount: trades.length,
      token,
      tokenReserve,
      totalLiquidity: usdcReserve === null ? null : usdcReserve * 2,
      trades,
      usdcReserve,
      volumeUsdc: trades.reduce((sum, trade) => sum + trade.usdcValue, 0),
    };
    if (!options.cachedOnly) {
      observeMarketChanges(market);
      const observation = observePool(poolCacheKey(market), market, observations.get(poolCacheKey(market)));
      if (observation) observations.set(observation);
    }
    return market;
  } catch {
    return null;
  }
}

function needsReview(market: MarketPair): boolean {
  return market.sellCount === 0 || market.usdcReserve === null || market.usdcReserve < 10;
}

function priceAgeCopy(market: MarketPair): UiCopy {
  if (market.priceStateAt) return copy("Pool quote {time} ago · block {block}", { time: relativeTime(market.priceStateAt), block: fullNumber(market.priceStateBlock) });
  const state = priceFreshness(market.priceEventAt, market.reserveSource, Date.now());
  if (state === "balance") return copy("Balance estimate; price event unknown");
  if (state === "unknown") return copy("Price event time unavailable");
  return copy(state === "old" ? "Last price event {time} ago · over 15m" : "Last price event {time} ago", { time: relativeTime(market.priceEventAt) });
}

function marketCandidates(): MarketPair[] {
  const query = activeQuery.normalize("NFKC").toLowerCase();
  const matching = markets.filter((market) => {
    const matchesQuery = !query || [market.token.name, market.token.symbol, market.tokenAddress, poolRef(market)]
      .some((value) => value?.normalize("NFKC").toLowerCase().includes(query));
    return matchesQuery;
  });
  // All metric filters use the same displayed representative. Tightening a
  // filter must not substitute a different pool with a more flattering FDV.
  return groupTokenPools(matching).map(group => group.primary);
}

function visibleMarkets(): MarketPair[] {
  const now = Date.now();
  const filtered = marketCandidates().filter((market) => {
    if (activeFilter === "watchlist") return watchlist.has(market.tokenAddress.toLowerCase());
    if (activeFilter === "active") return market.periods.h24.swapCount > 0;
    if (activeFilter === "new") { const age = now - Date.parse(market.createdAt); return age >= 0 && age <= 7 * 86_400_000; }
    if (activeFilter === "sells") return market.sellCount > 0;
    if (activeFilter === "risky") return needsReview(market);
    return true;
  });
  return refineMarkets(filtered.sort((a, b) => {
    if (activeFilter === "active") return b.periods.h24.volumeUsdc - a.periods.h24.volumeUsdc
      || b.periods.h24.swapCount - a.periods.h24.swapCount
      || new Date(b.lastTradeAt ?? 0).getTime() - new Date(a.lastTradeAt ?? 0).getTime();
    if (activeFilter === "sells") return b.sellCount - a.sellCount;
    if (activeFilter === "risky") return (a.usdcReserve ?? -1) - (b.usdcReserve ?? -1);
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  }), discoveryOptions);
}

function renderMarketSummary(): void {
  const representatives = marketCandidates();
  const valuations = representatives.filter(market => market.fdv !== null && Number.isFinite(market.fdv) && market.fdv >= 0);
  const known = valuations.length;
  setCopy("fdvCoverage", copy("Loaded tokens: {known}/{total} have FDV · {unknown} unknown", { known, total: representatives.length, unknown: representatives.length - known }));
  const minimum = discoveryOptions.minimumFdv ?? 0;
  setCopy("filterResultSummary", copy("All selected conditions: {shown}/{total} tokens", { shown: visibleMarkets().length, total: representatives.length }));
  setCopy("fdvFilterSummary", minimum > 0 ? copy("FDV ≥ {minimum}: {passed} pass · {below} below · {unknown} unknown excluded · other filters also apply", {
    minimum: formatValue(minimum), passed: valuations.filter(market => market.fdv! >= minimum).length,
    below: valuations.filter(market => market.fdv! < minimum).length, unknown: representatives.length - known,
  }) : "");
  const liquidityKnown = representatives.filter(market => market.totalLiquidity !== null && Number.isFinite(market.totalLiquidity)).length;
  setCopy("liquidityFilterSummary", discoveryOptions.minimumLiquidity > 0 && liquidityKnown === 0
    ? "Liquidity is unknown for these markets, not zero. A positive minimum excludes them all." : "");
  if (marketLoadFailed && markets.length === 0) {
    setCopy("marketSummary", "Market activity is unknown because pool data could not be loaded.");
    return;
  }
  const shown = visibleMarkets();
  const trades = shown.reduce((sum, market) => sum + market.swapCount, 0);
  const liquidity = shown.some(market => market.totalLiquidity === null) ? null : shown.reduce((sum, market) => sum + market.totalLiquidity!, 0);
  const partial = shown.filter((market) => market.historyTruncated).length;
  setCopy("marketSummary", copy("{tokens} tokens · {pools} loaded pools · representative pools: {trades} indexed swaps · {liquidity} USDC liquidity · {partial} partial histories", { tokens: shown.length, pools: markets.length, trades, liquidity: formatValue(liquidity), partial }));
}

function renderDiscoveryControls(): void {
  renderProtocolControls();
  const button = byId<HTMLButtonElement>("loadMoreMarkets");
  const atLimit = marketLimit >= MAX_MARKETS || (Boolean(rpcReader) && markets.length >= MAX_MARKETS);
  button.disabled = loading || (!marketLoadFailed && (!hasMoreMarkets || atLimit));
  localize(button, loading ? loadingCopy() : marketLoadFailed ? "Retry loading"
    : hasMoreMarkets && !atLimit ? rpcReader ? "Load 8 more pools" : "Load 15 more"
    : discoveryLimited || atLimit ? "Scan limit reached" : "No more pools");
  setCopy("discoveryCoverage", copy("{pools} pools loaded · {sources} {network} USDC market sources{limit}", { pools: markets.length, sources: selectDexAdapters(dexAdapters, activeProtocol).length, network: NETWORK?.label ?? "",
    limit: copy("{scan}{cap}{failed}", { scan: copy(discoveryLimited ? " · Scan limit reached" : ""), cap: copy(atLimit && hasMoreMarkets ? " · 150-pool limit" : ""), failed: copy(failedMarketCount ? " · {count} unavailable" : "", { count: failedMarketCount }) }) }));
  renderCoverage();
}

function renderProtocolControls(): void {
  const available = !linkedPool && !linkedToken && !routeError && new Set(dexAdapters.map(adapter => adapter.source.protocol)).size > 1;
  byId("protocolControls").classList.toggle("hidden", !available);
  document.querySelectorAll<HTMLButtonElement>("[data-protocol-filter]").forEach(button => {
    const protocol = button.dataset.protocolFilter as RadarProtocolFilter;
    const active = protocol === activeProtocol;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = loading || !selectDexAdapters(dexAdapters, protocol).length;
  });
  const version = activeProtocol === "all" ? copy("All versions") : activeProtocol === "uniswap-v3" ? "Uniswap V3" : "Uniswap V4";
  setCopy("protocolScope", loading ? copy("{version} · {count} loaded pools · {progress}", { version, count: markets.length, progress: loadingCopy() }) : copy("{version} · {count} loaded pools", { version, count: markets.length }));
}

function loadingCopy(): UiCopy {
  return loadProgress.total > 0 ? copy(loadProgress.refreshing ? "Updating {done}/{total}" : "Reading {done}/{total}", { done: loadProgress.completed, total: loadProgress.total })
    : copy(loadProgress.refreshing ? "Updating loaded pools..." : "Finding pool addresses...");
}

async function applyProtocol(protocol: RadarProtocolFilter): Promise<void> {
  if (loading || linkedPool || linkedToken || !NETWORK || routeError || protocol === activeProtocol
    || !["all", "uniswap-v3", "uniswap-v4"].includes(protocol) || !selectDexAdapters(dexAdapters, protocol).length) return;
  for (const market of markets) protocolMarketCache.set(poolRef(market), market);
  while (protocolMarketCache.size > MAX_MARKETS) protocolMarketCache.delete(protocolMarketCache.keys().next().value!);
  activeProtocol = protocol;
  if (localMarketMode) {
    selectedPair = "";
    detailRequest++;
    setDetailState("empty");
    await loadDashboard();
    return;
  }
  searchGeneration++;
  pendingTokenSearch = null;
  tokenSearchStates.clear();
  rememberedMarketsQueued = false;
  marketLimit = MARKET_LIMIT;
  discoveryPages.clear();
  refreshCursor = 0;
  const sources = new Set(selectDexAdapters(dexAdapters, protocol).map(adapter => adapter.source.id));
  markets = [...protocolMarketCache.values()].filter(market => sources.has(market.sourceId));
  selectedPair = "";
  hasMoreMarkets = false;
  discoveryLimited = false;
  failedMarketCount = 0;
  marketLoadFailed = false;
  detailRequest += 1;
  setDetailState("empty");
  if (markets.length) {
    marketLimit = Math.min(MAX_MARKETS, Math.max(MARKET_LIMIT, markets.length));
    hasMoreMarkets = markets.length < MAX_MARKETS;
    discoveryLimited = true;
    applyFilter(activeFilter);
    renderDiscoveryControls();
    if (activeQuery) queueTokenSearch(activeQuery);
    return;
  }
  renderMarketRows();
  if (!markets.length) {
    byId("marketRows").replaceChildren(element("div", "market-loading-row", copy("Loading indexed pools...")));
    setCopy("marketSummary", "Loading indexed pools...");
  }
  setCopy("pulseStatus", "Loading indexed pools...");
  for (const id of ["pulseVolume", "pulseTrades", "pulseNetFlow", "pulseNewest", "pulseNewestAge", "pulseSellVerified"]) byId(id).textContent = "--";
  await restoreCachedMarkets();
  await loadDashboard();
  if (activeQuery) queueTokenSearch(activeQuery);
}

function renderCoverage(): void {
  const cached = markets.filter(market => market.stale).length;
  const partial = markets.filter(market => market.historyTruncated).length;
  setCopy("coverageSummary", copy("{network} · {sources} configured DEX source(s) · {pools} loaded pools · Not the whole chain", { network: NETWORK?.label ?? "--", sources: dexAdapters.length, pools: markets.length }));
  setCopy("coverageStatus", copy("{cached} cached · {partial} partial histories{failed}", { cached, partial, failed: copy(marketLoadFailed ? " · Refresh failed" : "") }));
  const sources = byId("coverageSources");
  sources.replaceChildren();
  for (const adapter of dexAdapters) {
    const link = element("a", "", `${adapter.source.label} · ${adapter.source.protocol} · ${shortHash(adapter.source.factoryAddress)}`);
    link.href = `${EXPLORER_BASE}/address/${adapter.source.factoryAddress}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    sources.append(link);
  }
  renderVenueRegistry();
}

function renderVenueRegistry(): void {
  const list = byId("venueRegistry"); list.replaceChildren();
  for (const venue of VENUE_REFERENCES) {
    const row = element("div", "venue-registry-row");
    const info = element("div", ""); info.append(element("strong", "", venue.name), element("small", "", copy("{network} · {kind}", {
      network: venue.network === "arc-mainnet" ? "Arc Mainnet" : "Arc Testnet", kind: copy(venue.kind === "dex" ? "DEX" : "Launchpad"),
    })));
    const configured = NETWORK && venue.sourceId && configuredVenue(NETWORK, venue.sourceId);
    const evidence = element("div", "");
    evidence.append(element("span", "", copy(configured ? "Configured data feed" : venue.status === "configured" ? "Available on another network" : "Announced; not connected")), element("small", "", copy(venue.evidence === "official-deployment" ? "Official deployment; read-only RPC" : venue.evidence === "self-announcement" ? "Project statement; not independently verified" : venue.evidence === "arc-announcement" ? "Arc announcement; deployment not verified" : "Indexed contract; operator attribution unverified")));
    const link = element("a", "", copy("Source · checked {date}", { date: venue.checkedAt }));
    link.href = venue.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    evidence.append(link); row.append(info, evidence); list.append(row);
  }
}

function appendRecorderEvents(list: HTMLElement, data: RecorderSnapshot): void {
  list.replaceChildren();
  for (const event of data.events) {
    const row = element("li", "recorder-event");
    const labels: Record<string, string> = { "pool-created": "Pool creation indexed", buy: "Indexed buy", sell: "Indexed sell", "liquidity-add": "Indexed liquidity addition", "liquidity-remove": "Indexed liquidity removal" };
    const link = element("a", "", copy(labels[event.kind]));
    link.href = `${EXPLORER_BASE}/tx/${event.hash}`; link.target = "_blank"; link.rel = "noopener noreferrer";
    const value = event.amount === null ? element("a", "", shortHash(event.pool)) : element("span", "", `${event.amount} USDC`);
    if (value instanceof HTMLAnchorElement) { value.href = marketUrl(location.href, NETWORK!.id, event.pool); localize(value, "Full details", "title"); }
    row.append(link, value,
      element("small", "", copy("Event {event} · Saved {saved}", { event: formatAnalysisTime(Date.parse(event.at)), saved: formatAnalysisTime(event.observedAt) })));
    list.append(row);
  }
  if (!data.events.length) list.append(element("li", "", copy("No retained events in this scope. This does not mean no activity.")));
}

async function refreshRecorderOverview(): Promise<void> {
  if (!NETWORK || rpcReader || !localRecorderAvailable(new URL(location.href))) return;
  byId("localRecorder").classList.remove("hidden");
  const request = ++recorderRequest;
  try {
    const data = await readRecorderSnapshot(NETWORK, new URL(location.href));
    if (request !== recorderRequest) return;
    if (!data) throw new Error("Unavailable");
    const now = Date.now();
    setCopy("recorderStatus", data.leaseUntil > now && now - data.lastAttempt < 180_000 ? "Recorder recently active" : "Recorder stopped; saved history available");
    const pending = data.streams.filter(s => s.pending || !s.initialized).length, failed = data.streams.filter(s => s.error).length;
    setCopy("recorderCoverage", copy("{pools} pools · {events} saved events · {pending} streams pending · {failed} errors", { pools: data.poolCount, events: data.eventCount, pending, failed }));
    setCopy("recorderHealth", data.error || failed ? "Some streams need attention; coverage is incomplete." : pending ? "Collection is catching up across the registered pools." : "Registered streams checked; indexing may still lag.");
    setCopy("recorderLimits", copy("Initial history limited in {partial} streams · {gaps} missing checkpoints{cap}", { partial: data.streams.filter(s => s.bootstrapPartial).length,
      gaps: data.streams.reduce((sum, s) => sum + s.gaps, 0), cap: copy(data.poolLimitReached ? " · Pool capacity reached" : "") }));
    appendRecorderEvents(byId("recorderDiscoveries"), data);
  } catch {
    if (request !== recorderRequest) return;
    setCopy("recorderStatus", "Local recorder unavailable"); setCopy("recorderCoverage", "Browser-only observations remain available.");
    setCopy("recorderHealth", ""); setCopy("recorderLimits", ""); byId("recorderDiscoveries").replaceChildren();
  }
}

async function refreshRecorderDetail(market: MarketPair): Promise<void> {
  if (!NETWORK || rpcReader || !localRecorderAvailable(new URL(location.href))) return;
  byId("recorderHistorySection").classList.remove("hidden");
  const request = ++recorderDetailRequest;
  byId("recorderPoolEvents").replaceChildren(); setCopy("recorderPoolStatus", "Reading saved local events...");
  try {
    const data = await readRecorderSnapshot(NETWORK, new URL(location.href), poolRef(market));
    if (request !== recorderDetailRequest || selectedPair !== poolRef(market)) return;
    if (!data) throw new Error("Unavailable");
    const stream = data.streams.find(s => s.pool === poolRef(market) || market.v4 && s.pool === null && s.sourceId === market.sourceId);
    setCopy("recorderPoolStatus", !stream ? "This pool is outside recorder coverage." : !stream.initialized || stream.pending ? "Pool event collection pending; saved history is partial."
      : stream.error ? "Pool collection failed; showing retained events only." : copy("Last completed read {time}; retained events only.", { time: stream.completedAt ? formatAnalysisTime(stream.completedAt) : "--" }));
    appendRecorderEvents(byId("recorderPoolEvents"), data);
  } catch {
    if (request !== recorderDetailRequest || selectedPair !== poolRef(market)) return;
    setCopy("recorderPoolStatus", "Local recorder unavailable"); byId("recorderPoolEvents").replaceChildren();
  }
}

function renderMarketBrief(): void {
  const list = byId("marketBriefList");
  const expanded = list.querySelector<HTMLDetailsElement>(".brief-more")?.open ?? false;
  list.replaceChildren();
  const briefs = marketLoadFailed ? [] : marketBriefs(markets, Date.now());
  setCopy("marketBriefCount", copy("{count} tokens", { count: briefs.length }));
  if (!briefs.length) {
    list.append(element("p", "brief-empty", copy(marketLoadFailed ? "Market refresh failed. Recent changes cannot be assessed." : "No qualifying recent change in the loaded pools. This is not an all-clear.")));
    return;
  }
  const more = element("details", "brief-more");
  more.open = expanded;
  const moreList = element("div", "brief-more-list");
  more.append(element("summary", "", copy("{count} more changes", { count: Math.max(0, briefs.length - 3) })), moreList);
  for (const [index, brief] of briefs.entries()) {
    const row = element("article", "brief-row");
    const copyBlock = element("div", "brief-copy");
    const title = element("a", "", copy("{symbol} · {title}", { symbol: brief.market.token.symbol || "Token", title: copy(brief.title) }));
    title.href = marketUrl(location.href, NETWORK!.id, poolRef(brief.market));
    const description = brief.kind === "liquidity" ? copy("{amount} USDC removed; {percent}% of prior USDC reserve.", { amount: formatValue(brief.value, 4), percent: brief.secondaryValue!.toFixed(1) })
      : brief.kind === "price" ? copy("1H reserve-price change: {change}. Not an executable quote.", { change: compactChange(brief.value) })
      : copy("Pool creation and subsequent trades appear in the available index. Not a token endorsement.");
    copyBlock.append(title, element("p", "", description), element("small", "", copy("Pool {address} · {time} ago{partial}", { address: shortHash(brief.market.v4?.poolId ?? brief.market.pairAddress), time: relativeTime(brief.timestamp), partial: copy(brief.market.historyTruncated ? " · partial history" : "") })));
    const evidence = element("div", "brief-evidence");
    evidence.append(element("span", `evidence-label ${brief.basis}`, copy(brief.basis === "observed" ? "Indexed event" : "Calculated")));
    if (brief.transactionHash) {
      const link = element("a", "", copy("Source TX"));
      link.href = `${EXPLORER_BASE}/tx/${brief.transactionHash}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      evidence.append(link);
    }
    row.append(copyBlock, evidence);
    (index < 3 ? list : moreList).append(row);
  }
  if (briefs.length > 3) list.append(more);
}

function renderMarketPulse(): void {
  if (marketLoadFailed && markets.length === 0) {
    for (const id of ["pulseVolume", "pulseTrades", "pulseNetFlow", "pulseNewest", "pulseNewestAge", "pulseSellVerified"]) byId(id).textContent = "--";
    setCopy("pulseNewestAge", "Unavailable");
    setCopy("pulseStatus", "Market activity is unknown because pool data could not be loaded.");
    return;
  }
  const period = markets.map((market) => market.periods.h24);
  const volume = period.reduce((sum, metrics) => sum + metrics.volumeUsdc, 0);
  const buys = period.reduce((sum, metrics) => sum + metrics.buyCount, 0);
  const sells = period.reduce((sum, metrics) => sum + metrics.sellCount, 0);
  const netFlow = period.reduce((sum, metrics) => sum + metrics.netFlowUsdc, 0);
  const newest = [...markets].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const sellVerified = markets.filter((market) => market.sellCount > 0).length;
  const partial = markets.filter((market) => market.historyTruncated).length;

  byId("pulseVolume").textContent = `${formatValue(volume, 3)} USDC`;
  byId("pulseTrades").textContent = `${buys} / ${sells}`;
  const net = byId("pulseNetFlow");
  net.textContent = formatSignedUsdc(netFlow);
  net.className = changeClass(netFlow);
  byId("pulseNewest").textContent = newest ? newest.token.symbol || newest.token.name || "Unknown" : "--";
  setCopy("pulseNewestAge", newest ? copy("{time} old", { time: relativeTime(newest.createdAt) }) : "No pool indexed");
  byId("pulseSellVerified").textContent = `${sellVerified} / ${markets.length}`;
  const swapTotal = buys + sells;
  const cached = markets.filter(market => market.stale).length;
  setCopy("pulseStatus", copy("{count} swaps indexed in the last 24 hours · {partial} partial pools · {cached} cached pools", { count: swapTotal, partial, cached }));
}

function changeClass(value: number | null): string {
  if (value === null || Math.abs(value) < 0.05) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function renderMarketRows(): void {
  const container = byId("marketRows");
  container.replaceChildren();
  const shown = visibleMarkets();
  adPreview.setContentAvailable(shown.length > 0);
  renderMarketSummary();
  renderMarketPulse();
  renderMarketBrief();
  observations.save();
  renderDiscoveries();
  renderWatchDigest();
  for (const market of shown) {
    const row = element("button", "market-row");
    row.type = "button";
    row.title = `${adapterFor(market).source.label} · ${poolRef(market)}`;
    const selected = markets.find(entry => poolRef(entry) === selectedPair);
    const isSelected = selected?.tokenAddress.toLowerCase() === market.tokenAddress.toLowerCase();
    row.classList.toggle("selected", isSelected);
    row.setAttribute("aria-pressed", String(isSelected));
    localize(row, copy("Open {symbol} market", { symbol: market.token.symbol || market.token.name || "token" }), "aria-label");

    const identity = element("span", "market-token");
    const icon = element("span", "market-token-icon", (market.token.symbol || market.token.name || "?").slice(0, 2).toUpperCase());
    const copyBlock = element("span", "market-token-copy");
    const watched = watchlist.has(market.tokenAddress.toLowerCase());
    copyBlock.append(
      element("strong", watched ? "watched-token" : "", `${watched ? "★ " : ""}${market.token.symbol || "Unknown"}`),
      element("span", "", market.token.name || shortHash(market.tokenAddress)),
      element("small", "market-protocol", adapterFor(market).source.label),
      element("small", "market-data-state", copy(market.stale ? "Cached" : "Fetched")),
    );
    identity.append(icon, copyBlock);

    const price = element("span", "market-cell price-cell");
    price.append(priceElement(market.currentPrice), element("small", "price-age", market.priceStateAt || market.priceEventAt ? relativeTime(market.priceStateAt || market.priceEventAt) : "--"));
    localize(price, priceAgeCopy(market), "title");
    const valuation = element("span", "market-cell fdv-cell");
    valuation.append(element("strong", "", formatValue(market.fdv)), element("small", "mobile-volume", `${formatValue(market.periods.h24.volumeUsdc, 3)} USDC*`));
    valuation.title = market.fdv === null ? "--" : `${market.fdv.toLocaleString("en-US", { maximumSignificantDigits: 15 })} USDC`;
    const pulse = element("span", "market-cell pulse-cell");
    pulse.append(
      element("strong", "", `${formatValue(market.periods.h24.volumeUsdc, 3)} USDC`),
      element("small", changeClass(market.periods.h1.priceChange), `1H ${compactChange(market.periods.h1.priceChange)}`),
    );

    const flow = element("span", "row-flow");
    const counts = element("strong");
    counts.append(element("span", "positive", copy("B {count}", { count: market.buyCount })), element("span", "negative", copy("S {count}", { count: market.sellCount })));
    const track = element("span", "mini-flow-track");
    const total = Math.max(1, market.buyCount + market.sellCount);
    const buyBar = element("span");
    const sellBar = element("span");
    buyBar.style.width = `${(market.buyCount / total) * 100}%`;
    sellBar.style.width = `${(market.sellCount / total) * 100}%`;
    track.append(buyBar, sellBar);
    flow.append(counts, track);

    const age = element("span", "market-cell");
    age.append(element("strong", "", market.lastTradeAt ? relativeTime(market.lastTradeAt) : "--"));
    row.append(identity, price, valuation, pulse, flow, age);
    row.addEventListener("click", () => {
      tokenDirectory?.viewed(market.tokenAddress);
      void selectMarket(market, true);
    });
    container.append(row);
  }
  const savedMatches = renderTokenSearch(activeQuery);
  if (shown.length === 0 && savedMatches === 0) {
    const checkingSaved = [...tokenSearchStates.values()].some(state => state === "Waiting for market lookup" || state === "Loading market data...");
    const message = checkingSaved ? "Checking saved markets before applying the filter..." : marketLoadFailed && markets.length === 0 ? "Market activity is unknown because pool data could not be loaded."
      : "No loaded token matches all selected conditions. Missing data is not a failed valuation.";
    container.append(element("div", "market-loading-row", copy(message)));
  }
}

function classifyWalletSignals(
  market: MarketPair,
  transfers: TokenTransfer[],
  holders: TokenHolder[],
  creatorAddress: string | null,
  pools: Set<string>,
): WalletSignal[] {
  const creator = creatorAddress?.toLowerCase() ?? null;
  const currentHolders = new Set(holders
    .filter((holder) => Number(holder.value || 0) > 0 && holder.address?.hash)
    .map((holder) => holder.address!.hash!.toLowerCase()));
  const topHolders = new Set(holders
    .filter((holder) => {
      const hash = holder.address?.hash?.toLowerCase();
      return Boolean(hash && !pools.has(hash) && !BURN_ADDRESSES.has(hash));
    })
    .slice(0, 10)
    .map((holder) => holder.address!.hash!.toLowerCase()));
  const chronological = [...transfers].sort((a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime());
  const seenReceivers = new Set<string>();
  const signals: WalletSignal[] = [];
  const createdAt = new Date(market.createdAt).getTime();

  for (const transfer of chronological) {
    if (transfer.type !== "token_transfer") continue;
    const fromAddress = transfer.from?.hash;
    const toAddress = transfer.to?.hash;
    if (!fromAddress || !toAddress || !transfer.timestamp || !transfer.transaction_hash) continue;
    const from = fromAddress.toLowerCase();
    const to = toAddress.toLowerCase();
    const firstIndexedReceipt = !seenReceivers.has(to);
    seenReceivers.add(to);

    const timestamp = new Date(transfer.timestamp).getTime();
    if (transfer.transaction_hash.toLowerCase() === market.creationTx.toLowerCase()) continue;
    if (Number.isFinite(createdAt) && timestamp < createdAt) continue;
    if (BURN_ADDRESSES.has(from) || BURN_ADDRESSES.has(to)) continue;

    const amount = decimalValue(transfer.total?.value, transfer.total?.decimals ?? market.token.decimals);
    const share = holderShare(transfer.total?.value, market.token.total_supply);
    if (amount <= 0 || share === null) continue;

    const fromPool = pools.has(from);
    const toPool = pools.has(to);
    if (fromPool && toPool) continue;
    const creatorInvolved = Boolean(creator && (from === creator || to === creator));
    const topHolderInvolved = topHolders.has(from) || topHolders.has(to);
    const poolOutflow = !fromPool && toPool;
    const firstEntry = !toPool && !transfer.to?.is_contract && firstIndexedReceipt && currentHolders.has(to) && share >= 0.1;
    const whaleMove = share >= 1 || topHolderInvolved;
    const categories = new Set<WalletSignalCategory>();
    if (creatorInvolved) categories.add("creator");
    if (whaleMove) categories.add("whale");
    if (firstEntry) categories.add("entry");
    if (poolOutflow) categories.add("exit");
    if (categories.size === 0) continue;

    let title = "Wallet movement";
    let detail = "A token transfer moved between two indexed addresses.";
    let tone: WalletSignal["tone"] = "info";
    if (creatorInvolved) {
      if (from === creator && toPool) {
        title = "Creation sender sent to pool";
        detail = "The PairCreated transaction sender moved tokens into the pool.";
        tone = "warning";
      } else if (to === creator && fromPool) {
        title = "Creation sender received from pool";
        detail = "The PairCreated transaction sender acquired tokens from the pool.";
        tone = "info";
      } else if (from === creator) {
        title = "Creation sender sent tokens";
        detail = "The PairCreated transaction sender transferred tokens to another address.";
        tone = "warning";
      } else {
        title = "Creation sender received tokens";
        detail = "Tokens moved into the PairCreated transaction sender.";
      }
    } else if (poolOutflow) {
      title = topHolders.has(from) ? "Top holder sent to pool" : "Wallet sent to pool";
      detail = "Tokens moved into a known pool. A transfer alone does not confirm a sale or a full exit.";
      tone = "warning";
    } else if (whaleMove) {
      if (fromPool) {
        title = topHolders.has(to) ? "Top holder received from pool" : "Large transfer from pool";
        detail = "Tokens moved out of a known pool; this may be a swap or a liquidity withdrawal.";
        tone = "info";
      } else {
        title = topHolders.has(from) ? "Top holder transferred" : "Large wallet transfer";
        detail = "A large token position moved directly between addresses.";
      }
    } else if (firstEntry) {
      title = "First visible receipt";
      detail = "This is the wallet's first receipt in the visible indexed transfer history.";
      tone = "good";
    }

    signals.push({
      amount,
      categories: [...categories],
      detail,
      fromAddress,
      share,
      timestamp: transfer.timestamp,
      title,
      toAddress,
      tone,
      transactionHash: transfer.transaction_hash,
    });
  }

  return signals
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 20);
}

function analyzeHolderConnections(
  market: MarketPair,
  transfers: TokenTransfer[],
  positions: HolderPosition[],
  pools: Set<string>,
): { clusters: HolderCluster[]; connections: HolderConnection[] } {
  const positionByAddress = new Map(positions.map((position) => [position.address.toLowerCase(), position]));
  const createdAt = new Date(market.createdAt).getTime();
  const connectionMap = new Map<string, HolderConnection>();
  const sharedSources = new Map<string, { address: string; recipients: Set<string> }>();
  const connectionKey = (addressA: string, addressB: string) => [addressA.toLowerCase(), addressB.toLowerCase()].sort().join(":");

  for (const transfer of transfers) {
    if (transfer.type !== "token_transfer" || !transfer.from?.hash || !transfer.to?.hash || !transfer.transaction_hash) continue;
    if (transfer.transaction_hash.toLowerCase() === market.creationTx.toLowerCase()) continue;
    const timestamp = new Date(transfer.timestamp ?? 0).getTime();
    if (Number.isFinite(createdAt) && timestamp < createdAt) continue;
    const from = transfer.from.hash.toLowerCase();
    const to = transfer.to.hash.toLowerCase();
    if (pools.has(from) || pools.has(to) || BURN_ADDRESSES.has(from) || BURN_ADDRESSES.has(to)) continue;

    if (positionByAddress.has(from) && positionByAddress.has(to) && from !== to) {
      connectionMap.set(connectionKey(from, to), {
        addressA: positionByAddress.get(from)!.address,
        addressB: positionByAddress.get(to)!.address,
        kind: "direct",
        source: null,
        transactionHash: transfer.transaction_hash,
      });
    }
    if (!transfer.from.is_contract && positionByAddress.has(to) && from !== to) {
      const source = sharedSources.get(from) ?? { address: transfer.from.hash, recipients: new Set<string>() };
      source.recipients.add(to);
      sharedSources.set(from, source);
    }
  }

  for (const source of sharedSources.values()) {
    const recipients = [...source.recipients];
    if (recipients.length < 2) continue;
    for (let left = 0; left < recipients.length - 1; left += 1) {
      for (let right = left + 1; right < recipients.length; right += 1) {
        const addressA = recipients[left];
        const addressB = recipients[right];
        const key = connectionKey(addressA, addressB);
        if (connectionMap.has(key)) continue;
        connectionMap.set(key, {
          addressA: positionByAddress.get(addressA)!.address,
          addressB: positionByAddress.get(addressB)!.address,
          kind: "shared-source",
          source: source.address,
          transactionHash: null,
        });
      }
    }
  }

  const connections = [...connectionMap.values()].slice(0, 20);
  const parent = new Map(positions.map((position) => [position.address.toLowerCase(), position.address.toLowerCase()]));
  const find = (address: string): string => {
    const current = parent.get(address) ?? address;
    if (current === address) return address;
    const root = find(current);
    parent.set(address, root);
    return root;
  };
  const union = (addressA: string, addressB: string): void => {
    const rootA = find(addressA);
    const rootB = find(addressB);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  connections.forEach((connection) => union(connection.addressA.toLowerCase(), connection.addressB.toLowerCase()));
  const groups = new Map<string, string[]>();
  for (const position of positions) {
    const root = find(position.address.toLowerCase());
    groups.set(root, [...(groups.get(root) ?? []), position.address]);
  }
  const clusters = [...groups.values()]
    .filter((members) => members.length > 1)
    .map((members) => ({
      members,
      share: members.reduce((sum, address) => sum + (positionByAddress.get(address.toLowerCase())?.share ?? 0), 0),
    }))
    .sort((a, b) => b.share - a.share);
  return { clusters, connections };
}

function mergeContracts(proxy: ContractDetails | null, implementation: ContractDetails | null): ContractDetails | null {
  if (!proxy && !implementation) return null;
  const abi = [...(proxy?.abi ?? []), ...(implementation?.abi ?? [])];
  const seen = new Set<string>();
  return {
    abi: abi.filter((entry) => {
      const key = `${entry.type}:${entry.name}:${entry.stateMutability}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    is_fully_verified: Boolean(proxy?.is_fully_verified && (!implementation || implementation.is_fully_verified)),
    is_verified: Boolean(proxy?.is_verified || implementation?.is_verified),
  };
}

function contractFunctions(contract: ContractDetails | null): AbiEntry[] {
  return (contract?.abi ?? []).filter((entry) => entry.type === "function" && Boolean(entry.name));
}

async function fetchMarketDetail(market: MarketPair, force: boolean): Promise<MarketDetail> {
  const transactionHashes = [...new Set([
    ...market.trades.map((trade) => trade.transactionHash),
    ...market.liquidityEvents.map((event) => event.transactionHash),
  ].filter(Boolean))].slice(0, 12);
  const transactionRequests = mapLimited(
    transactionHashes,
    3,
    async (hash) => ({
      hash,
      transaction: await fetchOptional<TransactionDetails>(`/transactions/${hash}`, 300_000, force),
    }),
  );
  const [holderData, lpHolderData, pairToken, addressResult, transaction, resolvedTransactions, transferHistory] = await Promise.all([
    fetchOptional<HolderResponse>(`/tokens/${market.tokenAddress}/holders`, 120_000, force),
    market.v4 || market.v3 ? Promise.resolve(null) : fetchOptional<HolderResponse>(`/tokens/${market.pairAddress}/holders`, 120_000, force),
    market.v4 || market.v3 ? Promise.resolve(null) : fetchOptional<Token>(`/tokens/${market.pairAddress}`, 300_000, force),
    fetchOptional<AddressDetails>(`/addresses/${market.tokenAddress}`, 120_000, force),
    market.creationTx ? fetchOptional<TransactionDetails>(`/transactions/${market.creationTx}`, 300_000, force) : Promise.resolve(null),
    transactionRequests,
    fetchTokenTransfers(market.tokenAddress, force).catch(() => null),
  ]);
  const address = addressResult?.data ?? null;
  const implementationAddress = address?.implementations?.[0]?.address_hash;
  const [proxyContract, implementationContract] = await Promise.all([
    address?.is_verified ? fetchOptional<ContractDetails>(`/smart-contracts/${market.tokenAddress}`, 300_000, force) : Promise.resolve(null),
    implementationAddress ? fetchOptional<ContractDetails>(`/smart-contracts/${implementationAddress}`, 300_000, force) : Promise.resolve(null),
  ]);
  const contract = mergeContracts(proxyContract?.data ?? null, implementationContract?.data ?? null);
  const pools = knownTokenPools(market, markets);
  const ownership = holderMetrics(holderData, market.token.total_supply, pools);
  const holders = ownership.holders;
  const pairLower = market.pairAddress.toLowerCase();
  const creatorAddress = transaction?.data.from?.hash ?? null;
  const creator = creatorAddress?.toLowerCase() ?? null;
  const holderPositions = ownership.positions.slice(0, 8).flatMap<HolderPosition>((holder) => {
    const hash = holder.address?.hash;
    if (!hash) return [];
    return [{
      address: hash,
      balance: decimalValue(holder.value, market.token.decimals),
      isContract: Boolean(holder.address?.is_contract),
      isCreator: hash.toLowerCase() === creator,
      name: holder.address?.name ?? null,
      share: holderShare(holder.value, market.token.total_supply),
    }];
  });
  const lp = holderMetrics(lpHolderData, pairToken?.data.total_supply ?? null, new Set());
  const topLp = lp.positions[0];
  const transactionSenders = Object.fromEntries(resolvedTransactions
    .filter((entry) => entry.transaction?.data.from?.hash)
    .map((entry) => [entry.hash.toLowerCase(), entry.transaction!.data.from!.hash!]));
  const walletSignals = classifyWalletSignals(market, transferHistory?.items ?? [], holders, creatorAddress, pools);
  const holderNetwork = analyzeHolderConnections(market, transferHistory?.items ?? [], holderPositions, pools);
  const combinedState = (...states: SourceState[]): SourceState => states.includes("unavailable") ? "unavailable" : states.includes("cached") ? "cached" : "fresh";
  const contractState = combinedState(sourceState(addressResult), sourceState(proxyContract),
    ...(implementationAddress ? [sourceState(implementationContract)] : []));
  return {
    checkedAt: Date.now(),
    sources: {
      holders: ownership.state,
      lp: combinedState(lp.state, sourceState(pairToken)),
      contract: contractFunctions(contract).length > 0 ? contractState : "unavailable",
      creator: creatorAddress ? sourceState(transaction) : "unavailable",
      transfers: transferHistory ? transferHistory.stale ? "cached" : "fresh" : "unavailable",
      senders: combinedState(...resolvedTransactions.map(entry => entry.transaction?.data.from?.hash ? sourceState(entry.transaction) : "unavailable")),
    },
    holderHistoryPartial: ownership.partial,
    lpHistoryPartial: lp.partial,
    poolScope: [...pools].sort().join(","),
    burnedTokenShare: ownership.burned,
    capabilities: detectCapabilities(address, contract),
    contractVisible: contractFunctions(contract).length > 0,
    creatorShare: ownership.shareAt(creatorAddress),
    holderClusters: holderNetwork.clusters,
    holderConnections: holderNetwork.connections,
    holderPositions,
    lpBurnedShare: lp.burned,
    lpTopHolderIsContract: Boolean(topLp?.address?.is_contract),
    lpTopHolderShare: lp.top(1),
    poolShare: market.v4 || market.v3 ? null : ownership.shareAt(pairLower),
    top1Share: ownership.top(1),
    top5Share: ownership.top(5),
    top10Share: ownership.top(10),
    transferHistoryTruncated: transferHistory?.truncated ?? true,
    transactionSenders,
    walletSignals,
  };
}

function buildWarnings(market: MarketPair, detail: MarketDetail): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  if (market.v4) warnings.push({ basis: "unverified", title: "v4 liquidity unavailable", detail: "Shared PoolManager balances are not per-pool liquidity. LP ownership and exit estimates are unavailable.", tone: "info" });
  if (market.v3) warnings.push({ basis: "unverified", title: "v3 liquidity unavailable", detail: "Concentrated liquidity positions and exit estimates are not assessed.", tone: "info" });
  if (market.v3) warnings.push({ basis: "observed", title: "v3 pool configuration", detail: copy("Fee {fee} · Tick spacing {spacing}", { fee: `${market.v3.fee / 10_000}%`, spacing: market.v3.tickSpacing }), tone: "info" });
  if (market.v4) warnings.push({ basis: "observed", title: "v4 pool configuration", detail: copy("Pool {id} · Fee {fee} · Tick spacing {spacing} · Hooks {hooks}. Swap amounts exclude additional hook adjustments; hook behavior is not audited.", {
    id: market.v4.poolId, fee: market.v4.fee === 0x800000 ? "dynamic" : `${market.v4.fee / 10_000}%`, spacing: market.v4.tickSpacing, hooks: market.v4.hooks,
  }), tone: "info" });
  const incomplete = Object.entries(detail.sources).filter(([, state]) => state !== "fresh");
  if (incomplete.length) warnings.push({ basis: "unverified", title: "Detail checks are incomplete", detail: copy("{sources}. Missing data is not a clean risk check.", { sources: incomplete.map(([name, state]) => `${name}: ${state}`).join("; ") }), tone: "warning" });
  if (detail.holderHistoryPartial || detail.lpHistoryPartial) warnings.push({ basis: "unverified", title: "Holder index is partial", detail: "Only the first holder page is available. Unseen balances and incomplete burn totals remain unknown.", tone: "info" });
  if (market.periods.h24.priceChange === null) warnings.push({ basis: "unverified", title: "24H starting price unavailable", detail: "The 24H return is not estimated from a shorter window.", tone: "info" });
  if (market.historyTruncated) warnings.push({ basis: "unverified", title: "24-hour activity is partial", detail: "Events outside the fetched history are not included in totals.", tone: "info" });
  if (market.reserveSource === "balance") warnings.push({ basis: "estimate", title: "Token-balance fallback", detail: "No indexed Sync event was available. Price and liquidity are derived from the pair's token balances.", tone: "info" });
  if (market.sellCount > 0) warnings.push({ basis: "observed", title: "Sell event indexed", detail: copy("A token-to-USDC Swap was indexed {time} ago. This does not prove that any wallet can sell now.", { time: relativeTime(market.lastSellAt) }), tone: "info" });
  else warnings.push({ basis: "unverified", title: "No sell in available history", detail: "Absence of indexed sells does not prove a token is unsellable.", tone: "info" });
  if (market.totalLiquidity !== null && market.totalLiquidity < 200) warnings.push({ basis: "estimate", title: "Pool liquidity below 200 USDC", detail: copy("Reserve-based estimate: {total} USDC total, {quote} USDC on the quote side. This threshold is a screening rule, not a safety rating.", { total: formatValue(market.totalLiquidity), quote: formatValue(market.usdcReserve) }), tone: "warning" });
  if (detail.top10Share !== null && detail.top10Share >= 25) warnings.push({ basis: "estimate", title: "Top-10 ownership exceeds 25%", detail: copy("{share}% of indexed supply, excluding burn addresses and known pools. Addresses are not necessarily independent owners.", { share: detail.top10Share.toFixed(1) }), tone: "warning" });
  if (detail.creatorShare !== null && detail.creatorShare >= 10) warnings.push({ basis: "estimate", title: "Pool-creation sender holds at least 10%", detail: copy("Indexed share: {share}%. This transaction sender may be a relayer; it is not proof of the token team's identity.", { share: detail.creatorShare.toFixed(1) }), tone: "info" });
  if (detail.lpBurnedShare !== null) warnings.push({ basis: "estimate", title: "LP at burn addresses", detail: copy("{share}% of indexed LP supply. This does not establish token safety or sale availability.", { share: detail.lpBurnedShare.toFixed(1) }), tone: "info" });
  warnings.push({ basis: "unverified", title: "Liquidity lock not independently checked", detail: detail.lpTopHolderShare !== null ? copy("Top indexed LP holder: {share}%. Lock contract rules and unlock times have not been checked.", { share: detail.lpTopHolderShare.toFixed(1) }) : "LP ownership or lock terms could not be established.", tone: "info" });
  detail.capabilities.forEach(finding => warnings.push({ ...capabilityText(finding), detail: copy("{evidence} Names alone do not establish current permissions or execution paths. Selected getter values, when requested, appear separately under Contract state and do not confirm this capability is usable.", {
    evidence: [finding.functions.length ? `ABI: ${finding.functions.join(", ")}.` : "", finding.proxyType ? `Explorer proxy type: ${finding.proxyType}.` : ""].filter(Boolean).join(" "),
  }), tone: "info" }));
  warnings.push({ basis: "unverified", title: "Execution paths not verified", detail: "No sell simulation or full permission audit is performed. Optional contract-state reads below report selected getter values only; they do not prove a control is usable, disabled, or absent elsewhere.", tone: "info" });
  if (!detail.contractVisible) warnings.push({ basis: "unverified", title: "Contract ABI unavailable", detail: "Supply and trading controls cannot be assessed from the available ABI.", tone: "info" });
  else if (detail.capabilities.length === 0) warnings.push({ basis: "unverified", title: "No matching ABI names", detail: "No configured function-name pattern matched. Custom logic, external contracts, or different function names may still impose restrictions.", tone: "info" });
  return warnings;
}

function setDetailState(state: "empty" | "loading" | "content"): void {
  if (state === "empty" && !linkedPool) document.body.classList.remove("detail-open");
  byId("marketDetailEmpty").classList.toggle("hidden", state !== "empty");
  byId("marketDetailLoading").classList.toggle("hidden", state !== "loading");
  byId("marketDetailContent").classList.toggle("hidden", state !== "content");
}

let marketChart: ReturnType<typeof createMarketChart> | null = null;
function renderPriceChart(market: MarketPair): void {
  marketChart ??= createMarketChart();
  marketChart.render(market, `${market.chainId}:${poolRef(market)}`);
}

function renderWindowMetrics(market: MarketPair): void {
  const windows: Array<{ changeId: string; flowId: string; metrics: PeriodMetrics }> = [
    { changeId: "window5mChange", flowId: "window5mFlow", metrics: market.periods.m5 },
    { changeId: "window1hChange", flowId: "window1hFlow", metrics: market.periods.h1 },
    { changeId: "window6hChange", flowId: "window6hFlow", metrics: market.periods.h6 },
    { changeId: "window24hChange", flowId: "window24hFlow", metrics: market.periods.h24 },
  ];
  for (const window of windows) {
    const change = byId(window.changeId);
    change.textContent = compactChange(window.metrics.priceChange);
    change.className = changeClass(window.metrics.priceChange);
    byId(window.flowId).textContent = `${window.metrics.buyCount}B / ${window.metrics.sellCount}S · ${formatValue(window.metrics.volumeUsdc, 3)} USDC`;
  }
}

function renderTradeTape(market: MarketPair, detail: MarketDetail): void {
  const list = byId("tradeList");
  list.replaceChildren();
  const trades = market.trades.slice(0, 10);
  setCopy("detailTradeCount", trades.length > 0 ? copy("{count} visible", { count: trades.length }) : "No trades");
  if (trades.length === 0) {
    list.append(element("div", "trade-empty", copy("No swaps are available in the indexed history.")));
    return;
  }
  for (const trade of trades) {
    const row = element("div", `trade-row ${trade.direction}`);
    const side = element("span", "trade-side", copy(trade.direction === "buy" ? "BUY" : "SELL"));
    const value = element("span", "trade-value");
    value.append(element("strong", "", `${formatValue(trade.usdcValue, 4)} USDC`), element("small", "", `${relativeTime(trade.timestamp)} ago`));
    const links = element("span", "trade-links");
    const actor = tradeActor(detail.transactionSenders[trade.transactionHash.toLowerCase()], trade.fallbackAddress);
    if (actor) {
      const senderLink = element("a", "", shortHash(actor.address, 5, 4));
      senderLink.href = `${EXPLORER_BASE}/address/${actor.address}`;
      senderLink.target = "_blank";
      senderLink.rel = "noreferrer";
      senderLink.title = `${actor.role}: ${actor.address}`;
      senderLink.setAttribute("aria-label", `${actor.role} ${actor.address}`);
      links.append(element("span", "trade-sender-label", copy(actor.role)), senderLink);
    } else {
      links.append(element("span", "", copy("Sender unknown")));
    }
    if (trade.transactionHash) {
      const txLink = element("a", "trade-tx-link", "TX");
      txLink.href = `${EXPLORER_BASE}/tx/${trade.transactionHash}`;
      txLink.target = "_blank";
      txLink.rel = "noreferrer";
      links.append(txLink);
    }
    row.append(side, value, links);
    list.append(row);
  }
}

function renderWalletSignals(market: MarketPair, detail: MarketDetail): void {
  const signals = detail.walletSignals;
  const count = (category: WalletSignalCategory) => signals.filter((signal) => signal.categories.includes(category)).length;
  setCopy("walletSignalCount", detail.sources.transfers === "unavailable" ? "Unavailable" : copy("{count} signals", { count: signals.length }));
  byId("walletCreatorMoves").textContent = String(count("creator"));
  byId("walletWhaleMoves").textContent = String(count("whale"));
  byId("walletEntries").textContent = String(count("entry"));
  byId("walletExits").textContent = String(count("exit"));
  if (detail.sources.transfers === "unavailable") {
    for (const id of ["walletCreatorMoves", "walletWhaleMoves", "walletEntries", "walletExits"]) byId(id).textContent = "--";
  } else {
    if (detail.sources.creator === "unavailable") byId("walletCreatorMoves").textContent = "--";
    if (detail.sources.holders === "unavailable") byId("walletEntries").textContent = "--";
  }
  setCopy("walletSignalNote", copy("Transfers: {transfers}{partial}. Holders: {holders}. Pool transfers are not proof of a swap or full exit.", {
    transfers: copy(detail.sources.transfers), partial: copy(detail.transferHistoryTruncated ? "; partial history" : ""), holders: copy(detail.sources.holders),
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-wallet-filter]").forEach((button) => {
    const active = button.dataset.walletFilter === activeWalletSignalFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const filter = activeWalletSignalFilter;
  const visible = filter === "all"
    ? signals
    : signals.filter((signal) => signal.categories.includes(filter));
  const list = byId("walletSignalList");
  list.replaceChildren();
  if (visible.length === 0) {
    list.append(element("div", "wallet-signal-empty", copy(detail.sources.transfers === "unavailable" ? "Transfer history could not be loaded. Wallet activity is unknown." : "No wallet movement matches this filter in the available indexed transfers.")));
    return;
  }

  for (const signal of visible) {
    const row = element("div", `wallet-signal-row ${signal.tone}`);
    const head = element("div", "wallet-signal-head");
    const time = element("time", "", `${relativeTime(signal.timestamp)} ago`);
    time.dateTime = signal.timestamp;
    head.append(element("strong", "", signal.title), time);

    const meta = element("div", "wallet-signal-meta");
    const amount = element("span", "wallet-signal-amount");
    amount.append(
      element("strong", "", `${formatValue(signal.amount, 3)} ${market.token.symbol || "tokens"}`),
      element("span", "", `${shareText(signal.share)} supply`),
    );
    const links = element("span", "wallet-signal-links");
    const fromLink = element("a", "", shortHash(signal.fromAddress, 5, 4));
    fromLink.href = `${EXPLORER_BASE}/address/${signal.fromAddress}`;
    fromLink.target = "_blank";
    fromLink.rel = "noreferrer";
    fromLink.title = signal.fromAddress;
    const toLink = element("a", "", shortHash(signal.toAddress, 5, 4));
    toLink.href = `${EXPLORER_BASE}/address/${signal.toAddress}`;
    toLink.target = "_blank";
    toLink.rel = "noreferrer";
    toLink.title = signal.toAddress;
    const txLink = element("a", "", "TX");
    txLink.href = `${EXPLORER_BASE}/tx/${signal.transactionHash}`;
    txLink.target = "_blank";
    txLink.rel = "noreferrer";
    links.append(fromLink, element("span", "", "->"), toLink, txLink);
    meta.append(amount, links);
    row.append(head, element("p", "", signal.detail), meta);
    list.append(row);
  }
}

function renderLiquidityMonitor(market: MarketPair, detail: MarketDetail): void {
  if (market.v4 || market.v3) {
    for (const id of ["liquidityCurrent", "liquidityAdded", "liquidityRemoved", "liquidityBurned"]) byId(id).textContent = "--";
    setCopy("liquidityEventCount", "Unavailable");
    setCopy("liquidityHistoryNote", market.v3 ? "v3 liquidity unavailable" : "v4 liquidity unavailable");
    setCopy("liquidityLpStatus", market.v3 ? "Concentrated liquidity positions and exit estimates are not assessed." : "Shared PoolManager balances are not per-pool liquidity. LP ownership and exit estimates are unavailable.");
    byId("liquidityEventList").replaceChildren();
    return;
  }
  const events = market.liquidityEvents;
  const now = Date.now();
  const cutoff = now - DAY_MS;
  const recent = events.filter((event) => Date.parse(event.timestamp) >= cutoff && Date.parse(event.timestamp) <= now);
  const added = recent.filter((event) => event.direction === "add").reduce((sum, event) => sum + event.usdcAmount, 0);
  const removed = recent.filter((event) => event.direction === "remove").reduce((sum, event) => sum + event.usdcAmount, 0);
  setCopy("liquidityEventCount", copy("{count} events", { count: events.length }));
  setCopy("liquidityHistoryNote", copy("Showing {shown} of {count} indexed liquidity events. 24H totals use fetched events only{partial}.", {
    shown: Math.min(events.length, 8), count: events.length, partial: copy(market.historyTruncated ? "; history may be incomplete" : ""),
  }));
  byId("liquidityCurrent").textContent = formatValue(market.usdcReserve, 3);
  byId("liquidityAdded").textContent = formatValue(added, 3);
  byId("liquidityRemoved").textContent = formatValue(removed, 3);
  byId("liquidityBurned").textContent = shareText(detail.lpBurnedShare);
  const lpOwnership = detail.lpBurnedShare !== null && detail.lpBurnedShare >= 90
    ? copy("{share} of LP supply is held by burn addresses.", { share: shareText(detail.lpBurnedShare) })
    : detail.lpTopHolderShare !== null ? copy("Top {holder} controls {share} of LP supply; a lock is not confirmed.", { holder: copy(detail.lpTopHolderIsContract ? "contract" : "wallet"), share: shareText(detail.lpTopHolderShare) })
      : copy("LP ownership is unavailable from the current index.");
  setCopy("liquidityLpStatus", copy("{ownership} LP data: {state}{partial}.", {
    ownership: lpOwnership, state: copy(detail.sources.lp), partial: copy(detail.lpHistoryPartial ? "; partial holder page" : ""),
  }));

  const list = byId("liquidityEventList");
  list.replaceChildren();
  if (events.length === 0) {
    list.append(element("div", "liquidity-empty", copy("No Mint or Burn event appears in the visible pair history.")));
    return;
  }
  for (const event of events.slice(0, 8)) {
    const row = element("div", `liquidity-event-row ${event.direction}`);
    const head = element("div", "liquidity-event-head");
    const time = element("time", "", copy("{time} ago", { time: relativeTime(event.timestamp) }));
    time.dateTime = event.timestamp;
    head.append(element("strong", "", copy(event.direction === "add" ? "Liquidity added" : "Liquidity removed")), time);

    const values = element("div", "liquidity-event-values");
    values.append(
      element("strong", "", `${formatValue(event.usdcAmount, 4)} USDC`),
      element("span", "", `${formatValue(event.tokenAmount, 3)} ${market.token.symbol || "tokens"}`),
      element("span", "", event.changePercent === null ? copy("Initial / unknown base") : copy("{percent}% of prior USDC reserve", { percent: event.changePercent.toFixed(1) })),
    );
    const links = element("span", "liquidity-event-links");
    const wallet = detail.transactionSenders[event.transactionHash.toLowerCase()] ?? event.fallbackAddress;
    if (wallet) {
      const walletLink = element("a", "", shortHash(wallet, 5, 4));
      walletLink.href = `${EXPLORER_BASE}/address/${wallet}`;
      walletLink.target = "_blank";
      walletLink.rel = "noreferrer";
      walletLink.title = wallet;
      links.append(walletLink);
    }
    const txLink = element("a", "", "TX");
    txLink.href = `${EXPLORER_BASE}/tx/${event.transactionHash}`;
    txLink.target = "_blank";
    txLink.rel = "noreferrer";
    links.append(txLink);
    row.append(head, values, links);
    list.append(row);
  }
}

function shareText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function renderHolders(market: MarketPair, detail: MarketDetail): void {
  setCopy("holderCountSummary", copy("{count} indexed", { count: fullNumber(market.token.holders_count) }));
  byId("holderTop1").textContent = shareText(detail.top1Share);
  byId("holderTop5").textContent = shareText(detail.top5Share);
  byId("holderTop10").textContent = shareText(detail.top10Share);
  byId("holderCreator").textContent = shareText(detail.creatorShare);
  setCopy("holderSupplyNote", copy("Holders: {state}{partial}. Selected pool {poolShare} · Burned {burnedShare}. Rankings exclude burn addresses and {count} known same-token pool(s), not all possible pools.", {
    state: copy(detail.sources.holders), partial: copy(detail.holderHistoryPartial ? "; first page only" : ""), poolShare: shareText(detail.poolShare), burnedShare: shareText(detail.burnedTokenShare), count: detail.poolScope.split(",").filter(Boolean).length,
  }));

  const list = byId("holderList");
  list.replaceChildren();
  if (detail.holderPositions.length === 0) {
    list.append(element("div", "holder-empty", copy("Holder positions are unavailable from the current index.")));
    return;
  }

  detail.holderPositions.forEach((position, index) => {
    const row = element("div", "holder-row");
    const rank = element("span", "holder-rank", `#${index + 1}`);
    const identity = element("div", "holder-identity");
    const addressLine = element("div", "holder-address-line");
    const address = element("a", "holder-address", position.name || shortHash(position.address, 6, 4));
    address.href = `${EXPLORER_BASE}/address/${position.address}`;
    address.target = "_blank";
    address.rel = "noreferrer";
    address.title = position.address;
    addressLine.append(address);
    if (position.isCreator) addressLine.append(element("span", "holder-tag creator", copy("Creation sender")));
    if (position.isContract) addressLine.append(element("span", "holder-tag contract", "Contract"));
    identity.append(addressLine, element("small", "", `${formatValue(position.balance, 3)} ${market.token.symbol || "tokens"}`));

    const ownership = element("div", "holder-ownership");
    ownership.append(element("strong", "", shareText(position.share)));
    const track = element("span", "holder-track");
    const fill = element("span", "holder-fill");
    fill.style.width = `${Math.min(100, Math.max(0, position.share ?? 0))}%`;
    track.append(fill);
    ownership.append(track);
    row.append(rank, identity, ownership);
    list.append(row);
  });
}

function renderHolderConnections(detail: MarketDetail): void {
  const connections = detail.holderConnections;
  const clusters = detail.holderClusters;
  const connectedWallets = new Set(connections.flatMap((connection) => [connection.addressA.toLowerCase(), connection.addressB.toLowerCase()]));
  const unavailable = detail.sources.holders === "unavailable" || detail.sources.transfers === "unavailable";
  setCopy("holderClusterSummary", unavailable ? "Unavailable" : connections.length === 0 ? "No visible links" : copy("{count} links", { count: connections.length }));
  byId("clusterConnections").textContent = String(connections.length);
  byId("clusterWallets").textContent = String(connectedWallets.size);
  byId("clusterCount").textContent = String(clusters.length);
  byId("clusterLargest").textContent = clusters[0] ? shareText(clusters[0].share) : "--";
  if (unavailable) {
    for (const id of ["clusterConnections", "clusterWallets", "clusterCount"]) byId(id).textContent = "--";
  }

  const positionByAddress = new Map(detail.holderPositions.map((position) => [position.address.toLowerCase(), position]));
  const map = byId("holderClusterMap");
  map.replaceChildren();
  if (clusters.length === 0) {
    map.append(element("div", "cluster-empty", unavailable ? copy("Holder connections cannot be checked without holder and transfer data.") : copy("No connection appears in the available post-launch history. Holders: {holders}; transfers: {transfers}.", { holders: copy(detail.sources.holders), transfers: copy(detail.sources.transfers) })));
  } else {
    clusters.forEach((cluster, index) => {
      const group = element("div", "cluster-group");
      const head = element("div", "cluster-group-head");
      head.append(
        element("strong", "", `Cluster ${index + 1}`),
        element("span", "", `${cluster.members.length} wallets · ${shareText(cluster.share)} supply`),
      );
      const nodes = element("div", "cluster-nodes");
      cluster.members.forEach((address) => {
        const position = positionByAddress.get(address.toLowerCase());
        const node = element("a", "cluster-node");
        node.href = `${EXPLORER_BASE}/address/${address}`;
        node.target = "_blank";
        node.rel = "noreferrer";
        node.title = address;
        if (position?.isCreator) node.classList.add("creator");
        if (position?.isContract) node.classList.add("contract");
        node.append(element("strong", "", shortHash(address, 4, 3)), element("span", "", shareText(position?.share ?? null)));
        nodes.append(node);
      });
      group.append(head, nodes);
      map.append(group);
    });
  }

  const list = byId("holderConnectionList");
  list.replaceChildren();
  for (const connection of connections.slice(0, 8)) {
    const row = element("div", "connection-row");
    const copy = element("div", "connection-copy");
    copy.append(
      element("strong", "", connection.kind === "direct" ? "Direct holder transfer" : "Shared funding source"),
      element("span", "", connection.kind === "direct" ? "Tokens moved directly between these top holders." : "Both top holders received tokens from the same indexed wallet."),
    );
    const links = element("span", "connection-links");
    for (const address of [connection.addressA, connection.addressB]) {
      const link = element("a", "", shortHash(address, 4, 3));
      link.href = `${EXPLORER_BASE}/address/${address}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      links.append(link);
    }
    if (connection.source) {
      const source = element("a", "", "Source");
      source.href = `${EXPLORER_BASE}/address/${connection.source}`;
      source.target = "_blank";
      source.rel = "noreferrer";
      links.append(source);
    } else if (connection.transactionHash) {
      const transaction = element("a", "", "TX");
      transaction.href = `${EXPLORER_BASE}/tx/${connection.transactionHash}`;
      transaction.target = "_blank";
      transaction.rel = "noreferrer";
      links.append(transaction);
    }
    row.append(copy, links);
    list.append(row);
  }
}

function updateWatchToggle(market: MarketPair): void {
  const watched = watchlist.has(market.tokenAddress.toLowerCase());
  const button = byId<HTMLButtonElement>("watchToggle");
  button.classList.toggle("active", watched);
  button.setAttribute("aria-pressed", String(watched));
  localize(button, watched ? "Remove token from watchlist" : "Add token to watchlist", "aria-label");
  localize(button, watched ? "Remove from watchlist" : "Add to watchlist", "title");
  byId("watchIcon").textContent = watched ? "★" : "☆";
}

function renderWatchDigest(): void {
  const section = byId("watchDigest");
  section.classList.toggle("hidden", Boolean(linkedPool));
  if (linkedPool) return;
  const watched = markets.filter(market => watchlist.has(market.tokenAddress.toLowerCase()));
  const events = watched.flatMap(market => (readTracking(poolRef(market))?.alerts ?? []).map(alert => ({ ...alert, market })));
  const onlyNew = byId<HTMLSelectElement>("watchChangeView").value === "new";
  const recent = recentWatchChanges(events, onlyNew ? watchReviewedAt : null, Date.now());
  localize(byId("watchDigestTitle"), "Watchlist changes");
  const covered = new Set(watched.map(market => market.tokenAddress.toLowerCase())).size;
  const checked = watched.filter(market => {
    const detail = detailCache.get(poolCacheKey(market));
    return !market.stale && detail && Date.now() - detail.data.checkedAt < DETAIL_CACHE_TTL_MS
      && detail.data.sources.holders === "fresh" && detail.data.sources.lp === "fresh" && detail.data.sources.creator === "fresh";
  }).length;
  setCopy("watchDigestCoverage", copy("{covered} / {total} watched tokens loaded · {checked} / {pools} pools with recent ownership reads · {state}", { covered, total: watchlist.size, checked, pools: watched.length, state: copy(watchScanRunning ? "Checking" : document.hidden ? "Paused" : "Tab-only monitoring") }));
  setCopy("watchMonitorNote", copy("Up to 3 loaded watched pools checked per minute while this tab is visible. No monitoring while hidden or closed. {review}", { review: watchReviewedAt ? copy("Reviewed {time}.", { time: new Date(watchReviewedAt).toLocaleString() }) : copy("Not reviewed yet.") }));
  byId<HTMLButtonElement>("markWatchReviewed").disabled = recent.length === 0 || marketLoadFailed;
  const list = byId("watchDigestList");
  list.replaceChildren();
  if (!recent.length) {
    list.append(element("p", "watch-digest-empty", copy(watchlist.size === 0 ? "No watched tokens." : covered === 0 ? "Watched tokens are outside the loaded pool coverage." : "No recorded changes in this view. Gaps in observation are not proof of no activity.")));
    return;
  }
  for (const event of recent) {
    const row = element("article", `watch-digest-item ${event.tone}`);
    const title = element("a", "", `${event.market.token.symbol ?? "Token"}: ${event.title}`);
    title.href = marketUrl(location.href, NETWORK!.id, poolRef(event.market));
    const head = element("div", "observed-alert-head");
    head.append(title, element("time", "", `Observed ${relativeTime(event.observedAt)} ago`));
    const evidence = element("a", "watch-evidence-link", event.type === "sell" ? "Indexed pool events" : "Snapshot comparison · source");
    evidence.href = `${EXPLORER_BASE}/${["ownership", "holders"].includes(event.type) ? `token/${event.market.tokenAddress}` : `address/${event.market.pairAddress}`}`;
    evidence.target = "_blank";
    evidence.rel = "noreferrer";
    row.append(head, element("p", "", event.detail), evidence, element("small", "", `Pool ${shortHash(event.market.v4?.poolId ?? event.market.pairAddress)}${event.market.stale ? " · cached now" : ""}`));
    list.append(row);
  }
}

async function checkWatchedPools(): Promise<void> {
  if (watchScanRunning || document.hidden || linkedPool || marketLoadFailed || Date.now() - lastWatchScanAt < AUTO_REFRESH_MS) return;
  const watched = markets.filter(market => !market.stale && watchlist.has(market.tokenAddress.toLowerCase()));
  const batch = nextWatchBatch(watched, market => Math.max(watchCheckAttempts.get(poolCacheKey(market)) ?? 0,
    detailCache.get(poolCacheKey(market))?.data.checkedAt ?? 0), Date.now(), DETAIL_CACHE_TTL_MS);
  if (!batch.length) { renderWatchDigest(); return; }
  lastWatchScanAt = Date.now();
  watchScanRunning = true;
  renderWatchDigest();
  try {
    for (const market of batch) {
      if (document.hidden) break;
      if (!watchlist.has(market.tokenAddress.toLowerCase())) continue;
      watchCheckAttempts.set(poolCacheKey(market), Date.now());
      try {
        const detail = await getMarketDetail(market, false);
        if (!marketLoadFailed && markets.includes(market)) observeDetailChanges(market, detail);
      } catch {
        // A failed read must not replace saved ownership baselines.
      }
      renderWatchDigest();
    }
  } finally {
    watchScanRunning = false;
    renderWatchDigest();
  }
}

function renderObservedAlerts(market: MarketPair): void {
  renderWatchDigest();
  const watched = watchlist.has(market.tokenAddress.toLowerCase());
  const section = byId("observedAlertSection");
  section.classList.toggle("hidden", !watched);
  if (!watched) return;
  const tracking = readTracking(poolRef(market)) ?? startTracking(market);
  const alerts = tracking.alerts ?? [];
  setCopy("observedAlertCount", copy("{count} events", { count: alerts.length }));
  const list = byId("observedAlertList");
  list.replaceChildren();
  if (alerts.length === 0) {
    list.append(element("div", "observed-alert-empty", "No material change has been observed from the saved baseline."));
  } else {
    for (const alert of alerts.slice(0, 12)) {
      const row = element("div", `observed-alert-row ${alert.tone}`);
      const head = element("div", "observed-alert-head");
      const time = element("time", "", `${relativeTime(alert.observedAt)} ago`);
      time.dateTime = alert.observedAt;
      head.append(element("strong", "", alert.title), time);
      const type = element("span", "observed-alert-type", alert.type);
      row.append(head, element("p", "", alert.detail), type);
      list.append(row);
    }
  }
  const started = new Date(tracking.startedAt);
  const baseline = Number.isFinite(started.getTime())
    ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(started)
    : "this browser";
  setCopy("observedAlertNote", copy("Baseline {time} · stored in this browser.", { time: baseline }));
}

function exitEstimate(market: MarketPair, supplyPercent: number): { impact: number; output: number } | null {
  const supply = decimalValue(market.token.total_supply, market.token.decimals);
  const amountIn = supply * (supplyPercent / 100);
  if (market.v4 || market.v3 || amountIn <= 0 || market.tokenReserve === null || market.usdcReserve === null || market.tokenReserve <= 0 || market.usdcReserve <= 0) return null;
  const amountAfterFee = amountIn * 0.997;
  const output = (amountAfterFee * market.usdcReserve) / (market.tokenReserve + amountAfterFee);
  const idealOutput = amountIn * (market.usdcReserve / market.tokenReserve);
  const impact = idealOutput > 0 ? Math.max(0, (1 - output / idealOutput) * 100) : 0;
  return { impact, output };
}

function renderExitCurve(market: MarketPair): void {
  const chart = byId<SVGSVGElement>("exitCurve");
  chart.replaceChildren();
  const percentages = [0.1, 0.5, 1, 2, 5];
  const estimates = percentages.map((percent) => ({ percent, estimate: exitEstimate(market, percent) }));
  if (estimates.some((entry) => entry.estimate === null)) {
    const label = svgNode("text", { x: "12", y: "36", class: "chart-label" });
    label.textContent = "Pool reserves are unavailable.";
    chart.append(label);
    localize(byId("exitEstimate"), "Unavailable");
    return;
  }
  const width = 440;
  const height = 170;
  const padding = { top: 16, right: 8, bottom: 12, left: 42 };
  const impacts = estimates.map((entry) => entry.estimate!.impact);
  const maxImpact = Math.max(5, Math.ceil(Math.max(...impacts) / 5) * 5);
  const x = (index: number) => padding.left + (index / (estimates.length - 1)) * (width - padding.left - padding.right);
  const y = (impact: number) => padding.top + (1 - impact / maxImpact) * (height - padding.top - padding.bottom);
  for (let index = 0; index < 3; index += 1) {
    const impact = maxImpact * (1 - index / 2);
    const rowY = y(impact);
    chart.append(svgNode("line", { x1: String(padding.left), y1: String(rowY), x2: String(width - padding.right), y2: String(rowY), class: "chart-grid" }));
    const label = svgNode("text", { x: "0", y: String(rowY + 3), class: "chart-label" });
    label.textContent = `${impact.toFixed(0)}%`;
    chart.append(label);
  }
  const path = estimates.map((entry, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(entry.estimate!.impact).toFixed(2)}`).join(" ");
  const baseline = height - padding.bottom;
  chart.append(
    svgNode("path", { d: `${path} L${x(estimates.length - 1)},${baseline} L${x(0)},${baseline} Z`, class: "exit-area" }),
    svgNode("path", { d: path, class: "exit-line" }),
  );
  estimates.forEach((entry, index) => chart.append(svgNode("circle", { cx: String(x(index)), cy: String(y(entry.estimate!.impact)), r: "4", class: "exit-dot" })));
  const onePercent = estimates.find((entry) => entry.percent === 1)!.estimate!;
  setCopy("exitEstimate", copy("1% -> {amount} USDC · {impact}% impact", { amount: formatValue(onePercent.output, 3), impact: onePercent.impact.toFixed(1) }));
}

function renderPoolComparison(market: MarketPair): void {
  const peers = groupTokenPools(markets.filter(entry => entry.chainId === market.chainId && entry.tokenAddress.toLowerCase() === market.tokenAddress.toLowerCase()))[0]?.pools ?? [market];
  const select = byId<HTMLSelectElement>("poolSelector");
  select.replaceChildren();
  for (const peer of peers) {
    const option = element("option", "", `${adapterFor(peer).source.label}${peer.v3 ? ` · ${peer.v3.fee / 10_000}%` : ""} · ${shortHash(peer.v4?.poolId ?? peer.pairAddress)} · ${formatValue(peer.totalLiquidity)} USDC`);
    option.value = poolRef(peer);
    select.append(option);
  }
  select.value = poolRef(market);
  select.disabled = peers.length < 2;
  setCopy("poolComparisonNote", copy("Loaded pools: {count}. Pool-specific prices, not executable quotes. Order: available price, fresh reads, known liquidity, then latest observed trade.", { count: peers.length }));
  const list = byId("poolComparisonList");
  list.replaceChildren();
  for (const peer of peers) {
    const row = element("div", "pool-comparison-row");
    const link = element("a", "", shortHash(peer.v4?.poolId ?? peer.pairAddress));
    link.href = marketUrl(location.href, NETWORK!.id, poolRef(peer));
    link.setAttribute("aria-label", `Open pool ${peer.pairAddress}`);
    const quote = element("span");
    quote.append(priceElement(peer.currentPrice));
    row.append(link, quote, element("span", "", `${formatValue(peer.totalLiquidity)} USDC`),
      element("small", "", copy("{state}{partial} · {trade}", { state: copy(peer.stale ? "Cached" : "Fetched"), partial: copy(peer.historyTruncated ? " · Partial history" : ""), trade: peer.lastTradeAt ? copy("trade {time}", { time: relativeTime(peer.lastTradeAt) }) : copy("no trades") })));
    list.append(row);
  }
}

function renderAuthority(market: MarketPair): void {
  const key = `${market.chainId}:${market.tokenAddress.toLowerCase()}`;
  const entry = authorityReads.get(key);
  const button = byId<HTMLButtonElement>("readAuthority");
  const cooling = Boolean(entry && Date.now() - entry.attemptedAt < 60_000);
  button.disabled = !NETWORK || Boolean(authorityRunning) || cooling;
  localize(button, authorityRunning === key ? "Reading..." : entry ? "Read again" : "Read state");
  localize(button, cooling ? "Public RPC cooldown: one request per token per minute." : "Read selected contract getters without connecting a wallet", "title");
  const status = byId("authorityStatus");
  localize(status, authorityRunning === key ? "Reading verified ABI and public RPC state..."
    : entry?.error ? entry.error : entry?.snapshot?.block ? "Fixed-block snapshot. Values may have changed since this read."
      : entry?.snapshot ? "State not read: no supported verified getters available." : "No state snapshot requested.");
  const provenance = byId("authoritySource");
  const rows = byId("authorityRows");
  provenance.replaceChildren();
  rows.replaceChildren();
  const snapshot = entry?.snapshot;
  if (!snapshot) return;
  const sourceLink = (label: string, path: string) => {
    const link = element("a", "", label);
    link.href = `${EXPLORER_BASE}${path}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    return link;
  };
  provenance.append(element("span", "", `${NETWORK!.label} / Checked ${new Date(snapshot.checkedAt).toLocaleString()}`));
  if (snapshot.block) {
    provenance.append(sourceLink(`Block ${snapshot.block.number}`, `/block/${snapshot.block.number}`),
      element("span", "", `Block time ${new Date(snapshot.block.timestamp).toLocaleString()}`));
  }
  for (const address of snapshot.abiAddresses) provenance.append(sourceLink(`ABI ${shortHash(address)}`, `/address/${address}?tab=contract`));
  const unchecked = element("details", "authority-unchecked");
  const uncheckedCount = snapshot.rows.filter(item => item.state === "unsupported").length;
  unchecked.append(element("summary", "", copy("{count} checks unavailable from ABI", { count: uncheckedCount })));
  for (const item of snapshot.rows) {
    const row = element("div", "authority-row");
    const value = element("div", "authority-value");
    value.append(element("strong", "", item.state === "unsupported" || item.value === "Unavailable" ? copy(item.value) : item.value));
    if (item.addresses?.length) {
      const addresses = element("div", "authority-addresses");
      for (const address of item.addresses) addresses.append(sourceLink(address, `/address/${address}`));
      // Addresses remain inspectable in full without repeating a single getter value.
      if (item.addresses.length === 1 && item.value === item.addresses[0]) value.replaceChildren();
      value.append(addresses);
    }
    value.append(element("small", "", copy(item.note)));
    row.append(element("span", "", copy(item.label)), value);
    (item.state === "unsupported" ? unchecked : rows).append(row);
  }
  if (uncheckedCount) rows.append(unchecked);
  for (const note of snapshot.notes) rows.append(element("p", "authority-note", copy(note)));
}

async function readSelectedAuthority(): Promise<void> {
  const market = markets.find(entry => poolRef(entry) === selectedPair);
  if (!market || !NETWORK || authorityRunning) return;
  const key = `${market.chainId}:${market.tokenAddress.toLowerCase()}`;
  const previous = authorityReads.get(key);
  if (previous && Date.now() - previous.attemptedAt < 60_000) return;
  const entry: { attemptedAt: number; snapshot?: AuthoritySnapshot; error?: string } = { attemptedAt: Date.now() };
  authorityReads.set(key, entry);
  authorityRunning = key;
  renderAuthority(market);
  const renderSelected = () => {
    const current = markets.find(item => poolRef(item) === selectedPair);
    if (current) renderAuthority(current);
  };
  try { entry.snapshot = await readAuthoritySnapshot(NETWORK, market.tokenAddress); }
  catch (error) { entry.error = error instanceof Error && error.name !== "AbortError" && error.name !== "TimeoutError"
    ? error.message : "State read timed out. No current values are assumed."; }
  finally {
    authorityRunning = "";
    renderSelected();
    window.setTimeout(renderSelected, Math.max(0, 60_000 - (Date.now() - entry.attemptedAt)) + 50);
  }
}

function renderTokenAnalysis(market: MarketPair, detail: MarketDetail): void {
  const analysis = analyzeToken(market, detail);
  const headline = byId("analysisHeadline");
  headline.className = `analysis-headline ${analysis.tone}`;
  localize(headline, analysis.headline);
  localize(byId("analysisSummary"), analysis.summary);
  localize(byId("analysisWindow"), copy("1H window ending {time}.", { time: formatAnalysisTime(analysis.asOf) }));
  const list = byId("analysisEvidence");
  list.replaceChildren();
  for (const item of analysis.evidence) {
    const row = element("li", "");
    row.append(element("span", "", item.text));
    const path = item.source === "transaction" && /^0x[0-9a-f]{64}$/i.test(item.transactionHash ?? "") ? `/tx/${item.transactionHash}`
      : item.source === "holders" ? `/token/${market.tokenAddress}?tab=holders` : `/address/${market.pairAddress}?tab=logs`;
    const label = item.source === "transaction" ? "View event" : item.source === "holders" ? "Holder index"
      : market.v4 ? "PoolManager events (all pools)" : "Pool events";
    const link = element("a", "", copy(label));
    link.href = `${EXPLORER_BASE}${path}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    row.append(link);
    list.append(row);
  }
  if (!analysis.evidence.length) list.append(element("li", "", copy("No current evidence is eligible for this readout.")));
  const limits = byId("analysisLimits");
  limits.replaceChildren(...analysis.limits.map(message => element("li", "", message)));
}

function discoveryActivityCopy(market: MarketPair): UiCopy {
  const activity = observationActivity(market);
  return !activity ? copy("Current observation unavailable") : copy("1H: swaps in {count}/12 five-minute windows{partial}", {
    count: activity.windows, partial: copy(market.historyTruncated ? " · partial history" : ""),
  });
}

function renderDiscoveries(): void {
  const view = byId<HTMLSelectElement>("discoveryView").value;
  const now = Date.now();
  const available = markets.filter(market => observations.get(poolCacheKey(market)));
  const matches = available.filter(market => view === "new" ? validObservationTime(market.createdAt, now) && now - Date.parse(market.createdAt) <= DAY_MS
    : view === "follow" ? (observationActivity(market, now)?.windows ?? 0) >= 3 : true)
    .sort((a, b) => (view === "new" ? (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
      : view === "follow" ? (observationActivity(b, now)?.windows ?? 0) - (observationActivity(a, now)?.windows ?? 0) : 0)
      || observations.get(poolCacheKey(b))!.first.at - observations.get(poolCacheKey(a))!.first.at
      || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const list = byId("discoveryJournalList");
  list.replaceChildren();
  setCopy("discoveryJournalCount", copy("{shown} / {total} matching loaded pools", { shown: Math.min(6, matches.length), total: matches.length }));
  setCopy("observationStorage", observations.persistent ? "Browser-local history · Up to 150 pools / 30 days · No collection while closed."
    : "Storage unavailable: history lasts for this tab only.");
  if (!matches.length) list.append(element("p", "brief-empty", copy("No matching pool in the current loaded coverage.")));
  for (const market of matches.slice(0, 6)) {
    const record = observations.get(poolCacheKey(market))!;
    const row = element("article", "discovery-journal-row");
    const title = element("a", "discovery-journal-token", market.token.symbol || market.token.name || "Token");
    title.href = marketUrl(location.href, NETWORK!.id, poolRef(market));
    title.addEventListener("click", async event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      await selectMarket(market, false);
      if (selectedPair === poolRef(market)) byId("marketDetailContent").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    row.append(title, element("small", "", copy("Pool {address} · Created {time}", { address: shortHash(market.v4?.poolId ?? market.pairAddress), time: validObservationTime(market.createdAt, now) ? formatAnalysisTime(Date.parse(market.createdAt)) : "--" })),
      element("span", "", discoveryActivityCopy(market)),
      element("small", "", copy("First observed {time}", { time: formatAnalysisTime(record.first.at) })));
    const delta = observationFresh(market, now) ? observationDelta(record.first.price, record.latest.price) : null;
    row.append(element("span", "discovery-journal-change", copy("Price since first observation: {change}", { change: delta === null ? "--" : formatChange(delta) })));
    list.append(row);
  }
}

function renderObservationTimeline(market: MarketPair, detail: MarketDetail): void {
  const key = poolCacheKey(market);
  let record = observations.get(key);
  const list = byId("observationTimeline");
  const comparisons = byId("observationComparison");
  list.replaceChildren(); comparisons.replaceChildren();
  if (!record) { setCopy("observationSummary", "No fresh baseline recorded for this pool yet."); setCopy("observationTimelineCount", ""); return; }
  if (observationFresh(market, Date.now())) {
    const updated = observeOwnership(record, detail);
    if (updated !== record) { observations.set(updated); observations.save(); record = updated; }
  }
  const fresh = observationFresh(market, Date.now());
  setCopy("observationSummary", copy("First observed {first} · Last recorded {last}{state}", { first: formatAnalysisTime(record.first.at), last: formatAnalysisTime(record.latest.at),
    state: copy(fresh ? "" : " · Historical only; current comparison withheld") }));
  const metrics: Array<[string, keyof Pick<ObservationSnapshot, "price" | "reserve" | "holders" | "top10">]> = [
    ["Pool price (USDC)", "price"], ["Quote reserve (USDC)", "reserve"], ["Holder addresses", "holders"], ["Top 10 share", "top10"],
  ];
  const formatMetric = (value: number | null, key: string): string => value === null ? "--" : key === "price" ? priceFormat(value).full
    : key === "top10" ? shareText(value) : key === "holders" ? fullNumber(value) : value > 0 && value < 0.001 ? "<0.001" : formatValue(value, 3);
  for (const [label, metric] of metrics) {
    const before = record.first[metric];
    const current = fresh ? record.latest[metric] : null;
    const after = metric === "top10" && record.first.scope !== record.latest.scope ? null : current;
    const delta = metric === "price" || metric === "reserve" ? observationDelta(before, after) : before !== null && after !== null ? after - before : null;
    const row = element("div", "observation-comparison-row");
    row.append(element("span", "", copy(label)), element("span", "", formatMetric(before, metric)), element("span", "", formatMetric(after, metric)),
      element("strong", "", delta === null ? "--" : metric === "holders" ? `${delta > 0 ? "+" : ""}${fullNumber(delta)}`
        : metric === "top10" ? `${delta > 0 ? "+" : ""}${delta.toFixed(2)} pp` : formatChange(delta)));
    comparisons.append(row);
  }
  const entries: Array<{ at: number; message: UiCopy; hash?: string; observedAt?: number }> = [];
  if (validObservationTime(market.createdAt, Date.now()) && /^0x[0-9a-f]{64}$/i.test(market.creationTx)) {
    entries.push({ at: Date.parse(market.createdAt), message: copy("Pool creation indexed"), hash: market.creationTx });
  }
  entries.push({ at: record.first.at, message: copy("First browser observation; not the token launch") });
  const firstSwap = record.events.find(event => event.kind === "buy" || event.kind === "sell");
  for (const event of record.events) {
    const amount = event.amount < 0.001 ? "<0.001" : formatValue(event.amount, 3);
    entries.push({ at: event.at, observedAt: event.observedAt, hash: event.hash, message: copy("{event}: {amount} USDC{first}", {
      event: copy(event.kind === "buy" ? "Indexed buy" : event.kind === "sell" ? "Indexed sell" : event.kind === "add" ? "Indexed liquidity addition" : "Indexed liquidity removal"),
      amount, first: copy(event === firstSwap ? " · earliest swap retained, not necessarily the first trade" : ""),
    }) });
  }
  const samples = [record.first, ...record.history.filter(sample => sample.at < record!.latest.at), record.latest];
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1], after = samples[i];
    if (before.at === after.at) continue;
    const price = observationDelta(before.price, after.price), reserve = observationDelta(before.reserve, after.reserve);
    const changes: UiCopy[] = [];
    if (price !== null && Math.abs(price) >= 5) changes.push(copy("Price {change}", { change: formatChange(price) }));
    if (reserve !== null && Math.abs(reserve) >= 10) changes.push(copy("Quote reserve {change}", { change: formatChange(reserve) }));
    if (before.holders !== null && after.holders !== null && before.holders !== after.holders) changes.push(copy("Holder addresses {before} → {after}", { before: before.holders, after: after.holders }));
    if (before.top10 !== null && after.top10 !== null && before.scope === after.scope && Math.abs(after.top10 - before.top10) >= 3) changes.push(copy("Top 10 share {before}% → {after}%", { before: before.top10.toFixed(2), after: after.top10.toFixed(2) }));
    for (const change of changes) entries.push({ at: after.at, message: copy("{change} · compared with the read at {time}", { change, time: formatAnalysisTime(before.at) }) });
  }
  entries.sort((a, b) => a.at - b.at);
  const shown = entries.length <= 12 ? entries : [...entries.slice(0, 2), ...entries.slice(-10)];
  for (const entry of shown) {
    const row = element("li", "observation-event");
    row.append(element("time", "", formatAnalysisTime(entry.at)), element("span", "", entry.message));
    if (entry.observedAt) row.append(element("small", "", copy("Indexed event time above · Observed {time}", { time: formatAnalysisTime(entry.observedAt) })));
    if (entry.hash) {
      const link = element("a", "", copy("View event"));
      link.href = `${EXPLORER_BASE}/tx/${entry.hash}`; link.target = "_blank"; link.rel = "noopener noreferrer";
      row.append(link);
    }
    list.append(row);
  }
  setCopy("observationTimelineCount", copy("{shown} / {total} retained timeline entries", { shown: shown.length, total: entries.length }));
}

let quoteComparison: ReturnType<typeof createQuoteComparison> | null = null;
function renderDetail(market: MarketPair, detail: MarketDetail, enrichmentOnly = false): void {
  quoteComparison ??= createQuoteComparison();
  quoteComparison.select(market);
  renderTokenAnalysis(market, detail);
  renderObservationTimeline(market, detail);
  const venue = configuredVenue(NETWORK!, market.sourceId);
  setCopy("selectedVenue", copy("Data source: {source} · {network}", { source: venue?.name ?? market.sourceId, network: NETWORK!.label }));
  if (!enrichmentOnly) void refreshRecorderDetail(market);
  setCopy("priceFreshness", copy("{event}. Source fetched: {fetched}. Quiet trading and indexing delays are not distinguished.", {
    event: priceAgeCopy(market), fetched: market.priceFetchedAt === null ? copy("Unavailable") : copy("{time} ago", { time: relativeTime(new Date(market.priceFetchedAt).toISOString()) }),
  }));
  renderAuthority(market);
  renderPoolComparison(market);
  byId("marketTokenMark").textContent = (market.token.symbol || market.token.name || "?").slice(0, 2).toUpperCase();
  byId("marketTokenName").textContent = market.token.name || "Unnamed token";
  byId("marketTokenSymbol").textContent = market.token.symbol || "--";
  const tokenLink = byId<HTMLAnchorElement>("marketTokenAddress");
  tokenLink.textContent = shortHash(market.tokenAddress, 7, 5);
  tokenLink.href = `${EXPLORER_BASE}/token/${market.tokenAddress}`;
  updateWatchToggle(market);
  renderObservedAlerts(market);

  const detailPrice = byId("detailPrice");
  const formattedPrice = priceFormat(market.currentPrice);
  detailPrice.replaceChildren(...priceElement(market.currentPrice, true).childNodes);
  detailPrice.title = formattedPrice.full === "--" ? "Price unavailable" : `${formattedPrice.full} USDC`;
  detailPrice.setAttribute("aria-label", formattedPrice.full === "--" ? "Price unavailable" : `${formattedPrice.full} USDC`);
  const detailChange = byId("detailPriceChange");
  detailChange.textContent = `24H ${compactChange(market.periods.h24.priceChange)}`;
  detailChange.className = changeClass(market.periods.h24.priceChange);
  setCopy("detailFdv", market.fdv === null ? "Unavailable" : copy("{value} USDC", { value: formatValue(market.fdv) }));
  byId("detailLiquidity").textContent = `${formatValue(market.totalLiquidity)} USDC`;
  setCopy("detailLiquidityNote", market.v3 ? "v3 liquidity unavailable" : market.v4 ? "v4 liquidity unavailable" : copy("{amount} USDC exit side · {source}", { amount: formatValue(market.usdcReserve), source: copy(market.reserveSource === "sync" ? "Sync reserves" : "balance fallback") }));
  byId("detailHolders").textContent = fullNumber(market.token.holders_count);

  const change = byId("priceChange");
  change.textContent = formatChange(market.priceChange);
  change.className = changeClass(market.priceChange);
  renderWindowMetrics(market);
  if (!enrichmentOnly) renderPriceChart(market);

  const recent = market.periods.h24;
  byId("detailBuys").textContent = String(recent.buyCount);
  byId("detailSells").textContent = String(recent.sellCount);
  byId("detailVolume").textContent = `${formatValue(recent.volumeUsdc, 3)} USDC`;
  setCopy("detailLastTrade", market.lastTradeAt ? copy("{time} ago", { time: relativeTime(market.lastTradeAt) }) : "None");
  const totalFlow = Math.max(1, recent.buyCount + recent.sellCount);
  byId<HTMLElement>("detailBuyBar").style.width = `${(recent.buyCount / totalFlow) * 100}%`;
  byId<HTMLElement>("detailSellBar").style.width = `${(recent.sellCount / totalFlow) * 100}%`;
  renderTradeTape(market, detail);
  renderWalletSignals(market, detail);
  renderLiquidityMonitor(market, detail);
  renderHolders(market, detail);
  renderHolderConnections(detail);

  const warnings = buildWarnings(market, detail);
  const summary = evidenceSummary(warnings);
  setCopy("warningCount", copy("{indexed} indexed · {calculated} calculated · {unverified} unverified", { indexed: summary.observed, calculated: summary.estimates, unverified: summary.unverified }));
  const badge = byId("riskBadge");
  badge.className = "risk-badge";
  localize(badge, summary.label);
  localize(badge, "Evidence completeness, not a risk score or safety verdict.", "title");
  setCopy("evidenceFreshness", copy("Market: {market} · Contract: {contract} · Holders: {holders} · No safety score", { market: copy(market.stale ? "Cached" : "Fetched"), contract: copy(detail.sources.contract), holders: copy(detail.sources.holders) }));
  const sources = byId("evidenceSources");
  sources.replaceChildren();
  for (const [label, path] of [["Token contract", `/address/${market.tokenAddress}?tab=contract`], [market.v4 ? "PoolManager events (all pools)" : "Pool events", `/address/${market.pairAddress}?tab=logs`], ["Holder index", `/token/${market.tokenAddress}?tab=holders`]]) {
    const link = element("a", "", copy(label));
    link.href = `${EXPLORER_BASE}${path}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    sources.append(link);
  }
  const list = byId("marketWarnings");
  list.replaceChildren();
  for (const warning of warnings) {
    const row = element("div", `warning-item ${warning.tone}`);
    const copyBlock = element("div", "warning-copy");
    copyBlock.append(element("small", `evidence-label ${warning.basis}`, copy(warning.basis === "observed" ? "Indexed event" : warning.basis === "estimate" ? "Calculated" : "Unverified")), element("strong", "", copy(warning.title)), element("span", "", typeof warning.detail === "string" ? copy(warning.detail) : warning.detail));
    row.append(element("span", "warning-dot"), copyBlock);
    list.append(row);
  }
  renderExitCurve(market);
  setDetailState("content");
}

async function getMarketDetail(market: MarketPair, force: boolean): Promise<MarketDetail> {
  const key = poolCacheKey(market);
  const scope = [...knownTokenPools(market, markets)].sort().join(",");
  const cached = detailCache.get(key);
  if (!force && cached && cached.data.poolScope === scope && Date.now() - cached.data.checkedAt < DETAIL_CACHE_TTL_MS) return cached.data;
  const flightKey = `${key}:${scope}`;
  const running = detailFlights.get(flightKey);
  if (running) return running;
  const request = fetchMarketDetail(market, force).then(detail => {
    if (cached) {
      const previous = cached.data;
      detail.analysisPrevious = { checkedAt: previous.checkedAt, poolScope: previous.poolScope, top10Share: previous.top10Share,
        sources: { holders: previous.sources.holders }, holderHistoryPartial: previous.holderHistoryPartial };
    }
    detailCache.set(key, { data: detail, savedAt: Date.now() });
    return detail;
  });
  detailFlights.set(flightKey, request);
  try { return await request; }
  finally { detailFlights.delete(flightKey); }
}

function launchRowCopy(origin?: LaunchOrigin): UiCopy {
  return origin?.status === "verified" ? copy("Launch: {platform}", { platform: origin.evidence.platform.name })
    : copy(origin?.status === "unavailable" ? "Launch: lookup failed" : origin ? "Launch: unconfirmed" : "Launch: not checked");
}

function renderLaunchOrigin(origin?: LaunchOrigin): void {
  setCopy("launchOriginStatus", origin?.status === "verified"
    ? copy("{platform} · creation verified", { platform: origin.evidence.platform.name })
    : origin?.status === "unknown" ? "Unconfirmed in checked records"
      : origin?.status === "unavailable" ? "Launch lookup unavailable"
        : origin?.status === "unsupported" ? "No supported launchpad on this network" : "Checking issuance...");
  const links = byId("launchOriginLinks");
  links.replaceChildren();
  if (origin?.status === "verified") {
    const { evidence } = origin;
    for (const [label, url] of [
      ["Creation transaction", `${EXPLORER_BASE}/tx/${evidence.transactionHash}`],
      ["Launch contract", `${EXPLORER_BASE}/address/${evidence.platform.emitter}`],
      ["Platform documentation", evidence.platform.docs],
    ]) {
      const link = element("a", "", copy(label!));
      link.href = url!; link.target = "_blank"; link.rel = "noopener noreferrer"; links.append(link);
    }
  }
  setCopy("launchOriginScope", origin?.status === "verified"
    ? "Contract origin only. The website used and token safety are not verified."
    : origin?.status === "unknown"
      ? copy("ArcPad only: available pool-creation receipt + blocks {from}–{to}. Unconfirmed does not mean directly deployed.", { from: origin.fromBlock.toLocaleString("en-US"), to: origin.toBlock.toLocaleString("en-US") })
      : "ArcPad creation records only; other platforms and older records may be unconfirmed.");
}

async function loadLaunchOrigin(market: MarketPair): Promise<void> {
  const requestId = detailRequest;
  renderLaunchOrigin(rpcReader?.launches.peek(market.tokenAddress));
  const origin: LaunchOrigin = rpcReader ? await rpcReader.launches.read(market)
    : { status: "unsupported", checkedAt: Date.now() };
  for (const label of document.querySelectorAll<HTMLElement>("[data-launch-token]")) {
    if (label.dataset.launchToken === market.tokenAddress.toLowerCase()) localize(label, launchRowCopy(origin));
  }
  if (requestId === detailRequest && selectedPair === poolRef(market)) renderLaunchOrigin(origin);
}

function unavailableMarketDetail(poolScope: string): MarketDetail {
  return {
    checkedAt: 0,
    sources: { holders: "unavailable", lp: "unavailable", contract: "unavailable", creator: "unavailable", transfers: "unavailable", senders: "unavailable" },
    poolScope, holderHistoryPartial: true, lpHistoryPartial: true, burnedTokenShare: null,
    capabilities: [], contractVisible: false, creatorShare: null, holderClusters: [],
    holderConnections: [], holderPositions: [], lpBurnedShare: null, lpTopHolderIsContract: false,
    lpTopHolderShare: null, poolShare: null, top1Share: null, top5Share: null, top10Share: null,
    transferHistoryTruncated: true, transactionSenders: {}, walletSignals: [],
  };
}

async function loadDetail(market: MarketPair, force = false): Promise<void> {
  document.body.classList.add("detail-open");
  const url = marketUrl(location.href, NETWORK!.id, poolRef(market));
  byId<HTMLAnchorElement>("fullMarketLink").href = url;
  byId<HTMLButtonElement>("copyMarketLink").disabled = false;
  setCopy("shareMarketStatus", "");
  if (linkedPool) document.title = `${market.token.symbol ?? "Token"} | ARCROW`;
  const requestId = ++detailRequest;
  const key = poolCacheKey(market);
  const cached = detailCache.get(key);
  const poolScope = [...knownTokenPools(market, markets)].sort().join(",");
  setCopy("detailCheckStatus", "");
  renderLaunchOrigin(rpcReader?.launches.peek(market.tokenAddress));
  if (!force && cached && cached.data.poolScope === poolScope && Date.now() - cached.savedAt < DETAIL_CACHE_TTL_MS) {
    if (requestId === detailRequest && selectedPair === poolRef(market)) renderDetail(market, cached.data);
    void loadLaunchOrigin(market);
    return;
  }
  // Price, chart and trades are already loaded. Optional RPC checks must not hide them.
  renderDetail(market, unavailableMarketDetail(poolScope));
  setCopy("detailCheckStatus", "Additional checks in progress...");
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (requestId !== detailRequest || selectedPair !== poolRef(market)) return;
  void loadLaunchOrigin(market);
  try {
    const detail = await getMarketDetail(market, force);
    if (requestId !== detailRequest || selectedPair !== poolRef(market)) return;
    if (!market.stale) observeDetailChanges(market, detail);
    renderDetail(market, detail, true);
    setCopy("detailCheckStatus", "");
  } catch {
    if (requestId !== detailRequest || selectedPair !== poolRef(market)) return;
    setCopy("detailCheckStatus", "Additional checks unavailable. Market data remains visible.");
  }
}

async function selectMarket(market: MarketPair, scrollOnMobile: boolean): Promise<void> {
  selectedPair = poolRef(market);
  activeWalletSignalFilter = "all";
  renderMarketRows();
  if (!linkedPool) {
    document.body.classList.add("detail-open");
    byId("closeMarketDetail").focus({ preventScroll: true });
  }
  const detail = loadDetail(market);
  if (scrollOnMobile && window.matchMedia("(max-width: 960px)").matches) {
    byId("marketDetailContent").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  await detail;
}

function setNotice(message?: string | UiCopy): void {
  const notice = byId("dataNotice");
  localize(notice, message ?? "");
  notice.classList.toggle("hidden", !message);
}

async function readDiscoveryPage(path: string, force = false): Promise<FetchResult<LogResponse>> {
  let page = discoveryPages.get(path);
  if (!page) {
    page = fetchData<LogResponse>(path, 60_000, force);
    discoveryPages.set(path, page);
    void page.catch(() => { if (discoveryPages.get(path) === page) discoveryPages.delete(path); });
  }
  return page;
}

async function initializeMarketDashboard(): Promise<void> {
  if (localMarketMode) {
    await loadDashboard();
    if (!markets.length) await restoreCachedMarkets();
  } else {
    await restoreCachedMarkets();
    await loadDashboard();
  }
}

async function restoreCachedMarkets(): Promise<void> {
  if (!rpcReader || !NETWORK || linkedPool || linkedToken || routeError) return;
  try {
    const seeds = cachedPoolSeeds(localStorage, CACHE_PREFIX, selectDexAdapters(dexAdapters, activeProtocol), Date.now(),
      (adapter, page) => rememberFactoryPage(localStorage, CACHE_PREFIX, adapter, page));
    const restored = await mapLimited(seeds, 8, seed => loadMarketPair(seed, false, { cachedOnly: true }));
    const existing = new Map(markets.map(market => [poolRef(market), market]));
    for (const market of restored) if (market && !existing.has(poolRef(market)) && existing.size < MAX_MARKETS) existing.set(poolRef(market), market);
    markets = [...existing.values()];
    if (!markets.length) return;
    marketLimit = Math.min(MAX_MARKETS, Math.max(MARKET_LIMIT, markets.length));
    hasMoreMarkets = markets.length < MAX_MARKETS;
    discoveryLimited = true;
    selectedPair = "";
    renderMarketRows();
    renderDiscoveryControls();
    setCopy("lastUpdated", "Saved snapshot · awaiting update");
  } catch { /* Storage must never prevent a live load. */ }
}

function nextRefreshSeeds(): MarketPair[] {
  const selected = markets.find(market => poolRef(market) === selectedPair);
  const others = markets.filter(market => market !== selected);
  const count = Math.min(others.length, MARKET_LIMIT - (selected ? 1 : 0));
  const batch = Array.from({ length: count }, (_, offset) => others[(refreshCursor + offset) % others.length]!);
  refreshCursor = others.length ? (refreshCursor + count) % others.length : 0;
  return selected ? [selected, ...batch] : batch;
}

async function loadRpcMarkets(force: boolean, extend: boolean): Promise<boolean> {
  let seeds: PairSeed[];
  let sourceStale = false;
  const discover = (markets.length < MARKET_LIMIT || force || extend) && markets.length < MAX_MARKETS;
  if (force && discover) { discoveryPages.clear(); marketLimit = MARKET_LIMIT; }
  if (discover) {
    const discovery = await discoverDexPools(selectDexAdapters(dexAdapters, activeProtocol), marketLimit, path => readDiscoveryPage(path, force), activeProtocol === "all");
    const existing = new Set(markets.map(poolRef));
    const candidates = discovery.seeds.filter(seed => force || !existing.has(poolRef(seed)));
    seeds = candidates.slice(0, Math.min(MARKET_LIMIT, MAX_MARKETS - markets.length + candidates.filter(seed => existing.has(poolRef(seed))).length));
    hasMoreMarkets = discovery.hasMore || candidates.length > seeds.length;
    discoveryLimited = discovery.limited;
    sourceStale = discovery.stale;
  } else seeds = nextRefreshSeeds();
  markets = markets.map(market => ({ ...market, stale: true }));
  renderMarketRows();
  failedMarketCount = 0;
  loadProgress = { completed: 0, total: seeds.length, refreshing: !discover };
  renderDiscoveryControls();
  let successful = 0;
  let fetchedStale = false;
  await mapLimited(seeds, 3, async seed => {
    const market = await loadMarketPair(seed, force, { quick: true });
    const index = markets.findIndex(entry => poolRef(entry) === poolRef(seed));
    if (market) {
      successful++;
      fetchedStale ||= market.stale;
      if (index >= 0) markets[index] = market;
      else if (markets.length < MAX_MARKETS) markets.push(market);
    } else {
      failedMarketCount++;
      if (index >= 0) markets[index] = { ...markets[index]!, stale: true };
    }
    loadProgress.completed++;
    // Publish each finished pool without clearing previously loaded rows.
    renderMarketRows();
    renderDiscoveryControls();
  });
  if (seeds.length && !successful) throw new Error("All discovered pools failed to load. Market activity is unknown. Retry with Refresh.");
  const shown = visibleMarkets();
  if (!shown.some(market => poolRef(market) === selectedPair)) selectedPair = "";
  const selected = markets.find(market => poolRef(market) === selectedPair);
  if (selected) void loadDetail(selected, force);
  else { detailRequest++; setDetailState("empty"); }
  return sourceStale || fetchedStale;
}

async function queueLocalMarkets(kind: "pool" | "token" | "creation", addresses: string[]): Promise<void> {
  if (!rpcReader || !localRecorderAvailable(new URL(location.href)) || !NETWORK || !addresses.length) return;
  try {
    await fetch(`/api/arcrow/markets?network=${NETWORK.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, addresses: [...new Set(addresses)].slice(0, 20) }),
      signal: AbortSignal.timeout(3000), credentials: "omit", redirect: "error",
    });
  } catch { /* A later snapshot read reports feed availability. */ }
}

function localFeedNotice(feed: MarketFeed): UiCopy | null {
  const report = feed.collection;
  if (report?.failureCount) {
    const reasons = {
      "rate-limit": "RPC request limit",
      "request-timeout": "RPC response failure or timeout",
      "upstream-error": "RPC server error",
      "invalid-data": "Data validation failed",
      "unknown": "Unclassified error",
    };
    const latest = report.failures.at(-1);
    return copy("Background read failures: {count} · Latest: {reason}. Original data timestamps are retained.{continuation}", {
      count: report.failureCount, reason: copy(latest ? reasons[latest.reason] ?? reasons.unknown : reasons.unknown),
      continuation: copy(report.budgetReached ? " Collection time limit also reached; remaining reads continue next cycle." : ""),
    });
  }
  if (report?.budgetReached) return copy("Collection time limit reached; remaining reads continue next cycle. Original data timestamps are retained.");
  return feed.error ? copy("Some background reads failed. Previous snapshots are retained with their original times.") : null;
}

function renderLocalFeedStatus(): void {
  if (!localMarketMode) return;
  const feed = localFeed;
  const node = byId("localFeedStatus");
  node.classList.remove("hidden");
  setCopy("mainnetListScope", "Saved local markets · bounded RPC sample, not the whole chain");
  byId("loadMoreMarkets").classList.add("hidden");
  if (!feed || marketLoadFailed) {
    localize(node, "Local market feed unavailable. Saved rows have been retained.");
    return;
  }
  const stale = feed.bundles.filter(bundle => snapshotIsStale(bundle.fetchedAt)).length;
  const time = feed.lastSuccess ? new Intl.DateTimeFormat(document.documentElement.lang || "en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(feed.lastSuccess) : "--";
  localize(node, copy("Saved {loaded}/{total} pools · Last collection {time} · {stale} stale", {
    loaded: feed.bundles.length, total: feed.discovered, time, stale,
  }));
  setCopy("lastUpdated", copy(feed.collecting ? "Collecting in background" : "Saved market feed"));
  setCopy("mainnetBlock", "Local snapshots · individual quote blocks shown in token details");
  setCopy("mainnetStorageNote", "Local snapshots persist on this PC. Collection continues while this server is running. Volumes remain partial; missing intervals are not reconstructed.");
  if (!feed.bundles.length && !markets.length) byId("marketRows").replaceChildren(element("div", "market-loading-row", copy("First collection in progress. Completed pools appear automatically.")));
  const notice = localFeedNotice(feed);
  if (notice) setNotice(notice);
}

async function loadLocalMarkets(): Promise<boolean> {
  if (!NETWORK) return true;
  const feed = await readMarketFeed(NETWORK.id, NETWORK.chainId);
  localFeed = feed;
  if (!localSeedsQueued) {
    localSeedsQueued = true;
    // Only addresses are queued. The server verifies pools independently of browser caches.
    const remembered = tokenDirectory?.remembered(new Set()) ?? [];
    void queueLocalMarkets("creation", markets.filter(market => market.v4 && /^0x[0-9a-f]{64}$/i.test(market.creationTx)).map(market => market.creationTx));
    void queueLocalMarkets("pool", [...remembered.flatMap(token => token.pools).filter(ref => /^0x[0-9a-f]{40}$/i.test(ref)), ...markets.filter(market => market.v3).map(market => market.pairAddress)]);
  }
  const sources = new Set(selectDexAdapters(dexAdapters, activeProtocol).map(adapter => adapter.source.id));
  const complete = await Promise.all(feed.bundles.filter(bundle => sources.has(bundle.seed.sourceId)).map(bundle => loadMarketPair(bundle.seed, false, { snapshot: bundle })));
  tokenDirectory?.save();
  const merged = new Map([...protocolMarketCache.values(), ...markets].filter(market => sources.has(market.sourceId)).map(market => [poolRef(market), { ...market, stale: true }]));
  for (const market of complete) if (market) merged.set(poolRef(market), market);
  const current = complete.filter((market): market is MarketPair => Boolean(market));
  const freshRefs = new Set(current.map(poolRef));
  markets = [...current, ...[...merged.values()].filter(market => !freshRefs.has(poolRef(market)))].slice(0, MAX_MARKETS);
  for (const market of markets) protocolMarketCache.set(poolRef(market), market);
  hasMoreMarkets = false;
  discoveryLimited = true;
  failedMarketCount = complete.filter(market => !market).length;
  // Refreshing or filtering the list never opens token details or starts more RPC calls.
  return markets.some(market => market.stale);
}

async function loadMarkets(force: boolean, extend = false): Promise<boolean> {
  if (localMarketMode) return loadLocalMarkets();
  linkedSnapshotMode = false;
  if (rpcReader && NETWORK && (linkedPool || linkedToken) && localRecorderAvailable(new URL(location.href))) {
    // Deep links share the checked server snapshots. Timestamps remain unchanged, including stale data.
    try {
      const feed = await readMarketFeed(NETWORK.id, NETWORK.chainId);
      const bundles = linkedMarketBundles(feed, { pool: linkedPool, token: linkedToken });
      const loaded = await Promise.all(bundles.map(snapshot => loadMarketPair(snapshot.seed, false, { snapshot })));
      const saved = loaded.filter((market): market is MarketPair => Boolean(market));
      if (saved.length) {
        const selected = saved.find(market => poolRef(market) === selectedPair) ?? saved[0]!;
        linkedSnapshotMode = true;
        markets = saved; selectedPair = poolRef(selected); hasMoreMarkets = false;
        discoveryLimited = true; failedMarketCount = loaded.length - saved.length;
        tokenDirectory?.viewed(selected.tokenAddress);
        setCopy("mainnetBlock", "Saved linked market. Original data timestamps retained.");
        adPreview.setContentAvailable(true);
        void loadDetail(selected, false);
        return saved.some(market => market.stale);
      }
    } catch { /* An unavailable local feed falls back to bounded direct RPC reads. */ }
    if (linkedToken) void queueLocalMarkets("token", [linkedToken]);
    else if (linkedPool && !linkedPool.startsWith("v4:")) void queueLocalMarkets("pool", [linkedPool]);
  }
  if (rpcReader) {
    const head = await rpcReader.checkNetwork(force);
    setCopy("mainnetBlock", copy("RPC checked · Block {block} · {time}", { block: fullNumber(head.number), time: formatAnalysisTime(head.timestamp) }));
  }
  if (linkedPool) {
    let savedSeed: PairSeed | undefined;
    if (rpcReader && linkedPool.startsWith("v4:")) {
      try { savedSeed = cachedPoolSeeds(localStorage, CACHE_PREFIX, dexAdapters).find(seed => poolRef(seed) === linkedPool); } catch { /* Fall back to checked discovery. */ }
    }
    const seed = savedSeed ?? (rpcReader && !linkedPool.startsWith("v4:") ? await rpcReader.resolveV3Pool(linkedPool) : await resolveLinkedPool(linkedPool, dexAdapters,
      async address => (await fetchData<{ creation_transaction_hash?: string | null }>(`/addresses/${address}`, 300_000, force)).data,
      async path => (await fetchData<CreationPage>(path, 300_000, force)).data));
    const market = await loadMarketPair(seed, force, { quick: Boolean(rpcReader) });
    if (!market) throw new Error("This pool's market data could not be loaded. Retry with Refresh.");
    markets = [market];
    tokenDirectory?.viewed(market.tokenAddress);
    selectedPair = poolRef(market);
    adPreview.setContentAvailable(true);
    void loadDetail(market, force);
    return market.stale;
  }
  if (linkedToken && !rpcReader) throw new Error("Token address lookup is available on mainnet only.");
  if (rpcReader && !linkedToken) return loadRpcMarkets(force, extend);
  const discovery = linkedToken && rpcReader
    ? { seeds: await rpcReader.findV3Pools(linkedToken), hasMore: false, limited: true, stale: false }
    : await discoverDexPools(selectDexAdapters(dexAdapters, activeProtocol), marketLimit, path => fetchData<LogResponse>(path, 60_000, force), Boolean(rpcReader) && activeProtocol === "all");
  if (linkedToken && !discovery.seeds.length) throw new Error("No USDC v3 pool found at the checked fee tiers (0.01%, 0.05%, 0.3%, 1%). Other pairs and protocols are not covered by this lookup.");
  const loaded = await mapLimited(discovery.seeds, 3, (seed) => loadMarketPair(seed, force, { quick: Boolean(rpcReader) }));
  failedMarketCount = loaded.filter((market) => market === null).length;
  if (discovery.seeds.length > 0 && failedMarketCount === loaded.length) {
    throw new Error("All discovered pools failed to load. Market activity is unknown. Retry with Refresh.");
  }
  const previous = new Map(markets.map((market) => [poolRef(market), market]));
  markets = loaded.flatMap((market, index) => {
    if (market) return [market];
    const old = previous.get(poolRef(discovery.seeds[index]!));
    return old ? [{ ...old, stale: true }] : [];
  });
  if (linkedToken && markets.length) tokenDirectory?.viewed(linkedToken);
  hasMoreMarkets = discovery.hasMore;
  discoveryLimited = discovery.limited || Boolean(rpcReader);
  const shown = visibleMarkets();
  const current = markets.find(market => poolRef(market) === selectedPair);
  if (!current || !shown.some(market => market.tokenAddress.toLowerCase() === current.tokenAddress.toLowerCase())) selectedPair = shown[0] ? poolRef(shown[0]) : "";
  const selected = markets.find((market) => poolRef(market) === selectedPair);
  if (selected) void loadDetail(selected, force);
  else { detailRequest += 1; setDetailState("empty"); }
  return discovery.stale || markets.some((market) => market.stale);
}

async function loadDashboard(force = false, extend = false): Promise<void> {
  if (loading || !NETWORK || routeError) return;
  loading = true;
  loadProgress = { completed: 0, total: 0, refreshing: markets.length > 0 && !extend && !force };
  renderDiscoveryControls();
  const refresh = byId<HTMLButtonElement>("refreshButton");
  refresh.disabled = true;
  localize(refresh, "Refreshing");
  setNotice();
  try {
    const stale = await loadMarkets(force, extend);
    marketLoadFailed = false;
    renderMarketRows();
    if (!localMarketMode) void checkWatchedPools();
    if (stale && !localMarketMode) setNotice(linkedSnapshotMode ? "Saved linked market. Original data timestamps retained." : "Live indexing is temporarily unavailable. Showing the latest cached market snapshot.");
    else if (failedMarketCount > 0) setNotice(copy("Pool loads failed: {count}. Totals cover available pools only.", { count: failedMarketCount }));
    setCopy("lastUpdated", copy("{state} {time}", { state: copy(stale ? "Cached · checked" : failedMarketCount > 0 ? "Partial update" : "Checked"), time: new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()) }));
  } catch (error) {
    marketLoadFailed = true;
    if (rpcReader) setCopy("mainnetBlock", "Mainnet refresh failed; live status unknown.");
    markets = markets.map(market => ({ ...market, stale: true }));
    renderMarketRows();
    adPreview.setContentAvailable(false);
    setNotice(error instanceof Error ? copy("Market data unavailable: {error}", { error: copy(error.message) }) : "Market data unavailable.");
    localize(byId("lastUpdated"), "Connection unavailable");
    detailRequest += 1;
    if (rpcReader && markets.length) {
      const selected = markets.find(market => poolRef(market) === selectedPair);
      if (selected) void loadDetail(selected);
    } else setDetailState("empty");
    if (linkedPool) {
      byId("marketDetailEmpty").textContent = "Pool unavailable. Use Refresh to retry or return to markets.";
      byId<HTMLButtonElement>("copyMarketLink").disabled = true;
    }
  } finally {
    lastRefreshAt = Date.now();
    loading = false;
    refresh.disabled = false;
    localize(refresh, "Refresh");
    renderDiscoveryControls();
    if (!localMarketMode) {
      void refreshRecorderOverview();
      queueRememberedMarkets(force);
      void flushTokenSearch();
    } else renderLocalFeedStatus();
  }
}

function applyFilter(filter: MarketFilter): void {
  activeFilter = filter;
  document.querySelectorAll<HTMLButtonElement>("[data-market-filter]").forEach((button) => {
    const active = button.dataset.marketFilter === filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const shown = visibleMarkets();
  if (!shown.some((market) => poolRef(market) === selectedPair)) {
    if (shown[0] && !rpcReader) {
      selectedPair = poolRef(shown[0]);
      void loadDetail(shown[0]);
    } else {
      selectedPair = "";
      detailRequest += 1;
      setDetailState("empty");
      document.body.classList.remove("detail-open");
    }
  }
  renderMarketRows();
}

function toggleSelectedWatch(): void {
  const market = markets.find((entry) => poolRef(entry) === selectedPair);
  if (!market) return;
  const key = market.tokenAddress.toLowerCase();
  if (watchlist.has(key)) {
    watchlist.delete(key);
  } else {
    watchlist.add(key);
    if (!market.stale) {
      startTracking(market);
      const detail = detailCache.get(poolCacheKey(market));
      if (detail) observeDetailChanges(market, detail.data);
    }
  }
  saveWatchlist();
  if (activeFilter === "watchlist") {
    applyFilter("watchlist");
    return;
  }
  renderMarketRows();
  updateWatchToggle(market);
  renderObservedAlerts(market);
}

function applyWalletSignalFilter(filter: WalletSignalFilter): void {
  activeWalletSignalFilter = filter;
  const market = markets.find((entry) => poolRef(entry) === selectedPair);
  const detail = market ? detailCache.get(poolCacheKey(market)) : undefined;
  if (market && detail) renderWalletSignals(market, detail.data);
}

function setSearchInputs(query: string): void {
  for (const id of ["searchInput", "marketSearchInput"]) {
    const input = byId<HTMLInputElement>(id);
    if (input.value !== query) input.value = query;
  }
}

async function resolveSearchSeeds(token: TokenIdentity): Promise<PairSeed[]> {
  if (!NETWORK) return [];
  const adapters = selectDexAdapters(dexAdapters, activeProtocol);
  let saved: PairSeed[] = [];
  try { saved = cachedPoolSeeds(localStorage, CACHE_PREFIX, adapters).filter(seed => seed.tokenAddress.toLowerCase() === token.address); } catch { /* Optional pool cache. */ }
  const seeds: PairSeed[] = [];
  if (rpcReader && activeProtocol !== "uniswap-v4") seeds.push(...await rpcReader.findV3Pools(token.address));
  for (const ref of token.pools.slice(0, 4)) {
    if (rpcReader && !ref.startsWith("v4:")) continue;
    if (ref.startsWith("v4:") && activeProtocol === "uniswap-v3") continue;
    const cached = saved.find(seed => poolRef(seed) === ref);
    const seed = cached ?? await resolveLinkedPool(ref, adapters,
      async address => (await fetchData<{ creation_transaction_hash?: string | null }>(`/addresses/${address}`, 300_000)).data,
      async path => (await fetchData<CreationPage>(path, 300_000)).data);
    seeds.push(seed);
  }
  seeds.push(...saved.filter(seed => !rpcReader || Boolean(seed.v4)));
  return [...new Map(seeds.filter(seed => seed.chainId === NETWORK.chainId && seed.tokenAddress.toLowerCase() === token.address)
    .map(seed => [poolRef(seed), seed])).values()].slice(0, 6);
}

function queueRememberedMarkets(force = false): void {
  if ((!force && rememberedMarketsQueued) || !rpcReader || !NETWORK || !tokenDirectory || activeQuery || pendingTokenSearch || linkedPool || linkedToken || routeError) return;
  rememberedMarketsQueued = true;
  const tokens = tokenDirectory.remembered(new Set(markets.map(market => market.tokenAddress.toLowerCase())));
  if (!tokens.length) return;
  pendingTokenSearch = { generation: searchGeneration, tokens, background: true };
  for (const token of tokens) tokenSearchStates.set(token.address, "Waiting for market lookup");
  renderMarketRows();
}

function queueTokenSearch(query: string): void {
  if (!NETWORK || !tokenDirectory || routeError || linkedPool || linkedToken) return;
  const tokens = tokenDirectory.search(query, new Set(markets.map(market => market.tokenAddress.toLowerCase())), activeFilter === "watchlist" ? watchlist : undefined).items.slice(0, 3);
  if (!tokens.length) return;
  for (const token of tokens) tokenDirectory.viewed(token.address);
  pendingTokenSearch = { generation: searchGeneration, tokens };
  for (const token of tokens) tokenSearchStates.set(token.address, "Waiting for market lookup");
  renderMarketRows();
  void flushTokenSearch();
}

async function flushTokenSearch(): Promise<void> {
  if (loading || !pendingTokenSearch || !NETWORK) return;
  const job = pendingTokenSearch;
  pendingTokenSearch = null;
  if (job.generation !== searchGeneration) return;
  loading = true;
  const current = () => job.generation === searchGeneration;
  const refresh = byId<HTMLButtonElement>("refreshButton");
  refresh.disabled = true;
  loadProgress = { completed: 0, total: job.tokens.length, refreshing: false };
  renderDiscoveryControls();
  try {
    if (rpcReader) await rpcReader.checkNetwork(false);
    for (const token of job.tokens) {
      if (!current()) break;
      if (markets.length >= MAX_MARKETS) { tokenSearchStates.set(token.address, "Session pool limit reached"); continue; }
      tokenSearchStates.set(token.address, "Loading market data...");
      renderMarketRows();
      try {
        const seeds = await resolveSearchSeeds(token);
        if (!current()) break;
        let loaded = 0;
        await mapLimited(seeds, 2, async seed => {
          if (!current()) return;
          const market = await loadMarketPair(seed, false, { quick: true });
          if (!current() || !market || market.tokenAddress.toLowerCase() !== token.address || market.chainId !== NETWORK.chainId) return;
          const index = markets.findIndex(entry => poolRef(entry) === poolRef(market));
          if (index >= 0) markets[index] = market;
          else if (markets.length < MAX_MARKETS) markets.push(market);
          else return;
          loaded++;
          if (localMarketMode && seed.v3) void queueLocalMarkets("pool", [seed.pairAddress]);
          renderMarketRows();
        });
        if (!current()) break;
        tokenSearchStates.set(token.address, loaded ? "" : seeds.length ? "Market lookup failed. Search again to retry." : "No pool found in the supported lookup.");
      } catch {
        if (current()) tokenSearchStates.set(token.address, "Market lookup failed. Search again to retry.");
      }
      loadProgress.completed++;
      renderMarketRows();
      renderDiscoveryControls();
    }
    if (current() && !localMarketMode) {
      const first = visibleMarkets()[0];
      if (first && (!job.background || !selectedPair)) void selectMarket(first, false);
    }
  } catch {
    if (current()) for (const token of job.tokens) tokenSearchStates.set(token.address, "Market lookup failed. Search again to retry.");
  } finally {
    loading = false;
    refresh.disabled = false;
    renderMarketRows();
    renderDiscoveryControls();
    void flushTokenSearch();
  }
}

function renderTokenSearch(query: string, submitted = false): number {
  const panel = byId("tokenSearchPanel"), list = byId("marketRows");
  const open = Boolean(query.trim() && NETWORK && !routeError && tokenDirectory);
  panel.classList.toggle("hidden", !open);
  list.querySelectorAll(".token-search-result").forEach(row => row.remove());
  if (submitted) (open ? panel : byId("marketList")).scrollIntoView({ block: "start" });
  if (!open || !tokenDirectory || !NETWORK) return 0;
  const result = tokenDirectory.search(query, new Set(markets.map(market => market.tokenAddress.toLowerCase())), activeFilter === "watchlist" ? watchlist : undefined);
  const loaded = visibleMarkets().length;
  const requireMarketData = (discoveryOptions.minimumFdv ?? 0) > 0 || discoveryOptions.minimumLiquidity > 0
    || discoveryOptions.traded24h || discoveryOptions.sellSeen || !["all", "watchlist"].includes(activeFilter) || activeProtocol !== "all";
  const items = requireMarketData ? [] : result.items;
  const unvalued = byId("tokenSearchUnvalued");
  unvalued.classList.toggle("hidden", !requireMarketData || result.matches === 0);
  const progress = result.items.map(token => tokenSearchStates.get(token.address)).find(state => state === "Loading market data..." || state === "Waiting for market lookup");
  setCopy("tokenSearchUnvalued", copy("{count} saved matches excluded: filter data not loaded. {status}", { count: result.matches, status: progress ? copy(progress) : "" }));
  setCopy("tokenSearchScope", copy(tokenDirectory.persistent ? "{count} saved tokens · Not the whole chain" : "{count} tokens in this tab · Storage unavailable", { count: result.total }));
  setCopy("tokenSearchCount", copy("{shown} of {count} matches", { shown: loaded + items.length, count: loaded + (requireMarketData ? 0 : result.matches) }));
  setCopy("marketSummary", copy("{loaded} loaded tokens · {saved} saved-only matches", { loaded, saved: result.matches }));
  if (items.length) list.querySelectorAll(".market-loading-row").forEach(row => row.remove());
  for (const token of items) {
    const row = element("a", "market-row token-search-result");
    row.href = tokenSearchUrl(location.href, NETWORK, token);
    const external = new URL(row.href).origin !== location.origin;
    if (external) { row.target = "_blank"; row.rel = "noreferrer"; }
    localize(row, "Names can be duplicated. Token metadata is not official-token verification.", "title");
    const identity = element("span", "market-token"), label = element("span", "market-token-copy");
    label.append(element("strong", "", token.symbol ?? token.name ?? shortHash(token.address)), element("span", "", token.name ?? "--"), element("code", "", token.address));
    identity.append(element("span", "market-token-icon", (token.symbol || token.name || "?").slice(0, 2).toUpperCase()), label);
    const status = element("span", "token-search-status");
    status.append(element("span", "", copy(tokenSearchStates.get(token.address) || "Market data not loaded")), element("strong", "", copy(external ? "ArcScan" : "Open market")));
    row.append(identity, status);
    list.append(row);
  }
  return items.length;
}

function runSearch(query: string, lookupAddress = true): void {
  searchGeneration++;
  pendingTokenSearch = null;
  tokenSearchStates.clear();
  setSearchInputs(query);
  if (linkedToken && !query.trim() && NETWORK) {
    location.assign(marketUrl(location.href, NETWORK.id));
    return;
  }
  if (lookupAddress && rpcReader && /^0x[\da-f]{40}$/i.test(query.trim()) && NETWORK) {
    const url = new URL(marketUrl(location.href, NETWORK.id));
    url.searchParams.set("token", query.trim().toLowerCase());
    location.assign(url.href);
    return;
  }
  activeQuery = query.trim().toLowerCase();
  applyFilter(activeFilter);
  const matches = renderTokenSearch(query, lookupAddress);
  if (lookupAddress) queueTokenSearch(query);
  const shown = visibleMarkets();
  if (shown.length === 0 && matches === 0) {
    setNotice((discoveryOptions.minimumFdv ?? 0) > 0 ? undefined : "No match in the loaded pools with these filters.");
    return;
  }
  setNotice();
}

byId("closeTokenSearch").append(createIcon(X, { width: "18", height: "18", "aria-hidden": "true" }));
byId("closeMarketDetail").append(createIcon(X, { width: "20", height: "20", "aria-hidden": "true" }));
function closeMarketDetail(): void {
  if (linkedPool) return;
  selectedPair = "";
  detailRequest++;
  document.body.classList.remove("detail-open");
  setDetailState("empty");
  renderMarketRows();
  byId("marketList").focus({ preventScroll: true });
}
byId("closeMarketDetail").addEventListener("click", closeMarketDetail);
document.addEventListener("keydown", event => { if (event.key === "Escape" && document.body.classList.contains("detail-open")) closeMarketDetail(); });
byId("closeTokenSearch").addEventListener("click", () => runSearch("", false));
for (const id of ["searchInput", "marketSearchInput"]) {
  byId<HTMLInputElement>(id).addEventListener("keydown", event => {
    if (event.key === "Escape") runSearch("", false);
  });
}
window.addEventListener("storage", event => {
  if (event.key === `${CACHE_PREFIX}token-directory:v1` && activeQuery) renderMarketRows();
});

document.querySelectorAll<HTMLButtonElement>("[data-market-filter]").forEach((button) => {
  button.addEventListener("click", () => applyFilter((button.dataset.marketFilter ?? "all") as MarketFilter));
});
document.querySelectorAll<HTMLButtonElement>("[data-protocol-filter]").forEach(button => {
  button.addEventListener("click", () => void applyProtocol(button.dataset.protocolFilter as RadarProtocolFilter));
});
document.querySelectorAll<HTMLButtonElement>("[data-wallet-filter]").forEach((button) => {
  button.addEventListener("click", () => applyWalletSignalFilter((button.dataset.walletFilter ?? "all") as WalletSignalFilter));
});
for (const [formId, inputId] of [["searchForm", "searchInput"], ["marketSearchForm", "marketSearchInput"]]) {
  const input = byId<HTMLInputElement>(inputId);
  input.addEventListener("input", () => runSearch(input.value, false));
  byId<HTMLFormElement>(formId).addEventListener("submit", event => {
    event.preventDefault();
    runSearch(input.value);
  });
}
byId<HTMLButtonElement>("refreshButton").addEventListener("click", () => void loadDashboard(true));
byId<HTMLButtonElement>("copyMarketLink").addEventListener("click", async () => {
  const market = markets.find(entry => poolRef(entry) === selectedPair);
  if (!market || !NETWORK) return;
  const url = marketUrl(location.href, NETWORK.id, poolRef(market));
  try {
    await navigator.clipboard.writeText(url);
    localize(byId("shareMarketStatus"), "Link copied");
  } catch {
    localize(byId("shareMarketStatus"), "Copy unavailable. Use the Full details link.");
  }
});
byId<HTMLButtonElement>("watchToggle").addEventListener("click", toggleSelectedWatch);
byId<HTMLButtonElement>("readAuthority").addEventListener("click", () => void readSelectedAuthority());
byId<HTMLSelectElement>("watchChangeView").addEventListener("change", renderWatchDigest);
byId<HTMLButtonElement>("markWatchReviewed").addEventListener("click", () => {
  watchReviewedAt = Date.now();
  try { localStorage.setItem(`${CACHE_PREFIX}watch-reviewed-at`, String(watchReviewedAt)); } catch { /* In-memory review remains available. */ }
  renderWatchDigest();
});
byId<HTMLSelectElement>("poolSelector").addEventListener("change", () => {
  const market = markets.find(entry => poolRef(entry) === byId<HTMLSelectElement>("poolSelector").value);
  if (market && !linkedPool) void selectMarket(market, false);
});
byId<HTMLSelectElement>("marketSort").addEventListener("change", (event) => {
  discoveryOptions.sort = (event.target as HTMLSelectElement).value as MarketSort;
  applyFilter(activeFilter);
});
byId("resetMarketFilters").append(createIcon(RotateCcw, { width: "18", height: "18", "aria-hidden": "true" }));
byId("resetMarketFilters").addEventListener("click", () => {
  Object.assign(discoveryOptions, { sort: "volume", minimumLiquidity: 0, minimumFdv: 0, traded24h: false, sellSeen: false });
  for (const [id, value] of [["marketSort", "volume"], ["minimumLiquidity", "0"], ["minimumFdv", "0"]]) byId<HTMLSelectElement>(id).value = value;
  for (const id of ["traded24h", "sellSeenOnly"]) byId<HTMLInputElement>(id).checked = false;
  activeFilter = "all";
  runSearch(linkedToken ?? "", false);
});
byId<HTMLSelectElement>("discoveryView").addEventListener("change", renderDiscoveries);
byId<HTMLSelectElement>("minimumLiquidity").addEventListener("change", (event) => {
  discoveryOptions.minimumLiquidity = Number((event.target as HTMLSelectElement).value);
  applyFilter(activeFilter);
});
byId<HTMLSelectElement>("minimumFdv").addEventListener("change", (event) => {
  const minimum = Number((event.target as HTMLSelectElement).value);
  discoveryOptions.minimumFdv = [0, 1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000].includes(minimum) ? minimum : 0;
  applyFilter(activeFilter);
});
for (const [id, key] of [["traded24h", "traded24h"], ["sellSeenOnly", "sellSeen"]] as const) {
  byId<HTMLInputElement>(id).addEventListener("change", (event) => {
    discoveryOptions[key] = (event.target as HTMLInputElement).checked;
    applyFilter(activeFilter);
  });
}
byId<HTMLButtonElement>("loadMoreMarkets").addEventListener("click", () => {
  if (loading) return;
  if (!marketLoadFailed) marketLimit = Math.min(MAX_MARKETS, marketLimit + MARKET_LIMIT);
  void loadDashboard(false, true);
});

initializeLanguage();
byId("markets").prepend(byId("poolPageNav"));
byId("markets").append(document.querySelector(".market-context")!);

const networkSelect = byId<HTMLSelectElement>("networkSelect");
for (const [id, entry] of Object.entries(RADAR_NETWORKS)) {
  const option = document.createElement("option");
  option.value = id;
  const label = entry.status === "unconfigured" ? entry.label : entry.network.label;
  localize(option, copy(entry.status === "ready" ? "{network}" : "{network} (not connected)", { network: label }));
  networkSelect.append(option);
}
if (!Object.hasOwn(RADAR_NETWORKS, requestedNetwork)) {
  const option = document.createElement("option");
  option.value = "";
  option.disabled = true;
  localize(option, "Network unavailable");
  networkSelect.append(option);
}
networkSelect.value = Object.hasOwn(RADAR_NETWORKS, requestedNetwork) ? requestedNetwork : "";
networkSelect.disabled = false;
networkSelect.addEventListener("change", () => {
  if (!Object.hasOwn(RADAR_NETWORKS, networkSelect.value)) return;
  // A full navigation discards in-flight reads and pool/filter state from the old chain.
  location.assign(marketUrl(location.href, networkSelect.value));
});
byId<HTMLAnchorElement>("returnToTestnet").href = marketUrl(location.href, "arc-testnet");

if (NETWORK) {
  if (linkedToken) {
    setSearchInputs(linkedToken);
    byId("poolPageNav").classList.remove("hidden");
    byId("poolPageAddress").textContent = `Token ${shortHash(linkedToken)} · Uniswap v3 / USDC`;
    byId("loadMoreMarkets").classList.add("hidden");
  }
  localize(byId("coverageNote"), copy("Source: ArcScan. Indexing may lag. Configured protocols: {protocols}. Selected pools only.", {
    protocols: [...new Set(NETWORK.sources.map(source => source.protocol))].join(", "),
  }));
  if (rpcReader) {
    byId("mainnetCoverage").classList.remove("hidden");
    byId("mainnetListScope").classList.remove("hidden");
    localize(byId("coverageNote"), "Source: official Arc RPC and configured Uniswap v3/v4 events. Bounded recent reads, not a full market index.");
    for (const [before, after] of [["24H volume", "Observed volume (partial)"], ["24H buys / sells", "Observed buys / sells"], ["Last 24 hours", "Recent sample"], ["Moving 24H", "Observed activity"], ["Traded in 24H", "Trades in sample"]]) {
      document.querySelectorAll<HTMLElement>(`[data-i18n="${before}"]`).forEach(node => { node.dataset.i18n = after; localize(node, after); });
    }
    document.querySelector(".market-brief .eyebrow")!.textContent = "ARCROW / RECENT SAMPLE";
  }
  byId<HTMLAnchorElement>("backToMarkets").href = marketUrl(location.href, NETWORK.id);
  if (linkedPool || routeError) {
    document.body.classList.add("pool-page");
    byId("poolPageNav").classList.remove("hidden");
    byId("poolPageAddress").textContent = linkedPool ? `Pool ${shortHash(linkedPool)}` : "Invalid pool link";
    byId<HTMLAnchorElement>("fullMarketLink").classList.add("hidden");
  }
  localize(document.querySelector(".status-row strong")!, copy("{network} MARKET FEED", { network: NETWORK.label.toUpperCase() }));
  document.querySelector(".chain-id")!.textContent = `CHAIN ${NETWORK.chainId}`;
  document.querySelector(".network-lockup small")!.textContent = NETWORK.testnet ? "TESTNET" : "MAINNET";
  document.querySelector(".pulse-heading .eyebrow")!.textContent = `ARCROW / ${NETWORK.label.toUpperCase()}`;
  document.querySelector(".footer-brand small")!.textContent = `ON ${NETWORK.label.toUpperCase()}`;
  document.querySelectorAll<HTMLAnchorElement>("a[data-explorer]").forEach(link => { link.href = NETWORK.explorerBase; });
  if (routeError) {
    setNotice(routeError);
    byId("marketDetailEmpty").textContent = "This pool link is invalid. Return to markets.";
    localize(byId("lastUpdated"), "Invalid link");
    byId<HTMLButtonElement>("refreshButton").disabled = true;
  } else void initializeMarketDashboard();
} else {
  byId("networkUnavailable").classList.remove("hidden");
  localize(byId("networkUnavailableTitle"), requestedNetwork === "arc-mainnet" ? "Arc Mainnet" : "Network unavailable");
  if (requestedNetwork !== "arc-mainnet") localize(byId("networkUnavailableMessage"), networkError);
  localize(byId("lastUpdated"), requestedNetwork === "arc-mainnet" ? "Not connected" : "Network unavailable");
  document.querySelector(".status-row strong")!.textContent = "ARCROW";
  document.querySelector(".live-dot")!.classList.add("hidden");
  document.querySelector(".chain-id")!.textContent = "";
  document.querySelector(".network-lockup small")!.textContent = requestedNetwork === "arc-mainnet" ? "MAINNET" : "UNAVAILABLE";
  document.querySelector(".footer-brand small")!.textContent = "";
  byId("markets").classList.add("hidden");
  document.querySelectorAll<HTMLAnchorElement>("a[data-explorer]").forEach(link => { link.removeAttribute("href"); link.classList.add("hidden"); });
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input:not([name="arcrow-theme"]), select:not(#languageSelect):not(#networkSelect)').forEach(control => { control.disabled = true; });
}
function autoRefreshDue(now: number): boolean {
  const interval = localMarketMode ? 10_000 : marketLoadFailed ? 300_000 : rpcReader ? 120_000 : AUTO_REFRESH_MS;
  return !document.hidden && !loading && now - lastRefreshAt >= interval;
}
window.setInterval(() => {
  if (autoRefreshDue(Date.now())) void loadDashboard();
}, 5_000);
document.addEventListener("visibilitychange", () => {
  if (NETWORK) renderWatchDigest();
  if (autoRefreshDue(Date.now())) void loadDashboard();
});
