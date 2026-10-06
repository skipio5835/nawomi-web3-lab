export function validObservationTime(value: string | null | undefined, now: number): boolean {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= 0 && time <= now;
}

export function oldestFetchTime(values: Array<number | null | undefined>, now: number): number | null {
  if (!values.length || values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > now)) return null;
  return Math.min(...values as number[]);
}

export function priceFreshness(eventAt: string | null | undefined, source: string, now: number): "unknown" | "balance" | "recent" | "old" {
  if (source === "balance") return "balance";
  if (!validObservationTime(eventAt, now)) return "unknown";
  return now - Date.parse(eventAt!) > 15 * 60_000 ? "old" : "recent";
}
