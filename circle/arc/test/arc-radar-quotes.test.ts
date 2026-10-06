import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { QuoteService, QuoteServiceError, handleQuoteApi, normalizeKyberQuote, validateQuoteRequest, quoteOptionsFromUrl } from "../scripts/radar-quotes-api.js";
import { BUY_QUOTE, parseQuoteQuantity, quoteInputAmount, readQuoteResponse, validateQuoteBatch, quoteAmount, quoteExpired, quoteRateDifference, type QuoteBatch, type QuoteRow } from "../src/arc-radar-quotes.js";

const token = "0x2164bb17a2d38c1b5170e987b2c0416df1efc752";
const usdc = "0x3600000000000000000000000000000000000000";
const now = Math.floor(Date.now() / 1000) * 1000;
function payload(input = 100, at = now) {
  return { code: 0, data: { routeSummary: { tokenIn: usdc, tokenOut: token, amountIn: String(input * 1e6),
    amountOut: String(BigInt(input) * 10n ** 18n), timestamp: at / 1000, gasUsd: "0.0125",
    extraFee: { feeAmount: "", chargeFeeBy: "", isInBps: false, feeReceiver: "" },
    route: [[{ exchange: "uniswap-v3", pool: "0xda9f3d166497ddfddf37c93cacfd8aa39b71e493" }]],
    encodedSwapData: "must-not-leak" } } };
}
const row = (input = 100, output: string | null = String(BigInt(input) * 10n ** 18n)): QuoteRow => ({ input, output, fetchedAt: now, gasUsd: null, routes: [], error: null });
const request = (query = `network=arc-mainnet&token=${token}`) => ({ method: "GET", headers: { host: "localhost:4173", origin: "http://localhost:4173" }, url: `/api/arcrow/quotes?${query}` });

test("quote requests allow only local read-only Arc mainnet token requests", () => {
  assert.equal(validateQuoteRequest(request(), 4173), token);
  for (const value of [
    { ...request(), method: "POST" }, { ...request(), method: "OPTIONS" },
    { ...request(), headers: { host: "evil.example:4173" } },
    { ...request(), headers: { host: "localhost:4173", origin: "https://evil.example" } },
    { ...request(), headers: { host: "localhost:4173", "sec-fetch-site": "cross-site" } },
    { ...request(), url: `https://evil.example/api/arcrow/quotes?network=arc-mainnet&token=${token}` },
    { ...request(), url: request().url.replace("/quotes", "/quotes-extra") },
    request(`network=arc-testnet&token=${token}`), request(`network=arc-mainnet&token=${usdc}`),
    request(`network=arc-mainnet&token=0x${"0".repeat(40)}`),
    request(`network=arc-mainnet&token=${token}&token=${token}`),
    request(`network=arc-mainnet&token=${token}&network=arc-mainnet`),
    request(`network=arc-mainnet&token=${token}&url=https://evil.example`),
    request(`network=arc-mainnet&token=${token}&feeReceiver=${token}`),
    request("network=arc-mainnet&token=../../.env"),
  ]) assert.throws(() => validateQuoteRequest(value, 4173));
});

test("quotes preserve raw amounts and normalize unknown gas without exposing transaction data", () => {
  const value = payload();
  const quote = normalizeKyberQuote(value, token, 100, now);
  assert.equal(quote.output, "100000000000000000000");
  assert.equal(quote.gasUsd, 0.0125);
  assert.doesNotMatch(JSON.stringify(quote), /encodedSwapData|must-not-leak/);
  for (const gasUsd of ["0", "NaN", "Infinity", "", "-1"]) {
    value.data.routeSummary.gasUsd = gasUsd;
    assert.equal(normalizeKyberQuote(value, token, 100, now).gasUsd, null);
  }
});

test("provider identities, stale timestamps, unexpected fees and unsafe routes fail closed", () => {
  for (const change of [
    { tokenIn: token }, { tokenOut: usdc }, { amountIn: "999" }, { amountOut: "1e18" }, { amountOut: "0" },
    { amountOut: String(2n ** 256n) }, { timestamp: 0 }, { timestamp: now / 1000 + 60 },
    { timestamp: now / 1000 - 31 }, { extraFee: { feeAmount: "10", chargeFeeBy: "currency_in" } },
    { route: [] }, { route: [[{ exchange: "<img src=x>", pool: token }]] },
    { route: [[{ exchange: "uniswap-v3", pool: "javascript:alert(1)" }]] },
  ]) {
    const value = payload(); Object.assign(value.data.routeSummary, change);
    assert.throws(() => normalizeKyberQuote(value, token, 100, now));
  }
});

test("v4 pool IDs and duplicate routes are represented without treating IDs as addresses", () => {
  const value = payload();
  const route = { exchange: "uniswap-v4", pool: `0x${"a".repeat(64)}` };
  value.data.routeSummary.route = [[route], [route]];
  assert.deepEqual(normalizeKyberQuote(value, token, 100, now).routes, [{ source: "uniswap-v4", pool: route.pool }]);
});

test("size comparisons use token-per-USDC, not total output or USD metadata", () => {
  assert.equal(quoteRateDifference(row(1000, String(980n * 10n ** 18n)), row()), -2);
  assert.equal(quoteRateDifference(row(1000, String(1010n * 10n ** 18n)), row()), 1);
  assert.equal(quoteRateDifference(row(1000), row()), 0);
  assert.equal(quoteRateDifference(row(1000), row(100, null)), null);
  assert.equal(quoteRateDifference({ ...row(), error: "no-route" }, row()), null);
  assert.equal(quoteRateDifference(row(), row(100, "0")), null);
});

test("amount formatting keeps large integers and small token quantities without float rounding", () => {
  assert.equal(quoteAmount("900719925474099300000001", 6), "900,719,925,474,099,300.000001");
  assert.equal(quoteAmount("1", 18), "0.000000000000000001");
  assert.equal(quoteAmount("123456789", 6), "123.4567");
  assert.equal(quoteAmount("123456789", 6, "en", true), "123.456789");
  assert.equal(quoteAmount("1000000", 6), "1");
  for (const decimals of [null, "", "-1", "18junk", "37"]) assert.equal(quoteAmount("1", decimals), "--");
  assert.equal(quoteExpired(row(), now + 30_000), true);
  assert.equal(quoteExpired(row(), now + 29_999), false);
});

test("service deduplicates in-flight requests, caches briefly, and makes only fixed GET routes", async () => {
  let clock = now, calls = 0;
  const service = new QuoteService(async (url, options) => {
    calls++;
    const parsed = new URL(String(url));
    assert.equal(parsed.origin + parsed.pathname, "https://aggregator-api.kyberswap.com/arc/api/v1/routes");
    assert.equal(options?.body, undefined);
    assert.equal(options?.method, undefined);
    assert.deepEqual([...parsed.searchParams.keys()].sort(), ["amountIn", "gasInclude", "tokenIn", "tokenOut"]);
    return Response.json(payload(Number(parsed.searchParams.get("amountIn")) / 1e6, clock));
  }, () => clock);
  const first = service.compare(token), duplicate = service.compare(token);
  assert.equal(await first, await duplicate);
  assert.equal(calls, 3);
  assert.equal(await service.compare(token), await first);
  clock += 31_000;
  await service.compare(token);
  assert.equal(calls, 6);
});

test("partial failure stays distinct from zero liquidity and retries after a short cache", async () => {
  let calls = 0, clock = now;
  const service = new QuoteService(async url => {
    calls++;
    const input = Number(new URL(String(url)).searchParams.get("amountIn")) / 1e6;
    if (input === 1000) return Response.json({ code: 4008 }, { status: 400 });
    if (input === 10000) throw new DOMException("deadline", "TimeoutError");
    return Response.json(payload(input, clock));
  }, () => clock);
  const result = await service.compare(token);
  assert.deepEqual(result.rows.map(row => row.error), [null, "no-route", "timeout"]);
  assert.equal(result.rows[1]!.output, null);
  clock += 6_000;
  await service.compare(token);
  assert.equal(calls, 6);
});

test("upstream limits stop remaining calls and impose a cooldown", async () => {
  let calls = 0;
  const service = new QuoteService(async () => { calls++; return new Response("busy", { status: 429 }); }, () => now);
  const batch = await service.compare(token);
  assert.equal(calls, 1);
  assert.ok(batch.rows.every(row => row.error === "rate-limit"));
  await assert.rejects(service.compare(`0x${"1".repeat(40)}`), /provider-limit/);
});

test("oversized and invalid upstream data are discarded", async () => {
  for (const body of ["x".repeat(256_001), "<html>error</html>", JSON.stringify({ code: 0, data: {} })]) {
    const service = new QuoteService(async () => new Response(body), () => now);
    assert.ok((await service.compare(token)).rows.every(row => row.error === "invalid-data" && row.output === null));
  }
});

test("sell quantities preserve exact units and reject exponent, precision loss and uint256 overflow", () => {
  assert.equal(parseQuoteQuantity("0.000000000000000001", "18"), "1");
  assert.equal(parseQuoteQuantity("12345678901234567890.123456", "6"), "12345678901234567890123456");
  assert.equal(parseQuoteQuantity("1.25", "6"), "1250000");
  for (const value of ["", "0", "-1", "1e9", ".5", "1.", "01", "1,000", "0.0000001", String(2n ** 256n)]) {
    assert.equal(parseQuoteQuantity(value, "6"), null, value);
  }
  assert.equal(parseQuoteQuantity("1", null), null);
  assert.equal(quoteInputAmount(10000, { side: "sell", baseAmount: "12345678901234567890123456" }), "1234567890123456789012345600");
  const query = `network=arc-mainnet&token=${token}`;
  assert.equal(validateQuoteRequest(request(query + "&side=sell&amount=1"), 4173), token);
  assert.deepEqual(quoteOptionsFromUrl(new URL("http://localhost/?side=sell&amount=1")), { side: "sell", baseAmount: "1" });
  for (const suffix of ["&amount=1", "&side=sell", "&side=no", "&side=sell&amount=0", "&side=sell&amount=1e9",
    "&side=sell&side=buy&amount=1", "&side=sell&amount=1&amount=2", `&side=sell&amount=${2n ** 256n / 100n + 1n}`]) {
    assert.throws(() => validateQuoteRequest(request(query + suffix), 4173), suffix);
  }
});

test("sell requests reverse token direction, scale exact token amounts and have separate cache identities", async () => {
  const seen: URL[] = [];
  const service = new QuoteService(async url => {
    const parsed = new URL(String(url)); seen.push(parsed);
    const value = payload();
    Object.assign(value.data.routeSummary, { tokenIn: parsed.searchParams.get("tokenIn"), tokenOut: parsed.searchParams.get("tokenOut"),
      amountIn: parsed.searchParams.get("amountIn"), amountOut: "1000000" });
    return Response.json(value);
  }, () => now);
  const options = { side: "sell" as const, baseAmount: "1250000000000000000" };
  const result = await service.compare(token, options);
  assert.equal(result.side, "sell");
  assert.ok(seen.every(url => url.searchParams.get("tokenIn") === token && url.searchParams.get("tokenOut") === usdc));
  assert.deepEqual(seen.map(url => url.searchParams.get("amountIn")), ["1250000000000000000", "12500000000000000000", "125000000000000000000"]);
  await service.compare(token, options); assert.equal(seen.length, 3);
  await service.compare(token, { ...options, baseAmount: "1" }); assert.equal(seen.length, 6);
  await service.compare(token); assert.equal(seen.length, 9);
  assert.throws(() => normalizeKyberQuote(payload(), token, 100, now, options), /identity/);
});

test("partial snapshots are delivered before completion and local contention is not a provider limit", async () => {
  let release!: () => void, arrived!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstRow = new Promise<void>(resolve => { arrived = resolve; });
  const service = new QuoteService(async url => {
    if (++calls === 2) await gate;
    return Response.json(payload(Number(new URL(String(url)).searchParams.get("amountIn")) / 1e6));
  }, () => now);
  const sizes: number[] = [], shared: number[] = [];
  const pending = service.compare(token, BUY_QUOTE, value => { sizes.push(value.rows.length); arrived(); });
  try {
    await firstRow;
    assert.deepEqual(sizes, [1]);
    const duplicate = service.compare(token, BUY_QUOTE, value => shared.push(value.rows.length));
    assert.deepEqual(shared, [1]);
    await assert.rejects(service.compare(`0x${"1".repeat(40)}`), error => error instanceof QuoteServiceError && error.code === "local-busy" && error.retryAfter === 2);
    release(); await pending; await duplicate;
    assert.deepEqual(sizes, [1, 2, 3]); assert.deepEqual(shared, [1, 2, 3]); assert.equal(calls, 3);
  } finally { release(); await pending; }
});

test("local batch budget has a distinct retry deadline", async () => {
  const service = new QuoteService(async () => Response.json({ code: 4008 }, { status: 400 }), () => now);
  for (let i = 1; i <= 6; i++) await service.compare(`0x${i.toString(16).padStart(40, "0")}`);
  await assert.rejects(service.compare(token), error => error instanceof QuoteServiceError && error.code === "local-limit" && error.retryAfter === 60);
});

function goodBatch(): QuoteBatch {
  return { network: "arc-mainnet", token, requestedAt: now, ...BUY_QUOTE,
    rows: [100, 1000, 10000].map(input => normalizeKyberQuote(payload(input), token, input, now)) };
}

test("client validates gas, routes, amounts and direction before displaying streamed data", () => {
  const expected = { token, ...BUY_QUOTE };
  assert.deepEqual(validateQuoteBatch(goodBatch(), expected), goodBatch());
  for (const change of [{ gasUsd: "oops" }, { routes: null }, { routes: [{ source: "<img>", pool: token }] },
    { routes: [] }, { error: "bogus" }, { error: "timeout", output: "1" }, { fetchedAt: 1e20 }, { output: String(2n ** 256n) }]) {
    const value = goodBatch(); Object.assign(value.rows[0]!, change);
    assert.throws(() => validateQuoteBatch(value, expected), /verified/);
  }
  assert.throws(() => validateQuoteBatch({ ...goodBatch(), side: "sell" }, expected), /verified/);
});

test("stream parser publishes partial rows, bounds input and rejects truncation or revised earlier rows", async () => {
  const value = goodBatch(), expected = { token, ...BUY_QUOTE }, sizes: number[] = [];
  const lines = [1, 2, 3].map(count => JSON.stringify({ ...value, rows: value.rows.slice(0, count) }) + "\n");
  const response = new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(lines.join(""));
    for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
    controller.close();
  } }), { headers: { "content-type": "application/x-ndjson" } });
  await readQuoteResponse(response, expected, batch => sizes.push(batch.rows.length));
  assert.deepEqual(sizes, [1, 2, 3]);
  await assert.rejects(readQuoteResponse(new Response(lines[0], { headers: { "content-type": "application/x-ndjson" } }), expected, () => {}), /Incomplete/);
  await assert.rejects(readQuoteResponse(new Response("x".repeat(256001)), expected, () => {}), /verified/);
  await assert.rejects(readQuoteResponse(new Response("<html>bad gateway</html>"), expected, () => {}), /verified/);
  const changed = goodBatch(); changed.rows[0]!.output = "9";
  await assert.rejects(readQuoteResponse(new Response(lines[0] + JSON.stringify(changed), { headers: { "content-type": "application/x-ndjson" } }), expected, () => {}), /verified/);
  assert.deepEqual(await readQuoteResponse(Response.json(value), expected, () => {}), value);
});

test("HTTP streams the first quote before later requests and distinguishes retry reasons", async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new QuoteService(async url => {
    if (++calls === 2) await gate;
    return Response.json(payload(Number(new URL(String(url)).searchParams.get("amountIn")) / 1e6));
  }, () => now);
  let port = 0;
  const server = createServer((req, res) => void handleQuoteApi(req, res, port, service));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  port = (server.address() as { port: number }).port;
  try {
    const base = `http://127.0.0.1:${port}/api/arcrow/quotes?network=arc-mainnet&token=`;
    const response = await fetch(base + token, { headers: { Accept: "application/x-ndjson" } });
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(JSON.parse(new TextDecoder().decode(first.value).trim()).rows.length, 1);
    const busy = await fetch(base + `0x${"1".repeat(40)}`);
    assert.equal(busy.status, 503); assert.equal(busy.headers.get("retry-after"), "2");
    assert.deepEqual(await busy.json(), { error: "local-busy" });
    release(); while (!(await reader.read()).done) { /* Drain remaining snapshots. */ }
    const cached = await fetch(base + token); assert.equal(cached.status, 200); await cached.json();
    assert.equal(calls, 3);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
