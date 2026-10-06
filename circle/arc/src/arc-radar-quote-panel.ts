import { createElement, RefreshCw } from "lucide";
import { copy, localize, type UiCopy } from "./arc-radar-i18n.js";
import { BUY_QUOTE, QUOTE_SIZES, parseQuoteQuantity, quoteInputAmount, quoteAmount, quoteExpired, quoteRateDifference, readQuoteResponse, type QuoteOptions, type QuoteBatch, type QuoteFailure } from "./arc-radar-quotes.js";

type Selection = { chainId: number; tokenAddress: string; token: { symbol?: string | null; decimals: string | null } };
const messages: Record<QuoteFailure, string> = {
  "no-route": "No quote returned", "rate-limit": "Provider rate limit. Try again later.",
  timeout: "Quote request timed out", "invalid-data": "Quote could not be verified", unavailable: "Quote provider unavailable",
};
const sourceName = (source: string) => ({ "uniswap-v3": "Uniswap V3", "uniswap-v4": "Uniswap V4" })[source] ?? source;

export function createQuoteComparison() {
  const host = document.getElementById("quoteComparison")!;
  const button = document.getElementById("compareQuotes") as HTMLButtonElement;
  const status = document.getElementById("quoteStatus")!;
  const rows = document.getElementById("quoteRows")!;
  const scope = document.getElementById("quoteScope")!;
  const quantity = document.getElementById("quoteSellQuantity") as HTMLInputElement;
  const modes = [...host.querySelectorAll<HTMLButtonElement>("[data-quote-side]")];
  button.prepend(createElement(RefreshCw, { width: 17, height: 17, "aria-hidden": "true" }));
  let selection: Selection | null = null, key = "", batch: QuoteBatch | null = null;
  let controller: AbortController | null = null, busy = false, failure: string | UiCopy = "";
  let side: QuoteOptions["side"] = "buy", retryUntil = 0;

  function options(): QuoteOptions | null {
    if (side === "buy") return BUY_QUOTE;
    const baseAmount = parseQuoteQuantity(quantity.value.trim(), selection?.token.decimals ?? null);
    return baseAmount ? { side, baseAmount } : null;
  }
  function availability(): string {
    if (!selection || selection.chainId !== 5042) return "Quotes available on Arc Mainnet only";
    if (!["localhost", "127.0.0.1"].includes(location.hostname)) return "Quote comparison is local-only";
    if (selection.tokenAddress.toLowerCase() === "0x3600000000000000000000000000000000000000") return "Select a token other than USDC";
    if (quoteAmount("1", selection.token.decimals) === "--") return "Token decimals unavailable";
    if (!options()) return "Enter a valid token quantity.";
    return "";
  }
  function reset() {
    controller?.abort(); controller = null; busy = false; batch = null; failure = ""; retryUntil = 0;
  }

  function draw() {
    const unavailable = availability(), config = options(), symbol = selection?.token.symbol || "token";
    const retrySeconds = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
    host.setAttribute("aria-busy", String(busy));
    button.disabled = busy || Boolean(unavailable) || retrySeconds > 0;
    modes.forEach(mode => mode.setAttribute("aria-pressed", String(mode.dataset.quoteSide === side)));
    document.getElementById("quoteSellFields")!.hidden = side !== "sell";
    localize(scope, copy(side === "buy" ? "KyberSwap / Arc Mainnet / USDC to {symbol}" : "KyberSwap / Arc Mainnet / {symbol} to USDC", { symbol }));
    document.getElementById("quoteInputHeader")!.textContent = side === "buy" ? "USDC" : symbol;
    localize(document.getElementById("quoteOutputHeader")!, side === "buy" ? "Estimated tokens" : "Estimated USDC");
    localize(document.getElementById("quoteQuantityLabel")!, copy("Base quantity ({symbol})", { symbol }));
    const expired = batch?.rows.some(row => !row.error && quoteExpired(row));
    const failed = batch?.rows.filter(row => row.error).length ?? 0;
    const success = (batch?.rows.length ?? 0) - failed;
    host.dataset.quoteExpired = String(Boolean(expired));
    let message: string | UiCopy = unavailable || "No quotes requested.";
    if (!unavailable) {
      if (busy) message = copy("Received {count}/3 quotes. Remaining sizes loading...", { count: batch?.rows.length ?? 0 });
      else if (failure) message = failure;
      else if (batch) message = !success ? "All quotes failed. No comparison available."
        : expired ? "Quotes expired. Refresh before comparing."
        : failed ? copy("{count}/3 quotes available. Some sizes failed.", { count: success }) : "Estimates only. No transaction submitted.";
    }
    if (retrySeconds) message = copy("{message} Retry in {seconds}s.", { message, seconds: retrySeconds });
    localize(status, message);
    status.classList.toggle("quote-warning", Boolean(failure || expired || failed));
    const expanded = new Set([...rows.querySelectorAll<HTMLDetailsElement>("details[open]")].map(node => node.dataset.size));
    rows.replaceChildren();
    const baseline = batch?.rows[0];
    for (const input of QUOTE_SIZES) {
      const quote = batch?.rows.find(row => row.input === input);
      const tr = document.createElement("tr");
      const amount = document.createElement("th"); amount.scope = "row";
      amount.textContent = config ? quoteAmount(quoteInputAmount(input, config), side === "buy" ? 6 : selection?.token.decimals ?? null, document.documentElement.lang, true) : "--";
      const output = document.createElement("td"), difference = document.createElement("td");
      output.textContent = quote?.output && selection ? quoteAmount(quote.output, side === "sell" ? 6 : selection.token.decimals, document.documentElement.lang) : "--";
      const delta = quote && baseline && !quoteExpired(quote) && !quoteExpired(baseline) ? quoteRateDifference(quote, baseline) : null;
      difference.textContent = delta === null ? "--" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}%`;
      if (delta !== null && input === QUOTE_SIZES[0]) localize(difference, "Baseline quote");
      if (delta !== null && delta <= -1) difference.className = "quote-warning";
      tr.append(amount, output, difference); rows.append(tr);
      const metaRow = document.createElement("tr"), meta = document.createElement("td"); meta.colSpan = 3; meta.className = "quote-row-meta";
      if (!quote) localize(meta, busy ? "Fetching quote..." : batch ? "Not received" : "Not requested");
      else if (quote.error) localize(meta, messages[quote.error]);
      else {
        const gas = document.createElement("p");
        localize(gas, quote.gasUsd === null ? "Gas estimate unavailable" : copy("Estimated gas: {amount} USD (extra)", { amount: quote.gasUsd.toFixed(4) }));
        const time = document.createElement("p");
        localize(time, copy("{time} UTC / {state}", { time: new Date(quote.fetchedAt).toISOString().slice(11, 19), state: copy(quoteExpired(quote) ? "Expired" : "Recent quote") }));
        const routes = document.createElement("details"), summary = document.createElement("summary");
        routes.dataset.size = String(input); routes.open = expanded.has(String(input));
        summary.textContent = [...new Set(quote.routes.map(route => sourceName(route.source)))].join(" + "); routes.append(summary);
        for (const route of quote.routes) {
          const item = document.createElement("p"), name = document.createElement("span"), pool = document.createElement("code");
          name.textContent = sourceName(route.source); pool.textContent = route.pool;
          item.append(name, pool); routes.append(item);
        }
        meta.append(gas, time, routes);
      }
      metaRow.append(meta); rows.append(metaRow);
    }
  }

  modes.forEach(mode => mode.addEventListener("click", () => {
    if (mode.dataset.quoteSide === side) return;
    side = mode.dataset.quoteSide as QuoteOptions["side"]; reset(); draw();
  }));
  quantity.addEventListener("input", () => { reset(); draw(); });
  button.addEventListener("click", async () => {
    const config = options();
    if (availability() || busy || !selection || !config || retryUntil > Date.now()) return;
    const token = selection.tokenAddress.toLowerCase();
    controller?.abort();
    const request = new AbortController(); controller = request;
    busy = true; batch = null; failure = ""; draw();
    try {
      const url = new URL("/api/arcrow/quotes", location.origin);
      url.search = new URLSearchParams({ network: "arc-mainnet", token,
        ...(config.side === "sell" ? { side: "sell", amount: config.baseAmount } : {}) }).toString();
      const response = await fetch(url, { headers: { Accept: "application/x-ndjson" },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(28_000)]), cache: "no-store", credentials: "omit", redirect: "error" });
      if (controller !== request) return;
      if (!response.ok) {
        const seconds = Number(response.headers.get("retry-after"));
        if (Number.isFinite(seconds) && seconds > 0) retryUntil = Date.now() + Math.min(seconds, 60) * 1000;
        const error = await response.json().catch(() => ({})) as { error?: string };
        const errors: Record<string, string> = { "local-busy": "Another quote is still loading.", "local-limit": "Local quote request limit reached.", "provider-limit": "Provider rate limit. Try again later." };
        throw new Error(errors[error.error ?? ""] ?? "Local quote service unavailable");
      }
      await readQuoteResponse(response, { token, ...config }, next => {
        if (controller === request && !request.signal.aborted) { batch = next; draw(); }
      });
    } catch (error) {
      if (controller !== request || request.signal.aborted) return;
      const message = error instanceof Error ? error.message : "";
      failure = ["Another quote is still loading.", "Local quote request limit reached.", "Provider rate limit. Try again later.",
        "Local quote service unavailable", "Quote could not be verified", "Incomplete quote comparison."].includes(message)
        ? message : batch ? "Incomplete quote comparison." : "Quote request timed out";
    } finally {
      if (controller === request) { controller = null; busy = false; draw(); }
    }
  });
  // Timers update expiry and retry labels only. Quotes always require a manual request.
  setInterval(() => {
    if (retryUntil) { if (retryUntil <= Date.now()) retryUntil = 0; draw(); }
    else if (batch && host.dataset.quoteExpired !== String(batch.rows.some(row => !row.error && quoteExpired(row)))) draw();
  }, 1_000);
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  return {
    select(next: Selection) {
      const nextKey = `${next.chainId}:${next.tokenAddress.toLowerCase()}:${next.token.decimals}`;
      selection = next;
      if (key !== nextKey) { key = nextKey; quantity.value = ""; reset(); }
      draw();
    },
  };
}
