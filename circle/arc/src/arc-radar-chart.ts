import { createChart, ColorType, CrosshairMode, LineSeries, HistogramSeries, LineStyle, type UTCTimestamp, type Time, type AutoscaleInfo } from "lightweight-charts";
import { createElement, ZoomIn, ZoomOut, Scan } from "lucide";
import { copy, localize } from "./arc-radar-i18n.js";
import { observedChartData, chartNumber, type ChartInput } from "./arc-radar-chart-data.js";

type ChartMarket = ChartInput & { historyTruncated: boolean; stale: boolean };
export function createMarketChart() {
  const host = document.getElementById("priceChart")!;
  const empty = document.getElementById("chartEmpty")!;
  const readout = document.getElementById("chartReadout")!;
  const valuationButton = document.querySelector<HTMLButtonElement>('[data-chart-mode="valuation"]')!;
  let mode: "price" | "valuation" = "price";
  let scope = "";
  let model = observedChartData({ pricePoints: [], trades: [], token: { total_supply: null, decimals: null }, periodsAsOf: 0 });
  const chart = createChart(host, {
    autoSize: true,
    layout: { attributionLogo: true, fontSize: 12 },
    timeScale: { timeVisible: true, secondsVisible: true, rightOffset: 2, minBarSpacing: 0.01, ignoreWhitespaceIndices: false },
    rightPriceScale: { minimumWidth: 72, borderVisible: false },
    crosshair: { mode: CrosshairMode.Normal },
    handleScroll: { vertTouchDrag: false },
    localization: { timeFormatter: (time: Time) => typeof time === "number" ? new Date(time * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : String(time) },
  });
  const price = chart.addSeries(LineSeries, {
    lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 2,
    priceFormat: { type: "custom", formatter: chartNumber, minMove: 1e-12 },
    priceLineVisible: false,
    autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
      const info = original();
      if (!info?.priceRange) return info;
      const { minValue, maxValue } = info.priceRange;
      const padding = Math.max((maxValue - minValue) * 0.1, Math.abs(maxValue) * 0.02);
      if (Number.isFinite(maxValue + padding)) info.priceRange = { minValue: Math.max(0, minValue - padding), maxValue: maxValue + padding };
      return info;
    },
  });
  const volume = chart.addSeries(HistogramSeries, {
    priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false,
  }, 1);
  chart.panes()[0]!.setStretchFactor(3);
  chart.panes()[1]!.setStretchFactor(1);

  function caption(time?: number) {
    const sample = time === undefined ? [...model.samples].reverse().find(sample => sample[mode] !== undefined) : model.samples.find(sample => sample.time === time);
    localize(readout, sample ? copy("{time} UTC | {metric}: {value} USDC | Observed volume: {volume} USDC", {
      time: new Date(sample.time * 1000).toISOString().replace("T", " ").slice(0, 19),
      metric: copy(mode === "price" ? "Price" : "Supply value"),
      value: sample[mode] === undefined ? "--" : chartNumber(sample[mode]!),
      volume: sample.volume === undefined ? "--" : chartNumber(sample.volume),
    }) : "No observed chart data.");
  }
  function draw(reset = false) {
    const range = reset ? null : chart.timeScale().getVisibleRange();
    const values = model.samples.flatMap(sample => sample[mode] === undefined ? [] : [sample[mode]!]);
    const minMove = values.length ? Math.max(Number.MIN_VALUE, 10 ** (Math.floor(Math.log10(Math.min(...values))) - 4)) : 1e-12;
    price.applyOptions({ priceFormat: { type: "custom", formatter: chartNumber, minMove } });
    price.setData(model.samples.map(sample => sample[mode] === undefined ? { time: sample.time as UTCTimestamp } : { time: sample.time as UTCTimestamp, value: sample[mode]! }));
    volume.setData(model.samples.map(sample => sample.volume === undefined ? { time: sample.time as UTCTimestamp } : { time: sample.time as UTCTimestamp, value: sample.volume }));
    document.querySelectorAll<HTMLButtonElement>("[data-chart-mode]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.chartMode === mode)));
    valuationButton.disabled = model.supply === null;
    const hasPrices = model.samples.some(sample => sample.price !== undefined);
    empty.classList.toggle("hidden", hasPrices);
    localize(empty, "No observed chart data.");
    for (const id of ["chartZoomIn", "chartZoomOut", "chartFit"]) (document.getElementById(id) as HTMLButtonElement).disabled = !model.samples.length;
    if (range && model.samples.length) chart.timeScale().setVisibleRange(range);
    else chart.timeScale().fitContent();
    localize(document.getElementById("chartSupplyNote")!, model.supply === null ? "Total supply unavailable; valuation view disabled."
      : "Valuation uses the latest total supply for every point, not historical circulating market cap.");
    caption();
  }
  function appearance() {
    const style = getComputedStyle(host);
    const color = (key: string) => style.getPropertyValue(key).trim();
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: color("--surface") }, textColor: color("--muted"), panes: { separatorColor: color("--border") } },
      grid: { vertLines: { color: color("--border-soft") }, horzLines: { color: color("--border-soft") } },
      localization: { locale: document.documentElement.lang || "en" },
    });
    price.applyOptions({ color: color("--chart-line") });
    volume.applyOptions({ color: color("--muted") });
    caption();
  }
  const observer = new MutationObserver(appearance);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "lang"] });
  appearance();
  chart.subscribeCrosshairMove(event => caption(typeof event.time === "number" ? event.time : undefined));
  document.querySelectorAll<HTMLButtonElement>("[data-chart-mode]").forEach(button => button.addEventListener("click", () => {
    if (button.dataset.chartMode === "valuation" && model.supply === null) return;
    mode = button.dataset.chartMode === "valuation" ? "valuation" : "price";
    draw();
  }));
  for (const [id, icon, factor] of [["chartZoomIn", ZoomIn, 0.5], ["chartZoomOut", ZoomOut, 2], ["chartFit", Scan, 0]] as const) {
    const button = document.getElementById(id)!;
    button.append(createElement(icon, { width: 18, height: 18, "aria-hidden": "true" }));
    button.addEventListener("click", () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!factor || !range) { chart.timeScale().fitContent(); return; }
      const center = (range.from + range.to) / 2;
      const width = Math.max(2, Math.min(model.samples.length + 20, (range.to - range.from) * factor));
      chart.timeScale().setVisibleLogicalRange({ from: center - width / 2, to: center + width / 2 });
    });
  }
  return {
    render(market: ChartMarket, pool: string) {
      model = observedChartData(market);
      if (mode === "valuation" && model.supply === null) mode = "price";
      price.applyOptions({ lineStyle: market.historyTruncated ? LineStyle.Dotted : LineStyle.Solid });
      localize(document.getElementById("chartVolumeLabel")!, copy("Observed volume · USDC / {seconds}s", { seconds: model.interval }));
      localize(document.getElementById("priceWindow")!, copy("{count} price observations | {state} | {seconds}s buckets, up to 24h of fetched history. Gaps are unknown, not zero activity.", {
        count: model.priceCount, seconds: model.interval, state: copy("{state}{partial}", { state: copy(market.stale ? "Cached" : "Fetched"), partial: copy(market.historyTruncated ? " · Partial history" : "") }),
      }));
      draw(pool !== scope);
      scope = pool;
    },
    destroy() { observer.disconnect(); chart.remove(); },
  };
}
