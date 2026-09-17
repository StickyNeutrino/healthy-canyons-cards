# Healthy Canyons deck

A self-contained flashcard deck: species recorded across San Diego canyon surveys
(NFWF Healthy Canyons project), with photos from CC-licensed iNaturalist
observations. 983 cards across two categories (Plants, Animals).

## Contents

| Path | What it is |
| --- | --- |
| `manifest.json` | The deck: categories, card names, image filenames, native/invasive status, rarity (CNPS/CESA/FESA), and per-photo credits. Generated — the app consumes this. |
| `cards/` | Rendered card images: `<name> Front.jpg` (three iNaturalist photos, each credited beneath) and `<name> Back.jpg` (names, family, native status, rarity). Generated. |
| `source/` | The two NFWF canyon-survey spreadsheets this deck is generated from. |
| `generation/` | The offline pipeline: `parse` (spreadsheets → species list) → `fetch` (iNaturalist resolution + CC photo download) → `render` (image compositing) → `manifest` (deck manifest + report). |
| `data/` | Generation artifacts: normalized species list, fetch/render reports, the human-readable generation report, and API/raw-photo caches (gitignored). |

## Regenerating

Requires Node.js 22+ (for running the TypeScript pipeline directly) and network access to iNaturalist (the app itself never
talks to iNaturalist — only this pipeline does).

```bash
npm install
npm run generate            # full pipeline
npm run generate:fetch      # just (re-)download photos — resumable, cached
npm run generate:manifest   # just rebuild manifest.json + data/report.md
```

Every stage is idempotent and cached in `data/`, so re-runs after tweaking a
spreadsheet only touch what changed.

## Photo licensing

Card photos are individual iNaturalist observers' work, used under their
Creative Commons licenses (CC0, CC-BY, CC-BY-SA, CC-BY-NC*; no ND). Each card
credits its photographers beneath the photos; `manifest.json` carries the full
attribution data (observer, license, observation link) that the app's credits
page renders.

## License

The generation code is licensed AGPL-3.0-or-later, matching the app. Card
images are covered by their respective Creative Commons licenses (see
`manifest.json` credits), not the code license.
