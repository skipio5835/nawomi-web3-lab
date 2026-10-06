import type { IncomingMessage, ServerResponse } from "node:http";
import { ARC_RADAR_MAINNET } from "../src/arc-radar-networks.js";
import { BUY_QUOTE, QUOTE_SIZES, QUOTE_TTL, quoteInputAmount, validQuoteOptions, type QuoteOptions, type QuoteBatch, type QuoteRow, type QuoteFailure } from "../src/arc-radar-quotes.js";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const USDC = ARC_RADAR_MAINNET.quoteAsset.address.toLowerCase();
const integer = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid data");
  return value as Record<string, unknown>;
};

export function validateQuoteRequest(req: Pick<IncomingMessage, "method" | "headers" | "url">, port: number): string {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const url = new URL(req.url || "/", origins[0]);
  if (req.method !== "GET" || !origins.some(origin => new URL(origin).host === req.headers.host)
    || req.headers["sec-fetch-site"] === "cross-site" || req.headers.origin && !origins.includes(String(req.headers.origin))
    || !origins.includes(url.origin) || url.pathname !== "/api/arcrow/quotes"
    || [...url.searchParams.keys()].some(key => !["network", "token", "side", "amount"].includes(key))
    || url.searchParams.getAll("network").length !== 1 || url.searchParams.get("network") !== "arc-mainnet"
    || url.searchParams.getAll("token").length !== 1) throw new Error("Invalid request");
  const token = url.searchParams.get("token")!.toLowerCase();
  if (!ADDRESS.test(token) || token === USDC || /^0x0{40}$/.test(token)) throw new Error("Invalid token");
  quoteOptionsFromUrl(url);
  return token;
}

export function quoteOptionsFromUrl(url: URL): QuoteOptions {
  const side = url.searchParams.get("side") ?? "buy", amount = url.searchParams.get("amount");
  if (url.searchParams.getAll("side").length > 1 || url.searchParams.getAll("amount").length > 1
    || !["buy", "sell"].includes(side) || side === "buy" && amount !== null) throw new Error("Invalid size");
  const options = { side, baseAmount: side === "sell" ? amount ?? "" : BUY_QUOTE.baseAmount } as QuoteOptions;
  if (!validQuoteOptions(options)) throw new Error("Invalid size");
  return options;
}

export function normalizeKyberQuote(value: unknown, token: string, input: number, fetchedAt: number, options = BUY_QUOTE): QuoteRow {
  const root = record(value), data = record(root.data), summary = record(data.routeSummary);
  if (root.code !== 0 || String(summary.tokenIn).toLowerCase() !== (options.side === "buy" ? USDC : token)
    || String(summary.tokenOut).toLowerCase() !== (options.side === "buy" ? token : USDC)
    || summary.amountIn !== quoteInputAmount(input, options) || !integer(summary.amountOut) || BigInt(summary.amountOut) <= 0n
    || BigInt(summary.amountOut) >= 2n ** 256n) throw new Error("Invalid quote identity");
  const timestamp = Number(summary.timestamp) * 1_000;
  if (!Number.isFinite(timestamp) || fetchedAt - timestamp > QUOTE_TTL || timestamp > fetchedAt + 5_000) throw new Error("Stale quote");
  const fee = record(summary.extraFee);
  if (fee.feeAmount !== "" && fee.feeAmount !== "0" || fee.chargeFeeBy !== "") throw new Error("Unexpected fee");
  if (!Array.isArray(summary.route) || !summary.route.length || summary.route.length > 32) throw new Error("Invalid route");
  const routes = summary.route.flatMap(path => {
    if (!Array.isArray(path) || !path.length || path.length > 8) throw new Error("Invalid route");
    return path.map(value => {
      const hop = record(value);
      if (typeof hop.exchange !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(hop.exchange)
        || typeof hop.pool !== "string" || !POOL.test(hop.pool)) throw new Error("Invalid pool");
      return { source: hop.exchange, pool: hop.pool.toLowerCase() };
    });
  });
  const gas = typeof summary.gasUsd === "string" && /^\d+(\.\d+)?$/.test(summary.gasUsd) ? Number(summary.gasUsd) : NaN;
  return { input, fetchedAt: Math.min(fetchedAt, timestamp), output: summary.amountOut,
    gasUsd: Number.isFinite(gas) && gas > 0 ? gas : null,
    routes: [...new Map(routes.map(route => [`${route.source}:${route.pool}`, route])).values()], error: null };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 256_000) throw new Error("Oversized response");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export class QuoteServiceError extends Error {
  constructor(readonly code: "local-busy" | "local-limit" | "provider-limit", readonly retryAfter: number) { super(code); }
}

export class QuoteService {
  private cache = new Map<string, QuoteBatch>();
  private flight: { key: string; promise: Promise<QuoteBatch>; latest: QuoteBatch | null; listeners: Set<(batch: QuoteBatch) => void> } | null = null;
  private requests: number[] = [];
  private cooldown = 0;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}

  async compare(token: string, options = BUY_QUOTE, onBatch?: (batch: QuoteBatch) => void): Promise<QuoteBatch> {
    token = token.toLowerCase();
    if (!ADDRESS.test(token) || token === USDC || /^0x0{40}$/.test(token) || !validQuoteOptions(options)) throw new Error("Invalid token or size");
    const key = `${token}:${options.side}:${options.baseAmount}`;
    const now = this.now(), cached = this.cache.get(key);
    if (cached && now - cached.requestedAt < (cached.rows.some(row => row.error) ? 5_000 : QUOTE_TTL)
      && cached.rows.every(row => now - row.fetchedAt < QUOTE_TTL)) { onBatch?.(cached); return cached; }
    if (this.flight?.key === key) {
      const flight = this.flight;
      if (onBatch) { flight.listeners.add(onBatch); if (flight.latest) onBatch(flight.latest); }
      try { return await flight.promise; } finally { if (onBatch) flight.listeners.delete(onBatch); }
    }
    this.requests = this.requests.filter(time => now - time < 60_000);
    if (now < this.cooldown) throw new QuoteServiceError("provider-limit", Math.max(1, Math.ceil((this.cooldown - now) / 1000)));
    if (this.flight) throw new QuoteServiceError("local-busy", 2);
    if (this.requests.length >= 6) throw new QuoteServiceError("local-limit", Math.max(1, Math.ceil((this.requests[0]! + 60_000 - now) / 1000)));
    this.requests.push(now);
    const listeners = new Set(onBatch ? [onBatch] : []);
    const promise = this.collect(token, now, options, batch => {
      if (this.flight?.key === key) this.flight.latest = batch;
      for (const listener of listeners) listener(batch);
    });
    this.flight = { key, promise, latest: null, listeners };
    try {
      const result = await promise;
      this.cache.delete(key);
      this.cache.set(key, result);
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
      return result;
    } finally { this.flight = null; }
  }

  private async collect(token: string, requestedAt: number, options: QuoteOptions, publish: (batch: QuoteBatch) => void): Promise<QuoteBatch> {
    const rows: QuoteRow[] = [];
    const add = (row: QuoteRow) => { rows.push(row); publish({ network: "arc-mainnet", token, requestedAt, ...options, rows: [...rows] }); };
    for (const input of QUOTE_SIZES) {
      let error: QuoteFailure = "unavailable";
      if (this.now() < this.cooldown) error = "rate-limit";
      else {
        // Fixed read-only endpoint; no wallet, fee recipient, calldata or build request.
        const url = new URL("https://aggregator-api.kyberswap.com/arc/api/v1/routes");
        url.search = new URLSearchParams({ tokenIn: options.side === "buy" ? USDC : token,
          tokenOut: options.side === "buy" ? token : USDC, amountIn: quoteInputAmount(input, options), gasInclude: "true" }).toString();
        try {
          const response = await this.fetcher(url, { headers: { "x-client-id": "arcrow-local-quotes", Accept: "application/json" },
            signal: AbortSignal.timeout(8_000), redirect: "error" });
          if (response.status === 429) { this.cooldown = this.now() + 60_000; error = "rate-limit"; await response.body?.cancel(); }
          else if (response.status >= 500) { await response.body?.cancel(); }
          else {
            error = "invalid-data";
            const value = await boundedJson(response), root = record(value);
            if ([4008, 4010, 4011].includes(Number(root.code))) error = "no-route";
            else if (response.ok && root.code === 0) { add(normalizeKyberQuote(value, token, input, this.now(), options)); continue; }
            else error = "unavailable";
          }
        } catch (cause) {
          if (cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name)) error = "timeout";
        }
      }
      add({ input, fetchedAt: this.now(), output: null, gasUsd: null, routes: [], error });
    }
    return { network: "arc-mainnet", token, requestedAt, ...options, rows };
  }
}

const service = new QuoteService();
export async function handleQuoteApi(req: IncomingMessage, res: ServerResponse, port: number, quotes = service): Promise<void> {
  const send = (status: number, value: unknown, retryAfter?: number) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
      ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) });
    res.end(JSON.stringify(value));
  };
  let token: string;
  try { token = validateQuoteRequest(req, port); } catch { send(400, { error: "invalid-request" }); return; }
  const streaming = req.headers.accept === "application/x-ndjson";
  const options = quoteOptionsFromUrl(new URL(req.url!, `http://localhost:${port}`));
  try {
    const batch = await quotes.compare(token, options, streaming ? partial => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
      res.write(JSON.stringify(partial) + "\n");
    } : undefined);
    if (res.destroyed || res.writableEnded) return;
    if (streaming) res.end(); else send(200, batch);
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.end(); return; }
    if (error instanceof QuoteServiceError) send(error.code === "local-busy" ? 503 : 429, { error: error.code }, error.retryAfter);
    else send(503, { error: "unavailable" });
  }
}
