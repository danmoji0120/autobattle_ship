# Content graphic assets

Files here are served at `./assets/content/<path>` and must be registered in a content pack
(`src/content/packs/*/assets.ts`). `npm run content:check` fails on unregistered or missing files.

- `models/`     ship and variant models (`.glb`, ≤ 2 MB, +z forward, origin at hull centre, 1 unit = 1 game unit)
- `portraits/`  commander portraits (`.webp`/`.png`, 512×512, ≤ 300 KB)
- `icons/`      equipment / item / facility icons (`.svg`, or `.webp`/`.png` 128×128, ≤ 64 KB)

Full rules: `docs/CONTENT_SCHEMA.md` §6 (the Codex guide follows in P2).
