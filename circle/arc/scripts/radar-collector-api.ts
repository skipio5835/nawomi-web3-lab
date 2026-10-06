import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { resolveRadarNetwork } from "../src/arc-radar-networks.js";
import { validPoolRef } from "../src/arc-radar-pool-id.js";
import { CollectorStore, collectorDbPath } from "./radar-collector-store.js";

export function validateCollectorRequest(req: Pick<IncomingMessage, "method" | "url" | "headers">, port: number) {
  const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (req.method !== "GET") throw new Error("GET only");
  if (!allowed.includes(req.headers.host ?? "") || req.headers["sec-fetch-site"] === "cross-site") throw new Error("Local origin required");
  const origin = req.headers.origin;
  if (origin && !allowed.map(host => `http://${host}`).includes(origin)) throw new Error("Local origin required");
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== "/api/arcrow/collector" || [...url.searchParams.keys()].some(key => !["network", "pool"].includes(key))
    || url.searchParams.getAll("network").length !== 1 || url.searchParams.getAll("pool").length > 1) throw new Error("Invalid collector query");
  const network = resolveRadarNetwork(url.searchParams.get("network")!);
  if (network.dataMode === "rpc-dex") throw new Error("Background RPC collection is not supported");
  const pool = url.searchParams.get("pool");
  if (pool !== null && !validPoolRef(pool)) throw new Error("Invalid pool identity");
  return { network, pool: pool?.toLowerCase() };
}

export function handleCollectorApi(req: IncomingMessage, res: ServerResponse, port: number): void {
  const respond = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(data)); };
  let parsed: ReturnType<typeof validateCollectorRequest>;
  try { parsed = validateCollectorRequest(req, port); }
  catch { respond(400, { error: "Invalid local collector request" }); return; }
  const file = collectorDbPath(parsed.network);
  if (!existsSync(file)) { respond(404, { error: "Collector has not been started" }); return; }
  let store: CollectorStore | undefined;
  try { store = new CollectorStore(parsed.network, file, true); respond(200, store.snapshot(parsed.pool)); }
  catch { respond(503, { error: "Local collection unavailable" }); }
  finally { store?.close(); }
}
