import { parse } from "./parse.ts";
import { runFetch } from "./fetch.ts";
import { renderAll } from "./render.ts";
import { generate } from "./manifest.ts";

/**
 * Orchestrator for the Healthy Canyons deck generation pipeline:
 *   1. parse    — spreadsheets → data/healthy/species.json
 *   2. fetch    — iNaturalist resolution + photo downloads (slow, network)
 *   3. render   — card images → public/cards-healthy/
 *   4. manifest — app/data/healthyCards.ts + data/healthy/report.md
 *
 * Usage: node scripts/healthy-cards/generate.ts [all|parse|fetch|render|manifest]
 * The fetch stage is resumable (already-fetched taxa are skipped).
 */

const stage = process.argv[2] ?? "all";
const run = (name: string, fn: () => unknown): Promise<unknown> | unknown => {
  console.log(`\n=== ${name} ===`);
  return fn();
};

async function main(): Promise<void> {
  const stages = stage === "all" ? ["parse", "fetch", "render", "manifest"] : [stage];
  for (const s of stages) {
    if (s === "parse") await run("parse spreadsheets", parse);
    else if (s === "fetch") await run("fetch photos from iNaturalist", runFetch);
    else if (s === "render") await run("render card images", renderAll);
    else if (s === "manifest") await run("write manifest + report", generate);
    else {
      console.error(`Unknown stage "${s}". Use all|parse|fetch|render|manifest.`);
      process.exit(1);
    }
  }
  console.log("\nDone.");
}

main();