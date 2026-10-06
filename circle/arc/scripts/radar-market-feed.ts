import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDexAdapter, type DexLogPage, type RadarPool } from "../src/arc-radar-dex.js";
import { resolveRadarNetwork, type RadarNetwork } from "../src/arc-radar-networks.js";
import { RpcMarketReader } from "../src/arc-radar-rpc.js";
import { poolRef } from "../src/arc-radar-pool-id.js";
import { SNAPSHOT_LIMITS, type CollectionFailure, type CollectionReport, type MarketBundle, type MarketFeed, type SnapshotToken } from "../src/arc-radar-market-snapshot.js";
import type { PoolState } from "../src/arc-radar-pool-state.js";

type Reader = Pick<RpcMarketReader, "read" | "resolveV3Pool" | "findV3Pools">;
type Stored = { ref: string; seed: string; bundle: string | null; attempted: number };
const ADDRESS = /^0x[0-9a-f]{40}$/i;
type LookupKind = "pool" | "token" | "creation";

export function collectionFailureReason(error: unknown): CollectionFailure["reason"] {
  const message = error instanceof Error ? error.message : "";
  if (/^RPC HTTP 429\.$/.test(message)) return "rate-limit";
  if (/timed out|timeout/i.test(message)) return "request-timeout";
  if (/^RPC HTTP \d{3}\.$|^RPC read failed\.$/.test(message)) return "upstream-error";
  if (/^(Invalid |Incomplete |Missing |Not a verified |Unconfigured |Creation .*mismatch|RPC .*mismatch|RPC .*stale|RPC log cursor|Market snapshot too large)/.test(message)) return "invalid-data";
  return "unknown";
}

// Separate from the testnet event archive: this is a bounded, last-good market cache.
export class MarketFeedStore {
  readonly db: DatabaseSync;
  constructor(readonly network: RadarNetwork, file = resolve(".local", "arcrow", `${network.id}-markets.sqlite`)) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout=1500; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA max_page_count=16384;");
    this.db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS markets (ref TEXT PRIMARY KEY, seed TEXT NOT NULL, bundle TEXT, attempted INTEGER NOT NULL DEFAULT 0);");
    const fingerprint = createHash("sha256").update(JSON.stringify(network)).digest("hex");
    if (this.get("config") && this.get("config") !== fingerprint) { this.db.close(); throw new Error("Market feed configuration changed."); }
    this.set("config", fingerprint);
  }
  get(key: string): string | undefined { return (this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value; }
  set(key: string, value: string): void { this.db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run(key, value); }
  rows(): Stored[] { return this.db.prepare("SELECT * FROM markets ORDER BY attempted, ref").all() as Stored[]; }
  add(seed: RadarPool, requested = false): void {
    if (seed.chainId !== this.network.chainId || !this.network.sources.some(source => source.id === seed.sourceId)) throw new Error("Wrong pool scope.");
    const rows = this.rows();
    if (rows.some(row => row.ref === poolRef(seed))) return;
    if (rows.length >= SNAPSHOT_LIMITS.pools) {
      const candidates = rows.filter(row => {
        if (!row.bundle) return true;
        const saved = JSON.parse(row.bundle) as MarketBundle;
        return !saved.logs.some(log => Date.now() - Date.parse(log.block_timestamp || "") < 900_000);
      }).sort((a, b) => Number(Boolean(a.bundle)) - Number(Boolean(b.bundle))
        || (Date.parse(JSON.parse(a.seed).createdAt) || 0) - (Date.parse(JSON.parse(b.seed).createdAt) || 0));
      const victim = candidates[0];
      if (!victim || !requested && (Date.parse(seed.createdAt) || 0) <= (Date.parse(JSON.parse(victim.seed).createdAt) || 0)) return;
      this.db.prepare("DELETE FROM markets WHERE ref=?").run(victim.ref);
    }
    this.db.prepare("INSERT OR IGNORE INTO markets (ref,seed) VALUES (?,?)").run(poolRef(seed), JSON.stringify(seed));
  }
  attempt(ref: string, at: number): void { this.db.prepare("UPDATE markets SET attempted=? WHERE ref=?").run(at, ref); }
  save(bundle: MarketBundle): void {
    const encoded = JSON.stringify(bundle);
    if (bundle.logs.length > SNAPSHOT_LIMITS.logs || Buffer.byteLength(encoded) > 48_000) throw new Error("Market snapshot too large.");
    this.db.prepare("UPDATE markets SET bundle=? WHERE ref=?").run(encoded, poolRef(bundle.seed));
    this.set("lastSuccess", String(bundle.fetchedAt));
  }
  snapshot(collecting = false, queued = 0): MarketFeed {
    const rows = this.rows();
    const report = this.get("collection-report");
    return { version: 1, network: this.network.id, chainId: this.network.chainId, collecting, queued,
      discovered: rows.length, lastAttempt: Number(this.get("lastAttempt") || 0), lastSuccess: Number(this.get("lastSuccess") || 0),
      ...(report ? { collection: JSON.parse(report) as CollectionReport } : {}),
      error: this.get("error") === "1", bundles: rows.flatMap(row => row.bundle ? [JSON.parse(row.bundle) as MarketBundle] : []) };
  }
  recordCollection(report: CollectionReport): void {
    // Persist bounded codes and public pool identities, never raw RPC errors or URLs.
    const history = JSON.parse(this.get("failure-history") || "[]") as CollectionFailure[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.set("collection-report", JSON.stringify(report));
      this.set("failure-history", JSON.stringify([...history, ...report.failures].slice(-40)));
      this.set("error", report.failureCount > 0 ? "1" : "0");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}

export class LocalMarketFeed {
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private cycleNumber = 0;
  private readonly queue = new Map<string, LookupKind>();
  private readonly seenRequests = new Map<string, number>();
  private readonly adapters;
  constructor(readonly store: MarketFeedStore, private readonly reader: Reader = new RpcMarketReader(store.network)) {
    if (store.network.dataMode !== "rpc-dex") throw new Error("RPC market feed only.");
    this.adapters = store.network.sources.map(source => createDexAdapter(source, store.network));
  }
  snapshot(): MarketFeed { return this.store.snapshot(this.busy, this.queue.size); }
  enqueue(kind: LookupKind, addresses: string[]): void {
    const pattern = kind === "creation" ? /^0x[0-9a-f]{64}$/i : ADDRESS;
    if (!Array.isArray(addresses) || addresses.length > 20 || !addresses.every(a => typeof a === "string" && pattern.test(a))) throw new Error("Invalid lookup addresses.");
    const now = Date.now();
    for (const [key, at] of this.seenRequests) if (now - at > 300_000) this.seenRequests.delete(key);
    const known = new Set(this.store.rows().map(row => kind === "pool" ? row.ref : kind === "creation" ? (JSON.parse(row.seed) as RadarPool).creationTx.toLowerCase() : (JSON.parse(row.seed) as RadarPool).tokenAddress.toLowerCase()));
    for (const address of addresses) {
      const normalized = address.toLowerCase(), key = `${kind}:${normalized}`;
      if (known.has(normalized) || this.seenRequests.has(key) || this.queue.size >= 40 || this.seenRequests.size >= 200) continue;
      this.queue.set(normalized, kind); this.seenRequests.set(key, now);
    }
  }
  async cycle(deadline: AbortSignal = AbortSignal.timeout(55_000)): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.store.set("lastAttempt", String(Date.now()));
    const failures: CollectionFailure[] = [];
    let updatedPools = 0;
    const budgetCancelled = (error: unknown) => deadline.aborted && (error === deadline.reason
      || error instanceof Error && (["AbortError", "TimeoutError"].includes(error.name) || error.message === "RPC request failed or timed out."));
    const recordFailure = (error: unknown, stage: CollectionFailure["stage"], target: string) => {
      if (!budgetCancelled(error)) failures.push({ at: Date.now(), stage, target: target.slice(0, 200), reason: collectionFailureReason(error) });
    };
    try {
      // New heads and older pages alternate, with a durable per-source cursor.
      for (const adapter of this.adapters) {
        if (deadline.aborted) break;
        try {
          const key = `cursor:${adapter.source.id}`;
          const saved = this.store.get(key);
          const path = this.cycleNumber % 2 && saved ? saved : adapter.discoveryPath;
          const page = await this.reader.read(path, deadline) as DexLogPage;
          for (const seed of adapter.pairSeeds(page)) this.store.add(seed);
          if (path !== adapter.discoveryPath || !saved) {
            const next = page.next_page_params;
            this.store.set(key, next ? `${adapter.discoveryPath}?${new URLSearchParams(Object.entries(next).map(([k,v]) => [k,String(v)]))}` : "");
          }
        } catch (error) {
          recordFailure(error, "discovery", adapter.source.id);
          if (error instanceof Error && error.message === "RPC log cursor expired or out of range.") this.store.set(`cursor:${adapter.source.id}`, "");
        }
      }
      for (const [address, kind] of [...this.queue].slice(0, 3)) {
        if (deadline.aborted) break;
        this.queue.delete(address);
        try {
          const seeds = kind === "creation" ? await this.reader.read(`/creations/${address}`, deadline) as RadarPool[]
            : kind === "pool" ? [await this.reader.resolveV3Pool(address, deadline)] : await this.reader.findV3Pools(address, deadline);
          for (const seed of seeds) this.store.add(seed, true);
        } catch (error) {
          if (budgetCancelled(error)) this.queue.set(address, kind);
          else recordFailure(error, "lookup", address);
        }
      }
      const rows = this.store.rows();
      const hot = rows.flatMap(row => {
        if (!row.bundle) return [];
        const saved = JSON.parse(row.bundle) as MarketBundle;
        const adapter = this.adapters.find(adapter => adapter.source.id === saved.seed.sourceId)!;
        const volume = saved.logs.reduce((sum, log) => Date.now() - Date.parse(log.block_timestamp || "") < 900_000
          ? sum + (adapter.trade(log, saved.seed)?.usdcValue ?? 0) : sum, 0);
        return volume > 0 && Number.isFinite(volume) ? [{ row, volume }] : [];
      }).sort((a, b) => b.volume - a.volume).slice(0, 8);
      // Rotate the active shortlist too; a busy pair must not monopolize collection.
      const active = Array.from({ length: Math.min(2, hot.length) }, (_, i) => hot[(this.cycleNumber * 2 + i) % hot.length]!.row)
        .filter(row => Date.now() - row.attempted >= 60_000);
      const batch = [...active, ...rows.filter(row => !active.includes(row))].slice(0, 8);
      for (const row of batch) {
        if (deadline.aborted) break;
        this.store.attempt(row.ref, Date.now());
        try {
          const seed = JSON.parse(row.seed) as RadarPool;
          const suffix = seed.v4 ? `?pool=${seed.v4.poolId}` : "";
          const [token, state, page] = await Promise.all([
            this.reader.read(`/tokens/${seed.tokenAddress}`, deadline) as Promise<SnapshotToken>,
            this.reader.read(`/pools/${seed.pairAddress}/state${suffix}`, deadline) as Promise<PoolState>,
            this.reader.read(`/addresses/${seed.pairAddress}/logs${suffix}`, deadline) as Promise<DexLogPage>,
          ]);
          if (!Array.isArray(page.items) || token.decimals === null || token.total_supply === null) throw new Error("Incomplete market snapshot.");
          // Publish a whole pool atomically. Failures retain its original timestamp and data.
          this.store.save({ seed, token, state, logs: page.items.slice(0, SNAPSHOT_LIMITS.logs), fetchedAt: Date.now() });
          updatedPools++;
        } catch (error) {
          if (budgetCancelled(error)) this.store.attempt(row.ref, row.attempted);
          else recordFailure(error, "pool", row.ref);
        }
      }
    } catch (error) {
      recordFailure(error, "collector", this.store.network.id);
    } finally {
      try {
        this.store.recordCollection({ completedAt: Date.now(), budgetReached: deadline.aborted,
          failureCount: failures.length, updatedPools, failures });
      } finally { this.cycleNumber++; this.busy = false; }
    }
  }
  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      try { await this.cycle(); } catch { /* A subsequent cycle can recover without affecting reads. */ }
      if (!this.stopped) { this.timer = setTimeout(() => void tick(), 10_000); this.timer.unref(); }
    };
    void tick();
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); }
}

export function validateMarketFeedRequest(req: Pick<IncomingMessage, "method" | "headers" | "url">, port: number): void {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  if (!origins.some(origin => new URL(origin).host === req.headers.host) || req.headers["sec-fetch-site"] === "cross-site"
    || req.headers.origin && !origins.includes(String(req.headers.origin))) throw new Error("Local requests only.");
  const url = new URL(req.url || "/", origins[0]);
  if (!["GET", "POST"].includes(req.method || "") || !origins.includes(url.origin) || url.pathname !== "/api/arcrow/markets"
    || [...url.searchParams.keys()].some(key => key !== "network") || url.searchParams.getAll("network").length !== 1
    || url.searchParams.get("network") !== "arc-mainnet") throw new Error("Invalid market feed request.");
  if (req.method === "POST" && (!req.headers.origin || req.headers["content-type"] !== "application/json")) throw new Error("Same-origin JSON required.");
}

let service: LocalMarketFeed | undefined;
export async function handleMarketFeedApi(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value)); };
  try { validateMarketFeedRequest(req, port); } catch { send(400, { error: "Invalid local market feed request." }); return; }
  try {
    if (!service) {
      service = new LocalMarketFeed(new MarketFeedStore(resolveRadarNetwork("arc-mainnet")));
      // Start after the response, so even an empty first snapshot never waits on RPC.
      setTimeout(() => service?.start(), 0).unref();
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 4096) { send(413, { error: "Lookup too large." }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || !["pool", "token", "creation"].includes(body.kind) || Object.keys(body).some(k => k !== "kind" && k !== "addresses")) throw new Error("Invalid lookup.");
      service.enqueue(body.kind, body.addresses);
      send(202, { queued: service.snapshot().queued }); return;
    }
    send(200, service.snapshot());
  } catch { send(503, { error: "Local market feed unavailable." }); }
}
