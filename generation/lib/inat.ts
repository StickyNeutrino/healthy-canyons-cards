import fs from "node:fs";
import path from "node:path";
import { apiDelayMs, USER_AGENT } from "./config.ts";

/**
 * Minimal iNaturalist API client with polite rate limiting, retries and an
 * on-disk response cache so repeated generation runs don't re-hit the API.
 */

export interface InatTaxon {
  id: number;
  name: string;
  rank: string;
  rank_level: number;
  is_active: boolean;
  preferred_common_name?: string;
  ancestry?: string;
  default_photo?: { license_code: string | null; attribution: string; url: string } | null;
  ancestors?: Array<{ id: number; name: string; rank: string; preferred_common_name?: string }>;
  matched_term?: string;
  current_synonymous_taxon_ids?: number[] | null;
  observations_count?: number;
}

export interface InatPhoto {
  id: string | number;
  license_code: string | null;
  attribution: string;
  url: string;
  original_dimensions?: { width: number; height: number };
}

export interface InatObservation {
  id: number;
  uri?: string;
  photos?: InatPhoto[];
  quality_grade?: string;
  user?: { login?: string; name?: string };
  cached_votes_total?: number;
  place_ids?: number[];
}

let lastCall = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Circuit breaker shared by all clients: when iNat responds 429/5xx we pause
 * every worker for a cool-down instead of letting individual retries hammer
 * a struggling service. Cool-down grows with consecutive failures.
 */
let breakerUntil = 0;
let consecutiveFailures = 0;

function tripBreaker(retryAfterHeader: string | null): void {
  consecutiveFailures++;
  const headerSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const backoff = Number.isFinite(headerSeconds) && headerSeconds > 0
    ? headerSeconds * 1000
    : Math.min(60_000 * 2 ** (consecutiveFailures - 1), 300_000);
  breakerUntil = Math.max(breakerUntil, Date.now() + backoff);
}

function noteSuccess(): void {
  consecutiveFailures = 0;
  breakerUntil = 0;
}

/** True while the breaker is tripped (iNat unreachable/rate-limiting). */
export function isBreakerOpen(): boolean {
  return Date.now() < breakerUntil || consecutiveFailures >= 3;
}

async function rateLimit() {
  const wait = lastCall + apiDelayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const breakerWait = breakerUntil - Date.now();
  if (breakerWait > 0) await sleep(breakerWait);
}

export class InatClient {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  private cachePath(key: string): string {
    return path.join(this.cacheDir, key.replace(/[^a-z0-9._-]+/gi, "_") + ".json");
  }

  async get<T>(endpoint: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(endpoint, "https://api.inaturalist.org/v1/");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const cacheFile = this.cachePath(endpoint.replace(/\W+/g, "_") + "?" + url.searchParams.toString());
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as T;
    }
    await rateLimit();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 7; attempt++) {
      if (attempt > 0 && isBreakerOpen()) {
        // Service is down or throttling — give up fast instead of hammering.
        throw lastErr ?? new Error("iNat unavailable (circuit breaker open)");
      }
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        });
        if (res.status === 429 || res.status >= 500) {
          tripBreaker(res.headers.get("retry-after"));
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        noteSuccess();
        const json = (await res.json()) as T;
        fs.writeFileSync(cacheFile, JSON.stringify(json));
        return json;
      } catch (err) {
        lastErr = err;
        if (attempt < 6) await sleep(5000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  async autocompleteTaxon(q: string): Promise<InatTaxon[]> {
    const json = await this.get<{ results: InatTaxon[] }>("taxa/autocomplete", { q, per_page: 10 });
    return json.results;
  }

  async taxon(id: number): Promise<InatTaxon | undefined> {
    const json = await this.get<{ results: InatTaxon[] }>("taxa", { id });
    return json.results[0];
  }

  /** Full taxon detail from the bare path, which includes named ancestors. */
  async taxonDetail(id: number): Promise<InatTaxon | undefined> {
    const json = await this.get<{ results: InatTaxon[] }>(`taxa/${id}`);
    return json.results[0];
  }

  async observations(taxonId: number, params: Record<string, string | number | undefined>): Promise<InatObservation[]> {
    const json = await this.get<{ results: InatObservation[] }>("observations", {
      taxon_id: taxonId,
      photos: true,
      license: "any",
      order_by: "votes",
      per_page: 100,
      ...params,
    });
    return json.results;
  }
}

/** Resolve the original-size photo URL for an iNat photo record. */
export function photoVariants(photo: { url: string }): string[] {
  // URL forms: https://static.inaturalist.org/photos/<id>/square.jpg
  //            https://inaturalist-open-data.s3.amazonaws.com/photos/<id>/square.jpg
  const url = photo.url ?? "";
  const out: string[] = [];
  for (const size of ["original", "large", "medium"]) {
    const candidate = url.replace(/\/(square|thumb|small|medium|large|original)\./, `/${size}.`);
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}