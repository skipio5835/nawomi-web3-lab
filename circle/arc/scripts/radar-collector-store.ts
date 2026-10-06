import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { RadarNetwork } from "../src/arc-radar-networks.js";
import type { RadarPool } from "../src/arc-radar-dex.js";
import { poolRef } from "../src/arc-radar-pool-id.js";
import type { CollectorEvent } from "./radar-collector-codec.js";

export const COLLECTOR_LIMITS = { pools: 150, pagesPerStream: 2, streamsPerCycle: 6, intervalMs: 60_000, deadlineMs: 45_000, retentionDays: 30, events: 100_000 };
export type StreamState = {
  anchor: string | null; target: string | null; cursor: string | null; cursors: string[];
  initialized: boolean; bootstrapPartial: boolean; gaps: number; completedAt: number | null;
  error: string | null; failures: number; retryAt: number;
};
export type CollectorStream = { id: string; sourceId: string; emitter: string; pool: string | null; state: StreamState; lastAttempt: number };
const initial = (): StreamState => ({ anchor: null, target: null, cursor: null, cursors: [], initialized: false, bootstrapPartial: false, gaps: 0, completedAt: null, error: null, failures: 0, retryAt: 0 });
export const collectorDbPath = (network: RadarNetwork) => path.resolve(process.cwd(), ".local", "arcrow", `${network.id}.sqlite`);
const fingerprint = (network: RadarNetwork) => createHash("sha256").update(JSON.stringify(network)).digest("hex");

export class CollectorStore {
  readonly db: DatabaseSync;
  constructor(readonly network: RadarNetwork, file: string, readonly readOnly = false) {
    if (!readOnly && file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { readOnly, timeout: 1500 });
    try {
      this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1500;");
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (version !== 1 && (readOnly || version !== 0)) throw new Error("Unsupported collector database version");
      if (!readOnly) {
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA max_page_count=32768;
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS pools (ref TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS streams (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, emitter TEXT NOT NULL, pool TEXT, state TEXT NOT NULL, last_attempt INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS events (pool TEXT NOT NULL, hash TEXT NOT NULL, idx INTEGER NOT NULL, block INTEGER NOT NULL, block_hash TEXT NOT NULL, at TEXT NOT NULL, observed_at INTEGER NOT NULL, kind TEXT NOT NULL, amount TEXT, PRIMARY KEY(pool,hash,idx)) STRICT;
          CREATE INDEX IF NOT EXISTS events_time ON events(at);
          PRAGMA user_version=1;`);
        this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('config', ?)").run(fingerprint(network));
      }
      if (this.getMeta("config") !== fingerprint(network)) throw new Error("Collector network/source configuration changed; use a separate reviewed database");
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  getMeta(key: string): string | null { return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value as string ?? null; }
  setMeta(key: string, value: string): void { this.db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  acquire(owner: string, now: number): void {
    this.transaction(() => {
      if (Number(this.getMeta("leaseUntil")) > now && this.getMeta("owner") !== owner) throw new Error("A collector already holds this database lease");
      this.setMeta("owner", owner); this.setMeta("leaseUntil", String(now + 180_000));
    });
  }
  checkOwner(owner: string): void { if (this.getMeta("owner") !== owner) throw new Error("Collector lease was replaced"); }
  release(owner: string): void { this.transaction(() => { if (this.getMeta("owner") === owner) this.setMeta("leaseUntil", "0"); }); }
  addStream(sourceId: string, emitter: string, pool: string | null = null): void {
    const id = pool === null ? `source:${sourceId}` : `pool:${pool}`;
    this.db.prepare("INSERT OR IGNORE INTO streams VALUES (?,?,?,?,?,0)").run(id, sourceId, emitter.toLowerCase(), pool, JSON.stringify(initial()));
  }
  streams(): CollectorStream[] {
    return this.db.prepare("SELECT * FROM streams ORDER BY last_attempt,id").all().map(row => ({ id: row.id as string, sourceId: row.source_id as string,
      emitter: row.emitter as string, pool: row.pool as string | null, state: JSON.parse(row.state as string), lastAttempt: Number(row.last_attempt) }));
  }
  stream(id: string): CollectorStream { return this.streams().find(stream => stream.id === id)!; }
  saveStream(stream: CollectorStream): void { this.db.prepare("UPDATE streams SET state=?,last_attempt=? WHERE id=?").run(JSON.stringify(stream.state), stream.lastAttempt, stream.id); }
  pools(): RadarPool[] { return this.db.prepare("SELECT data FROM pools").all().map(row => JSON.parse(row.data as string)); }
  insertPools(pools: RadarPool[]): number {
    let skipped = 0;
    for (const pool of pools) {
      const ref = poolRef(pool);
      if (this.db.prepare("SELECT 1 FROM pools WHERE ref=?").get(ref)) continue;
      if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM pools").get()!.n) >= COLLECTOR_LIMITS.pools) { skipped++; continue; }
      this.db.prepare("INSERT INTO pools VALUES (?,?)").run(ref, JSON.stringify(pool));
      // A v4 singleton has one shared stream, already registered as a source.
      if (!pool.v4) this.addStream(pool.sourceId, pool.pairAddress, ref);
    }
    if (skipped) this.setMeta("poolLimitReached", "1");
    return skipped;
  }
  insertEvents(events: CollectorEvent[]): void {
    for (const event of events) {
      if (!this.db.prepare("SELECT 1 FROM pools WHERE ref=?").get(event.pool)) continue;
      const old = this.db.prepare("SELECT * FROM events WHERE pool=? AND hash=? AND idx=?").get(event.pool, event.hash, event.index);
      if (old) {
        if (old.block_hash !== event.blockHash || old.block !== event.block || old.at !== event.at || old.kind !== event.kind || old.amount !== event.amount) throw new Error("Stored event conflict; checkpoint not advanced");
        continue;
      }
      this.db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)").run(event.pool, event.hash, event.index, event.block, event.blockHash, event.at, event.observedAt, event.kind, event.amount);
    }
  }
  prune(now: number): void {
    this.db.prepare("DELETE FROM events WHERE at < ?").run(new Date(now - COLLECTOR_LIMITS.retentionDays * 86_400_000).toISOString());
    this.db.prepare("DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY at DESC,idx DESC LIMIT -1 OFFSET ?)").run(COLLECTOR_LIMITS.events);
  }
  snapshot(pool?: string, now = Date.now()) {
    const streams = this.streams();
    const rows = pool ? this.db.prepare("SELECT * FROM events WHERE pool=? ORDER BY at DESC,idx DESC LIMIT 20").all(pool)
      : this.db.prepare("SELECT * FROM events WHERE kind='pool-created' ORDER BY at DESC,idx DESC LIMIT 8").all();
    return { version: 1, network: this.network.id, chainId: this.network.chainId, generatedAt: now,
      leaseUntil: Number(this.getMeta("leaseUntil")), lastAttempt: Number(this.getMeta("lastAttempt")), lastSuccess: Number(this.getMeta("lastSuccess")),
      error: this.getMeta("error"), poolCount: this.pools().length, poolLimitReached: this.getMeta("poolLimitReached") === "1",
      eventCount: Number(this.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n),
      streams: streams.map(s => ({ id: s.id, sourceId: s.sourceId, pool: s.pool, completedAt: s.state.completedAt, lastAttempt: s.lastAttempt,
        pending: Boolean(s.state.cursor), initialized: s.state.initialized, bootstrapPartial: s.state.bootstrapPartial, gaps: s.state.gaps, error: s.state.error })),
      events: rows.map(row => ({ pool: row.pool as string, hash: row.hash as string, index: Number(row.idx), block: Number(row.block), blockHash: row.block_hash as string,
        at: row.at as string, observedAt: Number(row.observed_at), kind: row.kind as CollectorEvent["kind"], amount: row.amount as string | null })) };
  }
}
