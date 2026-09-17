import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Paths are relative to THIS deck repository (decks/healthy-canyons/), which is
 * self-contained: source spreadsheets, generation scripts, data artifacts and
 * the rendered card images all live here. The app repository consumes the deck
 * via its sync script and never runs this pipeline itself.
 */

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Source spreadsheets (canyon survey exports). */
export const sourceDir = path.join(repoRoot, "source");

/** Intermediate generation data (species list, reports, caches). Committed except caches. */
export const dataDir = path.join(repoRoot, "data");
/** Raw downloaded iNat photos + per-taxon metadata. Gitignored cache. */
export const rawDir = path.join(repoRoot, "data", "raw-photos");
/** Generated card images — the canonical copy lives in this repo. */
export const outDir = path.join(repoRoot, "cards");

export const spreadsheets = {
  plants: path.join(sourceDir, "Summary_Appendix1_PLANTS_NFWF_Canyons_Updated20260803 - Copy.xlsx"),
  animals: path.join(sourceDir, "Summary_Appendix2_ANIMALS_NFWF_Canyons_Updated20260803 - Copy.xlsx"),
} as const;

/** Pixel dimensions of the generated cards; matches the scanned Canyonlands cards. */
export const cardWidth = 750;
export const cardHeight = 1050;

/** iNat API base. */
export const inatApi = "https://api.inaturalist.org/v1";

/** Polite delay between API calls (ms) and number of parallel workers. */
export const apiDelayMs = 1500;
export const fetchConcurrency = 2;

/**
 * Descriptive User-Agent per iNat's guidance (identify the app and point to
 * the project). Used for both API calls and photo downloads.
 */
export const USER_AGENT =
  "native-species-flashcards/1.0 (cards.unimpossy.com; source: github.com/StickyNeutrino/cards)";

/**
 * Photo licenses we accept. "cc0", "cc-by", "cc-by-sa" and "cc-by-nc*" are fine;
 * "nd" variants forbid the cropping we do, so they are excluded.
 */
export function licenseAllowed(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.toLowerCase();
  return c === "cc0" || (c.startsWith("cc-") && !c.includes("nd"));
}