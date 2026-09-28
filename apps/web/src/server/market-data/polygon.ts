import type { MarketBar } from "@/lib/market-data";
import { MarketDataError, type MarketDataProvider } from "./provider";
import {
  array,
  boundedSignal,
  credentials,
  MAX_BARS,
  MAX_PAGES,
  number,
  readJson,
  record,
  result,
  validateBars,
} from "./http";

const BASE = "https://api.polygon.io";
const headers = (key: string) => ({ Authorization: `Bearer ${credentials(key).apiKey!}` });
const SPAN = {
  "1m": [1, "minute"],
  "5m": [5, "minute"],
  "15m": [15, "minute"],
  "1h": [1, "hour"],
  "1d": [1, "day"],
} as const;

/** Polygon.io stock aggregates. Unadjusted so candles line up with recorded fills. */
export const polygon: MarketDataProvider = {
  id: "polygon",
  name: "Polygon.io",
  environmentKey: "POLYGON_API_KEY",
  async test(key) {
    await readJson(`${BASE}/v2/aggs/ticker/AAPL/prev?adjusted=false`, headers(key), undefined, {
      cache: false,
    });
  },
  async history(request, key) {
    if (!/^[A-Z][A-Z0-9.]{0,20}$/.test(request.symbol))
      throw new MarketDataError("Use the Polygon stock ticker, e.g. AAPL or BRK.B.");
    const [multiplier, timespan] = SPAN[request.resolution];
    const query = new URLSearchParams({ adjusted: "false", sort: "asc", limit: "50000" });
    let url: string | null =
      `${BASE}/v2/aggs/ticker/${encodeURIComponent(request.symbol)}/range/${multiplier}/${timespan}` +
      `/${Math.floor(request.from)}/${Math.ceil(request.to)}?${query}`;
    const bars: MarketBar[] = [];
    const seen = new Set<string>();
    const signal = boundedSignal(request.signal);
    for (let page = 0; url && page < MAX_PAGES && bars.length < MAX_BARS; page++) {
      seen.add(url);
      const body = record(await readJson(url, headers(key), signal));
      if (body.status === "ERROR" || body.status === "NOT_AUTHORIZED")
        throw new MarketDataError(
          typeof body.error === "string" ? `Polygon: ${body.error}` : "Polygon rejected the request.",
        );
      if (body.ticker !== undefined && body.ticker !== request.symbol)
        throw new MarketDataError("Polygon returned a different symbol.");
      bars.push(
        ...validateBars(
          array(body.results ?? []).map((item) => {
            const row = record(item);
            return {
              time: number(row.t),
              open: number(row.o),
              high: number(row.h),
              low: number(row.l),
              close: number(row.c),
              volume: number(row.v),
            };
          }),
        ),
      );
      const next = typeof body.next_url === "string" ? body.next_url : null;
      if (next && (!next.startsWith(`${BASE}/`) || seen.has(next)))
        throw new MarketDataError("Polygon returned an invalid pagination link.");
      url = next;
    }
    return result(
      this.name,
      request,
      bars,
      url !== null,
      [
        "Polygon.io stock aggregates, unadjusted prices, consolidated tape including extended hours. Recent data may be delayed on lower-tier plans.",
      ],
      "USD",
    );
  },
};
