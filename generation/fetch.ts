import fs from "node:fs";
import path from "node:path";
import { rawDir, dataDir, fetchConcurrency, licenseAllowed, USER_AGENT } from "./lib/config.ts";
import { InatClient, photoVariants, type InatObservation, type InatTaxon } from "./lib/inat.ts";
import type { SpeciesRow } from "./parse.ts";

/**
 * Stage 2: resolve every species on iNaturalist and download top-voted
 * CC-licensed photos, preferring observations in San Diego County, then
 * California, then worldwide. Writes one directory per card under rawDir
 * containing the photos and a meta.json recording provenance. Safe to re-run:
 * taxa with an existing meta.json are skipped unless --force is passed.
 */

interface TaxonInfo {
  taxonId: number;
  iNatName: string;
  iNatCommonName: string | null;
  ancestry: string;
  familyId: number | null;
  familyName: string | null;
}

interface PhotoMeta {
  file: string;
  license: string;
  attribution: string;
  observer: string;
  observationUrl: string;
  observationId: number;
  qualityGrade: string;
  votes: number;
  placeLabel: string;
}

interface FetchMeta {
  status: "ok" | "no-taxon" | "no-photos";
  queryName: string;
  cardName: string;
  taxon?: TaxonInfo;
  photos: PhotoMeta[];
  note?: string;
}

interface PhotoCandidate {
  photo: NonNullable<InatObservation["photos"]>[number];
  observation: InatObservation;
  placeLabel: string;
}

const client = new InatClient(path.join(dataDir, "api-cache"));
const force = process.argv.includes("--force");

let sanDiegoPlaceId: number | undefined;
let californiaPlaceId: number | undefined;

export async function resolvePlaceIds(): Promise<void> {
  const cacheFile = path.join(dataDir, "places.json");
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { sanDiego?: number; california?: number };
    sanDiegoPlaceId = cached.sanDiego;
    californiaPlaceId = cached.california;
    return;
  }
  // iNat place ids are stable: 829 is San Diego County, CA ("San Diego",
  // admin_level 20) and 14 is the state of California. Verify both via the API
  // and fall back to lookups if the API disagrees.
  const verify = async (id: number, expectedName: string): Promise<number | undefined> => {
    const json = await client.get<{ results: Array<{ id: number; name: string; admin_level: number }> }>(`places/${id}`);
    const place = json.results[0];
    return place && place.name.toLowerCase() === expectedName.toLowerCase() ? place.id : undefined;
  };
  sanDiegoPlaceId = (await verify(829, "San Diego")) ?? (await resolvePlaceByName("San Diego", 20));
  californiaPlaceId = (await verify(14, "California")) ?? (await resolvePlaceByName("California", 10));
  fs.writeFileSync(cacheFile, JSON.stringify({ sanDiego: sanDiegoPlaceId, california: californiaPlaceId }, null, 2));
  console.log(`Place ids: San Diego County=${sanDiegoPlaceId} California=${californiaPlaceId}`);
}

async function resolvePlaceByName(q: string, adminLevel: number): Promise<number | undefined> {
  const json = await client.get<{ results: Array<{ id: number; name: string; admin_level: number }> }>("places/autocomplete", { q });
  const matches = json.results.filter((p) => p.admin_level === adminLevel);
  return matches.find((p) => p.name.toLowerCase() === q.toLowerCase())?.id ?? matches[0]?.id;
}

/** Pick the best active taxon for a scientific name query. */
export function chooseTaxon(results: InatTaxon[], query: string): InatTaxon | null {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  const words = q.split(" ");
  const active = results.filter((t) => t.is_active);
  // "exact" includes iNat's synonym matches: querying an inactive name returns
  // the active replacement with matched_term set to the queried name.
  const exact = active.filter(
    (t) => t.name.toLowerCase() === q || (t.matched_term ?? "").toLowerCase() === q,
  );
  if (exact.length) {
    // Binomial queries prefer species-rank matches (over e.g. "complexes");
    // infraspecific queries (4+ words) match their exact infraspecific taxon.
    const desiredLevel = words.length > 2 ? 5 : 10;
    exact.sort((a, b) =>
      Math.abs((a.rank_level ?? 0) - desiredLevel) - Math.abs((b.rank_level ?? 0) - desiredLevel) ||
      (b.observations_count ?? 0) - (a.observations_count ?? 0));
    return exact[0];
  }
  // Synonym resolution: iNat returns the active replacement (e.g. Dendroica → Setophaga).
  const synonymMatches = active.filter((t) => {
    const parts = t.name.toLowerCase().split(" ");
    return parts[0] === words[0] && parts[1] === words[1];
  });
  if (synonymMatches.length) {
    synonymMatches.sort((a, b) =>
      Math.abs((a.rank_level ?? 0) - 10) - Math.abs((b.rank_level ?? 0) - 10) ||
      (b.observations_count ?? 0) - (a.observations_count ?? 0));
    return synonymMatches[0];
  }
  return null;
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function resolveTaxon(client: InatClient, query: string): Promise<TaxonInfo | null> {
  const attempts = [query];
  const words = query.trim().split(/\s+/);
  if (words.length > 2) attempts.push(words.slice(0, 2).join(" ")); // fall back to the species
  for (const attempt of attempts) {
    const results = await client.autocompleteTaxon(attempt);
    const chosen = chooseTaxon(results, attempt);
    if (chosen) {
      // Detail from the bare path adds named ancestors, which give the family.
      const detail = await client.taxonDetail(chosen.id);
      const family = (detail?.ancestors ?? []).find((a) => a.rank === "family") ?? null;
      return {
        taxonId: chosen.id,
        iNatName: detail?.name ?? chosen.name,
        iNatCommonName: detail?.preferred_common_name ?? chosen.preferred_common_name ?? null,
        ancestry: chosen.ancestry ?? "",
        familyId: family?.id ?? null,
        familyName: family?.name ?? null,
      };
    }
  }
  return null;
}

interface Attempt {
  params: Record<string, string | number | undefined>;
  label: string;
}

function photoAttempts(): Attempt[] {
  const attempts: Attempt[] = [];
  for (const grade of ["research", "casual"] as const) {
    if (sanDiegoPlaceId !== undefined) attempts.push({ params: { place_id: sanDiegoPlaceId, quality_grade: grade }, label: "San Diego County" });
    if (californiaPlaceId !== undefined) attempts.push({ params: { place_id: californiaPlaceId, quality_grade: grade }, label: "California" });
    attempts.push({ params: { quality_grade: grade }, label: "worldwide" });
  }
  return attempts;
}

async function collectPhotos(client: InatClient, taxonId: number): Promise<PhotoCandidate[]> {
  const candidates: PhotoCandidate[] = [];
  const seen = new Set<string>();
  for (const attempt of photoAttempts()) {
    if (candidates.length >= 12) break;
    const observations = await client.observations(taxonId, attempt.params);
    for (const obs of observations) {
      for (const photo of obs.photos ?? []) {
        if (!licenseAllowed(photo.license_code)) continue;
        const key = String(photo.id);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ photo, observation: obs, placeLabel: attempt.label });
      }
    }
  }
  return candidates;
}

/** Take up to `max` photos from distinct observations, preferring distinct observers. */
export function pickPhotos(candidates: PhotoCandidate[], max: number): PhotoCandidate[] {
  const picked: PhotoCandidate[] = [];
  const usedObs = new Set<number>();
  const usedObservers = new Set<string>();
  const remaining = [...candidates];
  while (picked.length < max && remaining.length) {
    // Prefer a candidate from a new observation and a new observer; fall back
    // to a new observation, then to whatever remains.
    let idx = remaining.findIndex((c) => !usedObs.has(c.observation.id) && !usedObservers.has(observerName(c)));
    if (idx === -1) idx = remaining.findIndex((c) => !usedObs.has(c.observation.id));
    if (idx === -1) idx = 0;
    const [chosen] = remaining.splice(idx, 1);
    picked.push(chosen);
    usedObs.add(chosen.observation.id);
    usedObservers.add(observerName(chosen));
  }
  return picked;
}

function observerName(c: PhotoCandidate): string {
  return c.observation.user?.name || c.observation.user?.login || "unknown";
}

async function downloadPhoto(urls: string[], outFile: string): Promise<boolean> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5000) continue;
      fs.writeFileSync(outFile, buf);
      return true;
    } catch {
      // try the next variant
    }
  }
  return false;
}

export async function fetchTaxon(client: InatClient, row: SpeciesRow): Promise<FetchMeta> {
  const dir = path.join(rawDir, slugify(row.cardName));
  const metaFile = path.join(dir, "meta.json");
  if (!force && fs.existsSync(metaFile)) {
    return JSON.parse(fs.readFileSync(metaFile, "utf8")) as FetchMeta;
  }
  fs.mkdirSync(dir, { recursive: true });

  const resolution = await resolveTaxon(client, row.sciName);
  if (!resolution) {
    const meta: FetchMeta = { status: "no-taxon", queryName: row.sciName, cardName: row.cardName, photos: [] };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    return meta;
  }

  const candidates = await collectPhotos(client, resolution.taxonId);
  const picked = pickPhotos(candidates, 3);
  const photos: PhotoMeta[] = [];
  for (let i = 0; i < picked.length; i++) {
    const { photo, observation, placeLabel } = picked[i];
    const saved = await downloadPhoto(photoVariants(photo), path.join(dir, `${i}.jpg`));
    if (!saved) continue;
    photos.push({
      file: `${i}.jpg`,
      license: photo.license_code ?? "",
      attribution: photo.attribution,
      observer: observerName(picked[i]),
      observationUrl: observation.uri || `https://www.inaturalist.org/observations/${observation.id}`,
      observationId: observation.id,
      qualityGrade: observation.quality_grade ?? "",
      votes: observation.cached_votes_total ?? 0,
      placeLabel,
    });
  }

  const meta: FetchMeta = {
    status: photos.length ? "ok" : "no-photos",
    queryName: row.sciName,
    cardName: row.cardName,
    taxon: resolution,
    photos,
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return meta;
}

export async function runFetch(): Promise<void> {
  const species = JSON.parse(
    fs.readFileSync(path.join(dataDir, "species.json"), "utf8"),
  ) as { plants: SpeciesRow[]; animals: SpeciesRow[] };
  const rows = [...species.plants, ...species.animals];
  await resolvePlaceIds();

  const client = new InatClient(path.join(dataDir, "api-cache"));
  const counts: Record<string, number> = { ok: 0, "no-taxon": 0, "no-photos": 0, skipped: 0 };
  const failures: Array<{ cardName: string; sciName: string; status: string }> = [];
  let done = 0;
  const started = Date.now();

  async function worker(queue: SpeciesRow[]): Promise<void> {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        const meta = await fetchTaxon(client, row);
        counts[meta.status]++;
        if (meta.status !== "ok") failures.push({ cardName: row.cardName, sciName: row.sciName, status: meta.status });
      } catch (err) {
        counts["error"] = (counts["error"] ?? 0) + 1;
        failures.push({ cardName: row.cardName, sciName: row.sciName, status: "error: " + String(err).slice(0, 120) });
      }
      done++;
      if (done % 25 === 0) {
        const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);
        console.log(`  ${done}/${rows.length} (${elapsed} min) ok=${counts.ok} no-taxon=${counts["no-taxon"]} no-photos=${counts["no-photos"]}`);
      }
    }
  }

  const queue = [...rows];
  await Promise.all(Array.from({ length: fetchConcurrency }, () => worker(queue)));

  const report = {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    counts,
    failures,
  };
  fs.writeFileSync(path.join(dataDir, "fetch-report.json"), JSON.stringify(report, null, 2));
  console.log(`Fetch complete: ${JSON.stringify(counts)}`);
  console.log(`Report: ${path.join(dataDir, "fetch-report.json")}`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) runFetch();