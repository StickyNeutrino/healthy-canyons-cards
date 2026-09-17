import fs from "node:fs";
import path from "node:path";
import xlsxDefault from "xlsx";
const XLSX = xlsxDefault as typeof import("xlsx");
import { dataDir, spreadsheets } from "./lib/config.ts";

/**
 * Stage 1: parse the Healthy Canyons spreadsheets into a normalized master
 * species list. Writes data/healthy/species.json.
 */

export type NativeStatus = "native" | "non-native" | "unknown";

export interface PlantTaxon {
  kind: "plant";
  cardName: string;
  sciName: string;
  genus: string;
  species: string;
  infraRank: string;
  infraName: string;
  family: string;
  commonName: string;
  native: NativeStatus;
  ranks: { cnps?: string; grank?: string; srank?: string; cesa?: string; fesa?: string };
  canyons: string[];
}

export interface AnimalTaxon {
  kind: "animal";
  cardName: string;
  sciName: string;
  commonName: string;
  group: string; // Invertebrates | Birds | Mammals | Reptiles & Amphibians
  category: string;
  native: NativeStatus;
  listings: { federal?: string; state?: string };
  canyons: string[];
  excluded?: string;
}

export type SpeciesRow = PlantTaxon | AnimalTaxon;

export interface SpeciesData {
  generatedAt: string;
  plants: PlantTaxon[];
  animals: AnimalTaxon[];
  excluded: Array<{ sciName: string; kind: string; reason: string; commonName?: string }>;
  stats: Record<string, number | string[]>;
}

const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const normSci = (s: string): string => clean(s).toLowerCase();

/**
 * Plant sheets have per-sheet column drift: most sheets start the taxonomy at
 * column C (Family), but the Gonzales sheet carries two extra marker columns.
 * Anchor on the Family cell (ends in -aceae) and read outward from there.
 */
function parsePlantRow(cells: string[]): {
  family: string; genus: string; species: string; infraRank: string; infraName: string;
  commonName: string; native: string; cnps: string; grank: string; srank: string; cesa: string; fesa: string;
} | null {
  const famIdx = cells.findIndex((c, i) => i >= 2 && i <= 6 && /^[A-Za-z]+aceae$/i.test(c));
  if (famIdx === -1) return null;
  const family = cells[famIdx];
  const genus = cells[famIdx + 1] ?? "";
  const species = cells[famIdx + 2] ?? "";
  let idx = famIdx + 3;
  let infraRank = "";
  let infraName = "";
  const afterSpecies = (cells[idx] ?? "").trim();
  if (/^(ssp|subsp|var|f)\.?$/i.test(afterSpecies)) {
    infraRank = afterSpecies.endsWith(".") ? afterSpecies : afterSpecies + ".";
    infraName = (cells[idx + 1] ?? "").trim();
    idx += 2;
  }
  let commonName = "";
  let native = "";
  let cnps = "", grank = "", srank = "", cesa = "", fesa = "";
  const rankFields = [cnps, grank, srank, cesa, fesa];
  void rankFields;
  const rest = cells.slice(idx);
  const values = rest.map((c) => c.trim()).filter((v) => v !== "");
  let vi = 0;
  if (values[vi] && !/^[01]$/.test(values[vi])) commonName = values[vi++];
  if (values[vi] && /^[01]$/.test(values[vi])) native = values[vi++];
  cnps = values[vi++] ?? "";
  grank = values[vi++] ?? "";
  srank = values[vi++] ?? "";
  cesa = values[vi++] ?? "";
  fesa = values[vi++] ?? "";
  return { family, genus, species, infraRank, infraName, commonName, native, cnps, grank, srank, cesa, fesa };
}

/** Taxa whose records are not resolvable to a specific named taxon. */
export function exclusionReason(kind: "plant" | "animal", sciName: string, species: string): string | null {
  if (!sciName) return "no scientific name";
  if (/#\d/.test(sciName)) return "placeholder ID";
  if (/\b(cf|aff)\.\s*\S/.test(sciName) || /\bcf\.\s*$/.test(sciName)) return "uncertain identification";
  if (/\b(sp|spp)\.?\s*\.?\s*(\d+)?$/i.test(sciName) || /\bsp\s+\d/i.test(sciName)) return "genus only";
  if (/\bund\.\s*\S+$/i.test(sciName) || /\bund\.\s*$/.test(sciName)) return "unidentified specimen";
  if (kind === "plant" && !species) return "genus only";
  return null;
}

function mergeNative(values: NativeStatus[]): NativeStatus {
  if (values.includes("non-native")) return "non-native";
  if (values.includes("native")) return "native";
  return "unknown";
}

/** Rough category → group inference for KEY-sheet taxa that never appear on a canyon sheet. */
const CATEGORY_GROUP: Array<[RegExp, string]> = [
  [/arachnid|opiliones|harvestmen/i, "Invertebrates"],
  [/plovers/i, "Birds"],
  [/rodents|carnivores/i, "Mammals"],
  [/warbler|sparrow|hawk|eagle|finch|wren|swallow|woodpecker|hummingbird|jay|crow|raven|thrush|gull|owl|vireo|bunting|grosbeak|oriole|blackbird|flycatcher|dove|pigeon|quail|duck|goose|loon|grebe|cormorant|heron|egret|bittern|vulture|raven|jay|titmouse|chickadee|kinglet|gnatcatcher|starling|pigeons|swifts|larks|nightjars|swallows|titmice|kingfisher|phoebe|pewee|wood-pewee|thrashers|waxwings|starlings|pipits|tanagers|warblers|meadowlark|grackle|cowbird|crossbill|siskin|goldfinch|sapsucker|flicker|kestrel|falcon|merlin|osprey|harrier|nuthatch|creeper|thrush|bluebird|robin|catbird|mockingbird|shrike|lark|sparrows|buntings|finches|crossbill/i, "Birds"],
  [/lizard|snake|rattlesnake|boa|frog|toad|salamander|turtle|tortoise/i, "Reptiles & Amphibians"],
  [/bat\b|bats|mouse|mice|rats?|woodrat|vole|kangaroo rat|pocket mouse|gopher|squirrel|chipmunk|skunk|fox|opossum|deer|rabbit|hare|cottontail|jackrabbit|puma|lion|bobcat|lynx|raccoon|weasel|skunks|shrew/i, "Mammals"],
  [/spider|beetle|bee\b|bees|ant\b|ants|wasp|butterfly|moth|fly\b|flies|cricket|grasshopper|snail|slug|worm|scorpion|mite|lacewing|bug\b|bugs|weevil|cicada|hopper|aphid/i, "Invertebrates"],
];

function inferGroup(category: string): string {
  for (const [re, group] of CATEGORY_GROUP) {
    if (re.test(category)) return group;
  }
  return "";
}

function parsePlants(): {
  taxa: Map<string, PlantTaxon>;
  rowsRead: number;
  genusOnly: number;
  malformed: number;
  excludedRows: Array<{ sciName: string; reason: string; commonName?: string }>;
} {
  const wb = XLSX.readFile(spreadsheets.plants);
  const taxa = new Map<string, PlantTaxon>();
  let rowsRead = 0;
  let genusOnly = 0;
  let malformed = 0;
  const excludedRows: Array<{ sciName: string; reason: string; commonName?: string }> = [];
  for (const sheetName of wb.SheetNames) {
    const rows: string[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    for (const row of rows.slice(1)) {
      const cells = row.map((c) => clean(c));
      const parsed = parsePlantRow(cells);
      if (!parsed) continue; // header, blank, or unrecognizable row
      const { family, genus, species, infraRank, infraName, commonName, native, cnps, grank, srank, cesa, fesa } = parsed;
      if (!genus || normSci(genus) === "genus") continue;
      const sci = [genus, species, infraRank && infraName ? `${infraRank} ${infraName}` : ""].filter(Boolean).join(" ");
      if (!species && !infraName) { genusOnly++; continue; } // genus-only row
      const reason = exclusionReason("plant", sci, species);
      if (reason) {
        excludedRows.push({ sciName: sci, reason, commonName: commonName || undefined });
        continue;
      }
      rowsRead++;
      const key = normSci(sci);
      const t: PlantTaxon = taxa.get(key) ?? {
        kind: "plant", cardName: "", sciName: sci, genus, species, infraRank: infraRank || "",
        infraName: infraName || "", family: family || "", commonName: "", native: "unknown",
        ranks: {}, canyons: [],
      };
      if (!t.commonName && commonName) t.commonName = commonName;
      if (!t.family && family) t.family = family;
      t.native = mergeNative([t.native, native === "1" ? "native" : native === "0" ? "non-native" : "unknown"]);
      t.ranks = {
        cnps: t.ranks.cnps || cnps || undefined,
        grank: t.ranks.grank || grank || undefined,
        srank: t.ranks.srank || srank || undefined,
        cesa: t.ranks.cesa || (cesa && cesa !== "None" ? cesa : undefined),
        fesa: t.ranks.fesa || (fesa && fesa !== "None" ? fesa : undefined),
      };
      const canyonName = clean(cells[0]) || sheetName;
      if (!t.canyons.includes(canyonName)) t.canyons.push(canyonName);
      taxa.set(key, t);
    }
  }
  return { taxa, rowsRead, genusOnly, malformed, excludedRows };
}

const GROUP_FIX: Record<string, string> = {
  "INVERTEBRATES": "Invertebrates",
  "BIRDS": "Birds",
  "MAMMALS": "Mammals",
  "REPTILES & AMPHIBIANS": "Reptiles & Amphibians",
  "RETILES & AMPHIBIANS": "Reptiles & Amphibians",
  "REPTILES & AMPHIBIIANS": "Reptiles & Amphibians",
};

function parseAnimals(): { taxa: Map<string, AnimalTaxon>; rowsRead: number } {
  const wb = XLSX.readFile(spreadsheets.animals);
  const taxa = new Map<string, AnimalTaxon>();
  let rowsRead = 0;
  for (const sheetName of wb.SheetNames) {
    const isKey = /key/i.test(sheetName);
    const rows: string[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    for (const row of rows.slice(1)) {
      const cells = row.map((c) => clean(c));
      // KEY sheet:    [0]Category, [1]Common, [2]Sci, [3]Native, [4]Federal, [5]State, [6]Notes
      // Canyon sheet: [0]Canyon,   [1]Group,  [2]Category, [3]Common, [4]Sci, [5]Status, [6]Federal, [7]State
      const category = isKey ? cells[0] : cells[2];
      const common = isKey ? cells[1] : cells[3];
      const sci = isKey ? cells[2] : cells[4];
      const status = isKey ? cells[3] : cells[5];
      const federal = isKey ? cells[4] : cells[6];
      const state = isKey ? cells[5] : cells[7];
      const canyon = isKey ? "" : cells[0];
      const group = isKey ? "" : cells[1];

      if (!sci || !common) continue;
      if (/^(common name|scientific name|status|category)$/i.test(sci) || /denotes|no data/i.test(sci + common)) continue;

      rowsRead++;
      const reason = exclusionReason("animal", sci, "x");
      const key = normSci(sci);
      if (reason) {
        // Excluded taxa are keyed by sci+common so distinct placeholder IDs
        // (e.g. "Agyneta" #1 vs #2) don't get merged away.
        const phKey = key + "|" + normSci(common);
        const ph = taxa.get(phKey) ?? {
          kind: "animal" as const, sciName: sci, commonName: common,
          group: GROUP_FIX[group] || inferGroup(category || ""), category: category || "",
          native: "unknown" as NativeStatus, listings: {}, canyons: [] as string[],
          cardName: "", excluded: reason,
        };
        if (!ph.category && category) ph.category = category;
        if (group && GROUP_FIX[group]) ph.group = GROUP_FIX[group];
        if (federal && federal !== "0" && federal !== "None" && !ph.listings.federal) ph.listings.federal = federal;
        if (state && state !== "0" && state !== "None" && !ph.listings.state) ph.listings.state = state;
        if (canyon && !ph.canyons.includes(canyon)) ph.canyons.push(canyon);
        taxa.set(phKey, ph);
        continue;
      }
      const t: AnimalTaxon = taxa.get(key) ?? {
        kind: "animal", sciName: sci, commonName: "", group: "", category: "",
        native: "unknown", listings: {}, canyons: [], cardName: "",
      };
      if (!t.commonName || isKey) t.commonName = common;
      if (!t.category && category) t.category = category;
      if (group && GROUP_FIX[group]) {
        t.group = GROUP_FIX[group];
      } else if (!t.group && category) {
        t.group = inferGroup(category);
      }
      if (federal && federal !== "0" && federal !== "None" && !t.listings.federal) t.listings.federal = federal;
      if (state && state !== "0" && state !== "None" && !t.listings.state) t.listings.state = state;
      if (canyon && !t.canyons.includes(canyon)) t.canyons.push(canyon);
      t.native = mergeNative([
        t.native,
        /^non-?native$/i.test(status) ? "non-native" : /^native\b/i.test(status) ? "native" : "unknown",
      ]);
      taxa.set(key, t);
    }
  }
  return { taxa, rowsRead };
}

/** Detect common-name collisions within the deck and disambiguate with the sci name. */
export function assignCardNames<T extends { sciName: string; commonName: string; cardName: string }>(rows: T[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = normSci(row.commonName || row.sciName);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const used = new Set<string>();
  for (const row of rows) {
    const base = row.commonName || row.sciName;
    let name = (seen.get(normSci(base)) ?? 0) > 1 ? `${base} (${row.sciName})` : base;
    let unique = name;
    let n = 2;
    while (used.has(normSci(unique))) unique = `${name} ${n++}`;
    used.add(normSci(unique));
    row.cardName = unique;
  }
}

export function parse(): SpeciesData {
  const plants = parsePlants();
  const animals = parseAnimals();

  const plantRows = [...plants.taxa.values()];
  const animalRowsIncluded = [...animals.taxa.values()].filter((t) => !t.excluded);
  const animalsExcluded = [...animals.taxa.values()].filter((t) => t.excluded);

  assignCardNames(plantRows);
  assignCardNames(animalRowsIncluded);

  const excluded: Array<{ sciName: string; kind: string; reason: string; commonName?: string }> = [
    ...plants.excludedRows.map((e) => ({ sciName: e.sciName, kind: "plant", reason: e.reason, commonName: e.commonName })),
    ...animalsExcluded.map((t) => ({ sciName: t.sciName, kind: "animal", reason: t.excluded!, commonName: t.commonName })),
  ];
  const data: SpeciesData = {
    generatedAt: new Date().toISOString(),
    plants: plantRows,
    animals: animalRowsIncluded,
    excluded,
    stats: {
      plantRowsRead: plants.rowsRead,
      animalRowsRead: animals.rowsRead,
      plantsIncluded: plantRows.length,
      plantsGenusOnlySkipped: plants.genusOnly,
      plantsExcludedRows: plants.excludedRows.length,
      animalsIncluded: animalRowsIncluded.length,
      animalsExcluded: animalsExcluded.length,
    },
  };

  fs.mkdirSync(dataDir, { recursive: true });
  const outFile = path.join(dataDir, "species.json");
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outFile}`);
  console.log(`  plants included:  ${plantRows.length}`);
  console.log(`  animals included: ${animalRowsIncluded.length}`);
  console.log(`  plants excluded:  ${plants.excludedRows.length}`);
  console.log(`  animals excluded: ${animalsExcluded.length}`);
  return data;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) parse();