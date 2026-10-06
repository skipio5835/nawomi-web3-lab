export const QUOTE_SIZES = [100, 1_000, 10_000] as const;
export const QUOTE_TTL = 30_000;
export type QuoteOptions = { side: "buy" | "sell"; baseAmount: string };
export const BUY_QUOTE: QuoteOptions = { side: "buy", baseAmount: "100000000" };
export type QuoteFailure = "no-route" | "rate-limit" | "timeout" | "invalid-data" | "unavailable";
export type QuoteRow = {
  input: number;
  fetchedAt: number;
  output: string | null;
  gasUsd: number | null;
  routes: { source: string; pool: string }[];
  error: QuoteFailure | null;
};
export type QuoteBatch = QuoteOptions & { network: "arc-mainnet"; token: string; requestedAt: number; rows: QuoteRow[] };

export function validQuoteOptions(options: QuoteOptions): boolean {
  return ["buy", "sell"].includes(options.side) && typeof options.baseAmount === "string"
    && /^[1-9]\d{0,77}$/.test(options.baseAmount)
    && BigInt(options.baseAmount) * 100n < 2n ** 256n
    && (options.side === "sell" || options.baseAmount === BUY_QUOTE.baseAmount);
}

export function quoteInputAmount(input: number, options: QuoteOptions): string {
  return String(BigInt(options.baseAmount) * BigInt(input / QUOTE_SIZES[0]));
}

export function parseQuoteQuantity(value: string, decimals: string | null): string | null {
  if (decimals === null || !/^(0|[1-9]\d?)$/.test(decimals) || Number(decimals) > 36
    || !/^(0|[1-9]\d{0,77})(\.\d{1,36})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > Number(decimals)) return null;
  const raw = String(BigInt(whole! + fraction.padEnd(Number(decimals), "0")));
  return validQuoteOptions({ side: "sell", baseAmount: raw }) ? raw : null;
}

export function validateQuoteBatch(value: unknown, expected: QuoteOptions & { token: string }): QuoteBatch {
  const batch = value as QuoteBatch;
  if (!batch || batch.network !== "arc-mainnet" || batch.token !== expected.token || batch.side !== expected.side
    || batch.baseAmount !== expected.baseAmount || !Number.isSafeInteger(batch.requestedAt) || batch.requestedAt <= 0 || batch.requestedAt > Date.now() + 5_000
    || !Array.isArray(batch.rows) || !batch.rows.length || batch.rows.length > 3) throw new Error("Quote could not be verified");
  for (const [i, row] of batch.rows.entries()) {
    if (!row || row.input !== QUOTE_SIZES[i] || !Number.isSafeInteger(row.fetchedAt) || row.fetchedAt <= 0 || row.fetchedAt > Date.now() + 5_000
      || !Array.isArray(row.routes) || row.routes.length > 256
      || row.routes.some(route => !route || typeof route.source !== "string" || typeof route.pool !== "string"
        || !/^[a-z0-9_-]{1,64}$/i.test(route.source) || !/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(route.pool))
      || row.gasUsd !== null && (typeof row.gasUsd !== "number" || !Number.isFinite(row.gasUsd) || row.gasUsd <= 0)
      || (row.error === null ? typeof row.output !== "string" || !/^[1-9]\d{0,77}$/.test(row.output)
        || BigInt(row.output) >= 2n ** 256n || !row.routes.length
        : !["no-route", "rate-limit", "timeout", "invalid-data", "unavailable"].includes(row.error) || row.output !== null || row.routes.length > 0)) {
      throw new Error("Quote could not be verified");
    }
  }
  return batch;
}

// Bounded snapshots arrive after each size; a disconnected stream is never a complete comparison.
export async function readQuoteResponse(response: Response, expected: QuoteOptions & { token: string }, onBatch: (batch: QuoteBatch) => void): Promise<QuoteBatch> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Incomplete quote comparison.");
  const streaming = response.headers.get("content-type")?.includes("application/x-ndjson");
  const decoder = new TextDecoder();
  let bytes = 0, pending = "", latest: QuoteBatch | null = null;
  function accept(line: string) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("Quote could not be verified"); }
    const next = validateQuoteBatch(value, expected);
    if (latest && (next.requestedAt !== latest.requestedAt || next.rows.length < latest.rows.length
      || latest.rows.some((row, i) => JSON.stringify(row) !== JSON.stringify(next.rows[i])))) throw new Error("Quote could not be verified");
    latest = next; onBatch(next);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256_000) throw new Error("Quote could not be verified");
      pending += decoder.decode(value, { stream: true });
      if (streaming) {
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.trim()) accept(line); }
      }
    }
    pending += decoder.decode();
    if (pending.trim()) accept(pending);
    if (!latest || (latest as QuoteBatch).rows.length !== 3) throw new Error("Incomplete quote comparison.");
    return latest;
  } finally { await reader.cancel().catch(() => {}); }
}

export function quoteExpired(row: QuoteRow, now = Date.now()): boolean {
  return !Number.isFinite(row.fetchedAt) || row.fetchedAt > now + 5_000 || now - row.fetchedAt >= QUOTE_TTL;
}

// Compare raw amounts of the same token. Never turn missing quotes into zero liquidity.
export function quoteRateDifference(row: QuoteRow, baseline: QuoteRow): number | null {
  if (!row.output || !baseline.output || row.error || baseline.error || row.input <= 0 || baseline.input <= 0) return null;
  const scaled = BigInt(row.output) * BigInt(baseline.input);
  const base = BigInt(baseline.output) * BigInt(row.input);
  if (base <= 0n) return null;
  return Number((scaled - base) * 1_000_000n / base) / 10_000;
}

export function quoteAmount(raw: string, decimals: string | number | null, locale = "en", exact = false): string {
  if (decimals === null || !/^(0|[1-9]\d?)$/.test(String(decimals)) || Number(decimals) > 36 || !/^\d{1,78}$/.test(raw)) return "--";
  const places = Number(decimals), padded = raw.padStart(places + 1, "0");
  const whole = places ? padded.slice(0, -places) : padded;
  const fraction = places ? padded.slice(-places) : "";
  const formatted = BigInt(whole).toLocaleString(locale);
  const significant = fraction.search(/[1-9]/);
  const kept = fraction.slice(0, exact ? fraction.length : Math.max(4, significant + 4)).replace(/0+$/, "");
  return kept ? `${formatted}.${kept}` : formatted;
}
