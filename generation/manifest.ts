import fs from "node:fs";
import path from "node:path";
import { dataDir, rawDir, repoRoot } from "./lib/config.ts";
import { slugify } from "./fetch.ts";
import type { SpeciesRow } from "./parse.ts";

/**
 * Stage 4: emit this deck repository's manifest.json (portable card metadata:
 * bare filenames, category structure, status and photo credits) plus the
 * human-readable generation report. The app repository's sync script resolves
 * these into served URLs.
 */

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
  taxon?: {
    taxonId: number;
    iNatName: string;
    iNatCommonName: string | null;
    ancestry: string;
    familyId: number | null;
    familyName: string | null;
  };
  photos: PhotoMeta[];
}

export interface CardCredit {
  observer: string;
  license: string;
  observationUrl: string;
  observationId: number;
  placeLabel: string;
}

export interface HealthyCard {
  name: string;
  front: string;
  back: string;
  sciName: string;
  commonName: string;
  familyCommon: string | null;
  familyLatin: string | null;
  native: "native" | "non-native" | "unknown";
  rarity: string | null;
  canyons: string[];
  taxonId: number | null;
  invasive: boolean;
  credits: CardCredit[];
}

interface DeckManifest {
  id: "healthy-canyons";
  label: string;
  description: string;
  generatedAt: string;
  categories: Array<{ id: string; label: string; cards: HealthyCard[] }>;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, "-");
}

function rarityOf(row: SpeciesRow): string | null {
  if (row.kind === "plant") {
    const parts = [
      row.ranks.cnps ? `CNPS ${row.ranks.cnps}` : null,
      row.ranks.cesa && !/^none$/i.test(row.ranks.cesa) ? `CESA ${row.ranks.cesa}` : null,
      row.ranks.fesa && !/^none$/i.test(row.ranks.fesa) ? `FESA ${row.ranks.fesa}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }
  const parts = [
    row.listings.federal && row.listings.federal !== "0" ? `Federal: ${row.listings.federal}` : null,
    row.listings.state && row.listings.state !== "0" ? `State: ${row.listings.state}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function buildManifest(): {
  plants: HealthyCard[];
  animals: HealthyCard[];
  missing: Array<{ cardName: string; sciName: string; status: string }>;
} {
  const species = JSON.parse(
    fs.readFileSync(path.join(dataDir, "species.json"), "utf8"),
  ) as { plants: SpeciesRow[]; animals: SpeciesRow[] };

  const familyCacheFile = path.join(dataDir, "families.json");
  const familyNames = new Map<number, string | null>(
    fs.existsSync(familyCacheFile)
      ? Object.entries(JSON.parse(fs.readFileSync(familyCacheFile, "utf8"))).map(
          ([k, v]) => [Number(k), v as string | null] as const,
        )
      : [],
  );

  const plants: HealthyCard[] = [];
  const animals: HealthyCard[] = [];
  const missing: Array<{ cardName: string; sciName: string; status: string }> = [];

  for (const row of [...species.plants, ...species.animals]) {
    const metaFile = path.join(rawDir, slugify(row.cardName), "meta.json");
    if (!fs.existsSync(metaFile)) {
      missing.push({ cardName: row.cardName, sciName: row.sciName, status: "not fetched" });
      continue;
    }
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as FetchMeta;
    if (meta.status !== "ok" || meta.photos.length === 0) {
      missing.push({ cardName: row.cardName, sciName: row.sciName, status: meta.status });
      continue;
    }
    const fileBase = sanitizeFileName(row.cardName);
    const taxon = meta.taxon;
    const familyCommon =
      taxon && taxon.familyId !== null ? (familyNames.get(taxon.familyId) ?? null) : null;
    const card: HealthyCard = {
      name: row.cardName,
      front: `${fileBase} Front.jpg`,
      back: `${fileBase} Back.jpg`,
      sciName: taxon?.iNatName ?? row.sciName,
      commonName: row.commonName,
      familyCommon,
      familyLatin:
        row.kind === "plant" ? row.family || taxon?.familyName || null : taxon?.familyName ?? null,
      native: row.native,
      rarity: rarityOf(row),
      canyons: row.canyons,
      taxonId: taxon?.taxonId ?? null,
      invasive: row.native === "non-native",
      credits: meta.photos.map((p) => ({
        observer: p.observer,
        license: p.license,
        observationUrl: p.observationUrl,
        observationId: p.observationId,
        placeLabel: p.placeLabel,
      })),
    };
    if (row.kind === "plant") plants.push(card);
    else animals.push(card);
  }

  return { plants, animals, missing };
}

function writeDeckManifest(data: { plants: HealthyCard[]; animals: HealthyCard[]; generatedAt: string }): void {
  const manifest: DeckManifest = {
    id: "healthy-canyons",
    label: "🌿 Healthy Canyons",
    description:
      "Species recorded across San Diego canyon surveys (NFWF Healthy Canyons project): plants, birds, mammals, reptiles & amphibians and invertebrates. Card photos are CC-licensed iNaturalist observations, credited beneath each image and on the app's credits page.",
    generatedAt: data.generatedAt,
    categories: [
      { id: "plants", label: "🌿 Plants", cards: data.plants },
      { id: "animals", label: "🦎 Animals", cards: data.animals },
    ],
  };
  fs.writeFileSync(path.join(repoRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function licenseCountsOf(cards: HealthyCard[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    for (const p of card.credits) {
      counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
    }
  }
  return counts;
}

function writeReport(data: {
  plants: HealthyCard[];
  animals: HealthyCard[];
  missing: Array<{ cardName: string; sciName: string; status: string }>;
  generatedAt: string;
}): void {
  const parseStats = JSON.parse(fs.readFileSync(path.join(dataDir, "species.json"), "utf8")).stats as Record<string, number>;
  const fetchReport = fs.existsSync(path.join(dataDir, "fetch-report.json"))
    ? JSON.parse(fs.readFileSync(path.join(dataDir, "fetch-report.json"), "utf8"))
    : null;
  const renderReport = fs.existsSync(path.join(dataDir, "render-report.json"))
    ? JSON.parse(fs.readFileSync(path.join(dataDir, "render-report.json"), "utf8"))
    : null;

  const lines: string[] = [];
  lines.push(`# Healthy Canyons card generation report`);
  lines.push("");
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Stage | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Plant taxa parsed from spreadsheets | ${parseStats.plantsIncluded} |`);
  lines.push(`| Animal taxa parsed from spreadsheets | ${parseStats.animalsIncluded} |`);
  if (fetchReport) {
    lines.push(`| Resolved on iNaturalist with photos | ${fetchReport.counts.ok ?? 0} |`);
    lines.push(`| Not found on iNaturalist | ${fetchReport.counts["no-taxon"] ?? 0} |`);
    lines.push(`| Found but no usable (CC) photos | ${fetchReport.counts["no-photos"] ?? 0} |`);
  }
  if (renderReport) {
    lines.push(`| Card images rendered | ${renderReport.counts.rendered} |`);
    lines.push(`| Cards with fewer than 3 photos | ${renderReport.counts.partialPhotos} |`);
    lines.push(`| Card images skipped | ${renderReport.counts.skipped} |`);
    lines.push(`| Render errors | ${renderReport.counts.errors} |`);
  }
  lines.push(`| Cards in final deck (plants) | ${data.plants.length} |`);
  lines.push(`| Cards in final deck (animals) | ${data.animals.length} |`);
  lines.push(`| Cards in final deck (total) | ${data.plants.length + data.animals.length} |`);
  lines.push("");
  lines.push(`## Cards not generated`);
  lines.push("");
  if (data.missing.length === 0) {
    lines.push("_None — every taxon was successfully turned into a card._");
  } else {
    lines.push(`| Card | Scientific name | Reason |`);
    lines.push(`|---|---|---|`);
    for (const m of data.missing) lines.push(`| ${m.cardName} | ${m.sciName} | ${m.status} |`);
  }
  lines.push("");
  lines.push(`## Photo licenses`);
  lines.push("");
  for (const [lic, n] of licenseCountsOf([...data.plants, ...data.animals])) {
    lines.push(`- ${lic || "(none)"}: ${n} photos`);
  }
  lines.push("");

  fs.writeFileSync(path.join(dataDir, "report.md"), lines.join("\n"));
}

export function generate(): void {
  const manifest = buildManifest();
  const generatedAt = new Date().toISOString();
  writeDeckManifest({ plants: manifest.plants, animals: manifest.animals, generatedAt });
  writeReport({ plants: manifest.plants, animals: manifest.animals, missing: manifest.missing, generatedAt });
  console.log(`Manifest: ${path.join(repoRoot, "manifest.json")}`);
  console.log(`  plants:  ${manifest.plants.length}`);
  console.log(`  animals: ${manifest.animals.length}`);
  console.log(`  missing: ${manifest.missing.length} (see data/report.md)`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) generate();