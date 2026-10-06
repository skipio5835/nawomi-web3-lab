import type { RadarNetwork } from "./arc-radar-networks.js";
import { marketUrl } from "./arc-radar-navigation.js";
import { validPoolRef } from "./arc-radar-pool-id.js";

export const TOKEN_DIRECTORY_LIMITS = { tokens: 2000, results: 20, days: 90, bytes: 2_000_000 };
export type TokenIdentity = { address: string; name: string | null; symbol: string | null; seenAt: number; pools: string[]; viewedAt?: number };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const addressPattern = /^0x[\da-f]{40}$/i;
const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();
const text = (value: unknown): value is string | null => value === null || typeof value === "string" && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
function validTime(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now
    && now - value <= TOKEN_DIRECTORY_LIMITS.days * 86_400_000;
}
function validPool(pool: unknown, network: RadarNetwork): pool is string {
  if (typeof pool !== "string" || !validPoolRef(pool)) return false;
  if (!pool.startsWith("v4:")) return true;
  return network.sources.some(source => source.protocol === "uniswap-v4" && source.factoryAddress.toLowerCase() === pool.split(":")[1]?.toLowerCase());
}

export class TokenDirectory {
  private records = new Map<string, TokenIdentity>();
  persistent = true;
  constructor(private storage: StorageLike | null, private key: string, readonly network: RadarNetwork) {
    this.persistent = Boolean(storage);
    this.sync();
  }
  private sync(now = Date.now()): void {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw || raw.length > TOKEN_DIRECTORY_LIMITS.bytes) return;
      const value = JSON.parse(raw);
      if (value?.version !== 1 || value.chainId !== this.network.chainId || !Array.isArray(value.tokens)
        || value.tokens.length > TOKEN_DIRECTORY_LIMITS.tokens) return;
      for (const token of value.tokens) {
        if (!token || typeof token.address !== "string" || !addressPattern.test(token.address) || BigInt(token.address) === 0n
          || !text(token.name) || !text(token.symbol) || !validTime(token.seenAt, now)
          || !Array.isArray(token.pools) || token.pools.length > 4 || !token.pools.every((pool: unknown) => validPool(pool, this.network))) continue;
        const address = token.address.toLowerCase(), previous = this.records.get(address);
        const saved: TokenIdentity = { address, name: token.name, symbol: token.symbol, seenAt: token.seenAt, pools: token.pools.map((pool: string) => pool.toLowerCase()),
          viewedAt: validTime(token.viewedAt, now) ? token.viewedAt : undefined };
        const latest = !previous || token.seenAt > previous.seenAt ? saved : previous;
        this.records.set(address, { ...latest, viewedAt: Math.max(saved.viewedAt ?? 0, previous?.viewedAt ?? 0) || undefined,
          pools: [...new Set([...latest.pools, ...(previous?.pools ?? []), ...saved.pools])].slice(0, 4) });
      }
    } catch { this.persistent = false; }
  }
  remember(value: unknown, seenAt: number, pool?: string, persist = true): void {
    const token = value as { address_hash?: unknown; name?: unknown; symbol?: unknown } | null;
    if (!token || typeof token.address_hash !== "string" || !addressPattern.test(token.address_hash) || BigInt(token.address_hash) === 0n
      || !text(token.name) || !text(token.symbol) || !validTime(seenAt, Date.now()) || pool !== undefined && !validPool(pool, this.network)) return;
    const address = token.address_hash.toLowerCase(), old = this.records.get(address);
    const pools = [...new Set([...(pool ? [pool.toLowerCase()] : []), ...(old?.pools ?? [])])].slice(0, 4);
    const newer = !old || seenAt >= old.seenAt;
    const next = { address, name: newer ? token.name : old.name, symbol: newer ? token.symbol : old.symbol,
      seenAt: Math.max(seenAt, old?.seenAt ?? 0), pools, viewedAt: old?.viewedAt };
    if (old && old.name === next.name && old.symbol === next.symbol && old.pools.join() === pools.join() && next.seenAt - old.seenAt < 300_000) return;
    this.records.set(address, next);
    this.trim();
    if (persist) this.save();
  }
  private trim(now = Date.now()): void {
    this.records = new Map([...this.records.values()].filter(token => validTime(token.seenAt, now))
      .sort((a, b) => b.seenAt - a.seenAt).slice(0, TOKEN_DIRECTORY_LIMITS.tokens).map(token => [token.address, token]));
  }
  save(): void {
    if (!this.storage) return;
    this.sync(); this.trim();
    try {
      const tokens = [...this.records.values()];
      const encode = () => JSON.stringify({ version: 1, chainId: this.network.chainId, tokens });
      let raw = encode();
      while (raw.length > TOKEN_DIRECTORY_LIMITS.bytes && tokens.length) { tokens.splice(-50); raw = encode(); }
      this.records = new Map(tokens.map(token => [token.address, token]));
      this.storage.setItem(this.key, raw);
      this.persistent = true;
    } catch { this.persistent = false; }
  }
  importCache(storage: Pick<Storage, "length" | "key" | "getItem">, prefix: string): void {
    try {
      const start = `${prefix}-tokens-`;
      for (let index = 0; index < Math.min(storage.length, 10_000); index++) {
        const key = storage.key(index);
        if (!key?.startsWith(start) || !addressPattern.test(key.slice(start.length))) continue;
        try {
          const raw = storage.getItem(key);
          if (!raw || raw.length > 16_000) continue;
          const entry = JSON.parse(raw);
          if (entry?.data?.address_hash?.toLowerCase() !== key.slice(start.length).toLowerCase()) continue;
          this.remember(entry.data, entry.savedAt, undefined, false);
        } catch { /* One malformed API cache must not hide other tokens. */ }
      }
      this.save();
    } catch { /* Saved identities or in-memory results remain usable. */ }
  }
  remembered(exclude: ReadonlySet<string> = new Set()): TokenIdentity[] {
    this.sync(); this.trim();
    return [...this.records.values()].filter(token => token.pools.length > 0 && !exclude.has(token.address)
      && Date.now() - Math.max(token.seenAt, token.viewedAt ?? 0) <= 86_400_000)
      .sort((a, b) => (b.viewedAt ?? 0) - (a.viewedAt ?? 0) || b.seenAt - a.seenAt).slice(0, 3);
  }
  viewed(address: string): void {
    this.sync();
    const token = this.records.get(address.toLowerCase());
    if (!token) return;
    this.records.set(token.address, { ...token, viewedAt: Date.now() });
    this.save();
  }
  search(query: string, exclude: ReadonlySet<string> = new Set(), include?: ReadonlySet<string>): { items: TokenIdentity[]; matches: number; total: number } {
    this.sync(); this.trim();
    const needle = normalize(query.slice(0, 120));
    const rank = (token: TokenIdentity) => {
      const symbol = normalize(token.symbol ?? ""), name = normalize(token.name ?? "");
      if (token.address === needle) return 0;
      if (symbol === needle) return 1;
      if (name === needle) return 2;
      if (symbol.startsWith(needle)) return 3;
      if (name.startsWith(needle)) return 4;
      return 5;
    };
    const matches = needle ? [...this.records.values()].filter(token => !exclude.has(token.address) && (!include || include.has(token.address)) && [token.address, token.symbol ?? "", token.name ?? ""]
      .some(value => normalize(value).includes(needle))).sort((a, b) => rank(a) - rank(b) || b.seenAt - a.seenAt || a.address.localeCompare(b.address)) : [];
    return { items: matches.slice(0, TOKEN_DIRECTORY_LIMITS.results), matches: matches.length, total: this.records.size };
  }
}

export function tokenSearchUrl(base: string, network: RadarNetwork, token: TokenIdentity): string {
  if (!addressPattern.test(token.address) || BigInt(token.address) === 0n) throw new Error("Invalid token address.");
  // Prefer a known pool (including v4); an address-only mainnet lookup checks v3.
  const pool = token.pools.find(value => validPool(value, network));
  if (pool) return marketUrl(base, network.id, pool);
  if (network.dataMode !== "rpc-dex") return `${network.explorerBase}/token/${token.address.toLowerCase()}`;
  const url = new URL(marketUrl(base, network.id));
  url.searchParams.set("token", token.address.toLowerCase());
  return url.href;
}
