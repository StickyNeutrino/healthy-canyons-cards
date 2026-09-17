import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { decompress } from "wawoff2";
import { Resvg } from "@resvg/resvg-js";
import { repoRoot, rawDir, dataDir, outDir } from "./lib/config.ts";
import { InatClient, isBreakerOpen } from "./lib/inat.ts";
import { slugify } from "./fetch.ts";
import type { SpeciesRow } from "./parse.ts";

/**
 * Stage 3: render the generated card images. Fronts composite the downloaded
 * iNaturalist photos into the physical deck's layout, each with its photo
 * credit directly beneath it; backs render names, family, native status and
 * rarity as SVG rasterized with the app's Inter font.
 * Output: public/cards-healthy/<Name> Front.jpg / Back.jpg
 */

const BG_HEX = "#e4e3df";
const INK = "#000000";
const GRAY = "#6b6b66";

// Photo slots measured from the scanned physical deck cards.
const TOP = { left: 50, top: 48, width: 650, height: 604 };
const BOTTOM_LEFT = { left: 50, top: 702, width: 276, height: 295 };
const BOTTOM_RIGHT = { left: 375, top: 702, width: 324, height: 295 };
const RADIUS = 14;

// Back layout (text baselines), measured from the scanned backs.
const TITLE_BASELINE = 326;
const SCI_BASELINE = 382;
const FAMILY_BASELINE = 516;
const FAMILY_LATIN_BASELINE = 576;
const STATUS_BASELINE = 709;
const STATUS_DETAIL_BASELINE = 773;
const CARD_W = 750;
const CARD_H = 1050;

// Front photo credit text (rasterized with Inter via resvg, drawn under each slot).
const CREDIT_FONT_SIZE = 12;
const CREDIT_GAP = 16; // baseline gap below the photo's bottom edge

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

const licenseDisplay = (code: string): string => {
  if (!code) return "";
  if (code.toLowerCase() === "cc0") return "CC0";
  return code.toLowerCase().replace(/^cc-/, "CC ").toUpperCase();
};

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Approximate rendered width of an Inter text run, used for auto-shrink. */
function approxTextWidth(text: string, size: number, weight: number): number {
  const factor = weight >= 600 ? 0.56 : 0.5;
  return text.length * size * factor;
}

function fitSize(text: string, size: number, maxWidth: number, weight: number): number {
  const width = approxTextWidth(text, size, weight);
  return width <= maxWidth ? size : Math.max(18, Math.floor(size * (maxWidth / width)));
}

interface BackOptions {
  title: string;
  sciName: string;
  familyCommon: string | null;
  familyLatin: string | null;
  native: string;
  rarity: string | null;
}

interface FrontPhoto {
  file: string;
  observer: string;
  license: string;
}

/** Compact on-card credit: "© Observer · CC BY-NC". */
function creditText(photo: { observer: string; license: string }): string {
  const license = licenseDisplay(photo.license);
  return `© ${photo.observer}${license ? ` · ${license}` : ""}`;
}

function truncateForWidth(text: string, maxWidthPx: number, size: number): string {
  const maxChars = Math.floor(maxWidthPx / (size * 0.5));
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

/** SVG overlay with one credit line under each photo slot. */
function creditOverlaySvg(photos: FrontPhoto[]): string {
  const slots =
    photos.length >= 3 ? [TOP, BOTTOM_LEFT, BOTTOM_RIGHT] :
    photos.length === 2 ? [TOP, BOTTOM_RIGHT] :
    [TOP];
  const lines: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const text = truncateForWidth(creditText(photos[i]), slot.width, CREDIT_FONT_SIZE);
    lines.push(
      `<text x="${slot.left}" y="${slot.top + slot.height + CREDIT_GAP}" font-family="Inter" font-size="${CREDIT_FONT_SIZE}" fill="${GRAY}">${escapeXml(text)}</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">${lines.join("")}</svg>`;
}

function backSvg(o: BackOptions): string {
  const esc = escapeXml;
  const lines: string[] = [];
  lines.push(`<text x="375" y="${TITLE_BASELINE}" font-family="Inter" font-weight="700" font-size="${fitSize(o.title, 72, 640, 700)}" fill="${INK}" text-anchor="middle">${esc(o.title)}</text>`);
  lines.push(`<text x="375" y="${SCI_BASELINE}" font-family="Inter" font-style="italic" font-size="${fitSize(o.sciName, 38, 640, 400)}" fill="${INK}" text-anchor="middle">${esc(o.sciName)}</text>`);
  if (o.familyCommon) {
    lines.push(`<text x="375" y="${FAMILY_BASELINE}" font-family="Inter" font-size="${fitSize(o.familyCommon, 44, 640, 400)}" fill="${INK}" text-anchor="middle">${esc(o.familyCommon)}</text>`);
  }
  if (o.familyLatin) {
    lines.push(`<text x="375" y="${FAMILY_LATIN_BASELINE}" font-family="Inter" font-style="italic" font-size="${fitSize(o.familyLatin, 34, 640, 400)}" fill="${INK}" text-anchor="middle">${esc(o.familyLatin)}</text>`);
  }
  if (o.native) {
    lines.push(`<text x="375" y="${STATUS_BASELINE}" font-family="Inter" font-size="${fitSize(o.native, 44, 640, 400)}" fill="${INK}" text-anchor="middle">${esc(o.native)}</text>`);
  }
  if (o.rarity) {
    lines.push(`<text x="375" y="${STATUS_DETAIL_BASELINE}" font-family="Inter" font-size="${fitSize(o.rarity, 30, 640, 400)}" fill="${INK}" text-anchor="middle">${esc(o.rarity)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">
  <rect width="${CARD_W}" height="${CARD_H}" fill="${BG_HEX}"/>
  <rect x="61.5" y="61.5" width="76" height="76" fill="#ffffff" stroke="${INK}" stroke-width="7"/>
  ${lines.join("\n  ")}
</svg>`;
}

async function roundedMask(width: number, height: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function coverCrop(src: string, width: number, height: number): Promise<Buffer> {
  return sharp(src)
    .resize(width, height, { fit: "cover", position: sharp.strategy.attention })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function renderFront(photos: FrontPhoto[], fonts: string[], outFile: string): Promise<void> {
  const slots =
    photos.length >= 3 ? [TOP, BOTTOM_LEFT, BOTTOM_RIGHT] :
    photos.length === 2 ? [TOP, BOTTOM_RIGHT] :
    [TOP];
  const composites: OverlayOptions[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const photo = await coverCrop(photos[i].file, slot.width, slot.height);
    const mask = await roundedMask(slot.width, slot.height);
    const masked = await sharp(photo).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    composites.push({ input: masked, left: slot.left, top: slot.top });
  }
  if (photos.length) {
    // Rasterize the credit lines with the same Inter font as the card back.
    const resvg = new Resvg(creditOverlaySvg(photos), {
      fitTo: { mode: "width", value: CARD_W },
      font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: "Inter" },
    });
    composites.push({ input: resvg.render().asPng(), left: 0, top: 0 });
  }
  await sharp({
    create: { width: CARD_W, height: CARD_H, channels: 3, background: BG_HEX },
  })
    .composite(composites)
    .jpeg({ quality: 82, progressive: true })
    .toFile(outFile);
}

export async function renderBack(fonts: string[], options: BackOptions, outFile: string): Promise<void> {
  const resvg = new Resvg(backSvg(options), {
    fitTo: { mode: "width", value: CARD_W },
    font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: "Inter" },
  });
  await sharp(resvg.render().asPng())
    .jpeg({ quality: 90, progressive: true })
    .toFile(outFile);
}

/** Convert the app's static Inter woff2 files to ttf for resvg; cached on disk. */
export async function loadFonts(): Promise<string[]> {
  const fontDir = path.join(dataDir, "fonts");
  fs.mkdirSync(fontDir, { recursive: true });
  const sources: Array<[string, string]> = [
    ["node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2", "Inter-400.ttf"],
    ["node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2", "Inter-700.ttf"],
    ["node_modules/@fontsource/inter/files/inter-latin-400-italic.woff2", "Inter-400-italic.ttf"],
    ["node_modules/@fontsource/inter/files/inter-latin-700-italic.woff2", "Inter-700-italic.ttf"],
  ];
  const out: string[] = [];
  for (const [src, name] of sources) {
    const target = path.join(fontDir, name);
    if (!fs.existsSync(target)) {
      const woff2 = fs.readFileSync(path.join(repoRoot, src));
      fs.writeFileSync(target, Buffer.from(await decompress(woff2)));
    }
    out.push(target);
  }
  return out;
}

/** iNat family common names, cached per family id across runs. */
async function loadFamilyNames(client: InatClient, familyIds: Set<number>): Promise<Map<number, string | null>> {
  const cacheFile = path.join(dataDir, "families.json");
  const cache = new Map<number, string | null>(
    fs.existsSync(cacheFile) ? Object.entries(JSON.parse(fs.readFileSync(cacheFile, "utf8"))).map(([k, v]) => [Number(k), v as string | null]) : [],
  );
  let fetched = 0;
  for (const id of familyIds) {
    if (cache.has(id) || !id) continue;
    if (isBreakerOpen()) break; // iNat is down; enrich on a later re-render
    try {
      const t = await client.taxonDetail(id);
      cache.set(id, t?.preferred_common_name ?? null);
      fetched++;
    } catch {
      // iNat may be throttling us; skip this family (falls back to "Family"/category)
      continue;
    }
    if (fetched % 25 === 0) {
      // Persist progress so an interrupted run keeps what it learned.
      fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache), null, 2));
    }
  }
  if (fetched) fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache), null, 2));
  return cache;
}

function statusLines(row: SpeciesRow): { native: string; rarity: string | null } {
  const nativeLabel =
    row.native === "native" ? "Native" :
    row.native === "non-native" ? "Non-native (Invasive)" : "";
  let rarity: string | null = null;
  if (row.kind === "plant") {
    const parts = [
      row.ranks.cnps ? `CNPS ${row.ranks.cnps}` : null,
      row.ranks.cesa && !/^none$/i.test(row.ranks.cesa) ? `CESA ${row.ranks.cesa}` : null,
      row.ranks.fesa && !/^none$/i.test(row.ranks.fesa) ? `FESA ${row.ranks.fesa}` : null,
    ].filter(Boolean);
    rarity = parts.length ? parts.join(" · ") : null;
  } else {
    const parts = [
      row.listings.federal && row.listings.federal !== "0" ? `Federal: ${row.listings.federal}` : null,
      row.listings.state && row.listings.state !== "0" ? `State: ${row.listings.state}` : null,
    ].filter(Boolean);
    rarity = parts.length ? parts.join(" · ") : null;
  }
  return { native: nativeLabel, rarity };
}

function creditLine(photos: PhotoMeta[]): string | null {
  if (!photos.length) return null;
  return "Photos: " + photos.map((p) => `${p.observer} (${licenseDisplay(p.license)})`).join(" · ");
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, "-");
}

interface RenderReport {
  generatedAt: string;
  counts: { rendered: number; skipped: number; partialPhotos: number; errors: number };
  skipped: Array<{ cardName: string; sciName: string; reason: string }>;
}

export async function renderAll(): Promise<RenderReport> {
  const species = JSON.parse(
    fs.readFileSync(path.join(dataDir, "species.json"), "utf8"),
  ) as { plants: SpeciesRow[]; animals: SpeciesRow[] };
  const rows = [...species.plants, ...species.animals];
  fs.mkdirSync(outDir, { recursive: true });

  const fonts = await loadFonts();

  const familyIds = new Set<number>();
  const metas = new Map<string, FetchMeta>();
  for (const row of rows) {
    const metaFile = path.join(rawDir, slugify(row.cardName), "meta.json");
    if (!fs.existsSync(metaFile)) continue;
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as FetchMeta;
    metas.set(row.cardName, meta);
    if (meta.taxon?.familyId) familyIds.add(meta.taxon.familyId);
  }
  const client = new InatClient(path.join(dataDir, "api-cache"));
  const familyNames = await loadFamilyNames(client, familyIds);

  const report: RenderReport = {
    generatedAt: new Date().toISOString(),
    counts: { rendered: 0, skipped: 0, partialPhotos: 0, errors: 0 },
    skipped: [],
  };

  let done = 0;
  const started = Date.now();
  for (const row of rows) {
    const meta = metas.get(row.cardName);
    if (!meta || meta.status !== "ok" || meta.photos.length === 0) {
      report.counts.skipped++;
      report.skipped.push({ cardName: row.cardName, sciName: row.sciName, reason: meta?.status ?? "no fetched data" });
    } else {
      try {
        const slug = slugify(row.cardName);
        const base = path.join(outDir, sanitizeFileName(row.cardName));
        await renderFront(meta.photos.map((p) => ({
          file: path.join(rawDir, slug, p.file),
          observer: p.observer,
          license: p.license,
        })), fonts, `${base} Front.jpg`);

        const taxon = meta.taxon;
        const sciName = taxon?.iNatName ?? row.sciName;
        let familyLatin: string | null = null;
        let familyCommon: string | null = null;
        if (row.kind === "plant") {
          familyLatin = row.family || taxon?.familyName || null;
          familyCommon = taxon?.familyId ? (familyNames.get(taxon.familyId) ?? null) : null;
          if (familyLatin && !familyCommon) familyCommon = "Family";
        } else {
          familyLatin = taxon?.familyName ?? null;
          familyCommon = taxon?.familyId ? (familyNames.get(taxon.familyId) ?? null) : row.category || null;
        }
        const status = statusLines(row);
        await renderBack(fonts, {
          title: row.cardName,
          sciName,
          familyCommon,
          familyLatin,
          native: status.native,
          rarity: status.rarity,
        }, `${base} Back.jpg`);

        report.counts.rendered++;
        if (meta.photos.length < 3) report.counts.partialPhotos++;
      } catch (err) {
        report.counts.errors++;
        report.skipped.push({ cardName: row.cardName, sciName: row.sciName, reason: "error: " + String(err).slice(0, 160) });
      }
    }
    done++;
    if (done % 100 === 0) {
      const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);
      console.log(`  ${done}/${rows.length} processed (${elapsed} min)`);
    }
  }

  fs.writeFileSync(path.join(dataDir, "render-report.json"), JSON.stringify(report, null, 2));
  return report;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  renderAll().then((r) => {
    console.log("Render complete:", JSON.stringify(r.counts));
    if (r.counts.skipped) console.log(`  (${r.counts.skipped} skipped — see data/healthy/render-report.json)`);
  });
}