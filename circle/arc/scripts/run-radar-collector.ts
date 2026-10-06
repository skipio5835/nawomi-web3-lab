import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { resolveRadarNetwork } from "../src/arc-radar-networks.js";
import { CollectorStore, collectorDbPath, COLLECTOR_LIMITS } from "./radar-collector-store.js";
import { RadarCollector, collectorTransport } from "./radar-collector.js";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--watch" && !/^--network=arc-(testnet|mainnet)$/.test(arg))
  || args.filter(arg => arg.startsWith("--network=")).length > 1) throw new Error("Use --watch and/or --network=arc-testnet");
const network = resolveRadarNetwork(args.find(arg => arg.startsWith("--network="))?.split("=")[1] ?? "arc-testnet");
if (network.dataMode === "rpc-dex") throw new Error("Mainnet uses browser RPC observations; the background recorder currently supports testnet only.");
const owner = randomUUID();
const store = new CollectorStore(network, collectorDbPath(network));
const stop = new AbortController();
process.on("SIGINT", () => stop.abort()); process.on("SIGTERM", () => stop.abort());
try {
  const collector = new RadarCollector(store, collectorTransport(network), owner);
  store.acquire(owner, Date.now());
  do {
    try { await collector.cycle(); }
    catch (error) { console.error(error instanceof Error ? error.message : "Collector cycle failed"); if (!args.includes("--watch")) process.exitCode = 1; }
    const snapshot = store.snapshot();
    console.log(JSON.stringify({ network: network.id, pools: snapshot.poolCount, events: snapshot.eventCount,
      streams: snapshot.streams.length, pending: snapshot.streams.filter(s => s.pending || !s.initialized).length,
      errors: snapshot.streams.filter(s => s.error).length, error: snapshot.error || null }));
    if (!args.includes("--watch") || stop.signal.aborted) break;
    await setTimeout(COLLECTOR_LIMITS.intervalMs, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
} finally { store.release(owner); store.close(); }
