import { configuredVenue } from "../src/arc-radar-sources.js";
import { validateRadarNetwork, type RadarNetwork } from "../src/arc-radar-networks.js";
import { collectorPage, collectDecoded, logKey } from "./radar-collector-codec.js";
import { CollectorStore, COLLECTOR_LIMITS, type CollectorStream } from "./radar-collector-store.js";

export type CollectorTransport = { get: (url: string, signal: AbortSignal) => Promise<unknown>; chainId: (signal: AbortSignal) => Promise<number> };
export function collectorTransport(network: RadarNetwork): CollectorTransport {
  async function json(url: string, signal: AbortSignal, body?: string) {
    const response = await fetch(url, { method: body ? "POST" : "GET", body, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      redirect: "error", credentials: "omit", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) } });
    if (!response.ok) throw new Error(`Public data HTTP ${response.status}`);
    const reader = response.body?.getReader(); if (!reader) throw new Error("Missing response body");
    let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
        if (bytes > 2_000_000) throw new Error("Public data response too large"); chunks.push(part.value); }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return { get: (url, signal) => {
    const target = new URL(url), base = new URL(network.apiBase);
    if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname}/addresses/`)) throw new Error("Unconfigured data origin");
    return json(url, signal);
  }, chainId: async signal => {
    const value = await json(network.rpcUrl, signal, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
    if (value.error || typeof value.result !== "string" || !/^0x[0-9a-f]+$/i.test(value.result)) throw new Error("Invalid chain identity response");
    return Number(BigInt(value.result));
  } };
}

export class RadarCollector {
  constructor(readonly store: CollectorStore, readonly transport: CollectorTransport, readonly owner: string) {
    validateRadarNetwork(store.network);
    if (store.network.dataMode === "rpc-dex") throw new Error("The background recorder currently requires an explorer index; RPC mainnet uses browser observations only.");
    for (const source of store.network.sources) {
      if (!configuredVenue(store.network, source.id)) throw new Error("Source is not registered for collection");
      store.addStream(source.id, source.factoryAddress);
    }
  }
  async collectStream(stream: CollectorStream, signal: AbortSignal): Promise<void> {
    const source = this.store.network.sources.find(s => s.id === stream.sourceId)!;
    for (let i = 0; i < COLLECTOR_LIMITS.pagesPerStream; i++) {
      signal.throwIfAborted();
      const query = stream.state.cursor ? `?${stream.state.cursor}` : "";
      const data = await this.transport.get(`${this.store.network.apiBase}/addresses/${stream.emitter}/logs${query}`, signal);
      const now = Date.now();
      const page = collectorPage(data, stream.emitter, now);
      if (page.cursor && (page.cursor === stream.state.cursor || stream.state.cursors.includes(page.cursor))) throw new Error("Pagination repeated; checkpoint retained");
      if (!page.items.length && page.cursor) throw new Error("Empty page has a continuation");
      const bootstrap = !stream.state.initialized;
      const anchorFound = stream.state.anchor !== null && page.items.some(log => logKey(log) === stream.state.anchor);
      const target = stream.state.target ?? (page.items[0] ? logKey(page.items[0]) : stream.state.anchor);
      const done = bootstrap || anchorFound || page.cursor === null;
      const decoded = collectDecoded(this.store.network, source, page.items, this.store.pools(), now);
      const state = { ...stream.state, initialized: true, target: done ? null : target, cursor: done ? null : page.cursor,
        anchor: done ? target : stream.state.anchor, cursors: done ? [] : [...stream.state.cursors, page.cursor!],
        bootstrapPartial: stream.state.bootstrapPartial || bootstrap && page.cursor !== null,
        gaps: stream.state.gaps + (!bootstrap && !anchorFound && stream.state.anchor !== null && page.cursor === null ? 1 : 0),
        completedAt: done ? now : stream.state.completedAt, error: null, failures: 0, retryAt: 0 };
      if (state.cursors.length > 500) throw new Error("Backfill cursor budget reached; checkpoint retained");
      this.store.transaction(() => {
        this.store.checkOwner(this.owner);
        this.store.insertPools(decoded.discovered);
        this.store.insertEvents(decoded.events);
        this.store.saveStream({ ...stream, state, lastAttempt: now });
      });
      stream = this.store.stream(stream.id);
      if (done) break;
    }
  }
  async cycle(): Promise<void> {
    const start = Date.now(); this.store.acquire(this.owner, start);
    this.store.setMeta("lastAttempt", String(start));
    const signal = AbortSignal.timeout(COLLECTOR_LIMITS.deadlineMs);
    try {
      if (await this.transport.chainId(signal) !== this.store.network.chainId) throw new Error("RPC chain ID mismatch; no logs collected");
      let failure = false;
      const sources = this.store.streams().filter(s => s.pool === null);
      const work: CollectorStream[] = [...sources];
      // Newly discovered pool streams become eligible in this same cycle.
      for (let index = 0; index < COLLECTOR_LIMITS.streamsPerCycle; index++) {
        if (index === sources.length) work.push(...this.store.streams().filter(s => s.pool !== null && s.state.retryAt <= Date.now()).slice(0, COLLECTOR_LIMITS.streamsPerCycle - sources.length));
        const stream = work[index]; if (!stream) break;
        if (stream.state.retryAt > Date.now()) { failure = true; continue; }
        try { await this.collectStream(stream, signal); }
        catch (error) {
          failure = true;
          const current = this.store.stream(stream.id); current.lastAttempt = Date.now();
          current.state.failures++; current.state.retryAt = Date.now() + Math.min(600_000, 30_000 * 2 ** Math.min(5, current.state.failures));
          current.state.error = error instanceof Error ? error.message.slice(0, 180) : "Collection failed";
          this.store.transaction(() => { this.store.checkOwner(this.owner); this.store.saveStream(current); });
          if (signal.aborted) break;
        }
      }
      this.store.transaction(() => {
        this.store.checkOwner(this.owner); this.store.prune(Date.now());
        this.store.setMeta("error", failure ? "Some streams failed or are cooling down" : "");
        if (!failure) this.store.setMeta("lastSuccess", String(Date.now()));
      });
    } catch (error) {
      this.store.checkOwner(this.owner);
      this.store.setMeta("error", error instanceof Error ? error.message.slice(0, 180) : "Collection failed");
      throw error;
    }
  }
}
