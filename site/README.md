# site/ — the public web presence (homepage + docs)

A fully static site: the marketing homepage at `/` and the developer docs at `/docs/`.
No build step, no framework — plain HTML/CSS/JS sharing the product's design tokens
(Linear-style dark, indigo `#5e6ad2`).

## Deploy (Vercel)

One static project serves both surfaces:

1. Vercel → Add New Project → import `everdict/everdict`.
2. **Root Directory** = `site` · **Framework Preset** = Other (static) · no build command, output dir = `.`.
3. Deploy — the homepage lands at `/`, the docs at `/docs/`.

Any static host works the same way (GitHub Pages, nginx, the compose web container).

## Layout

- `index.html` — homepage ("Know if your agents actually work")
- `docs/index.html` — developer docs (domain map + real product screenshots, hash-routed pages)
- `docs/img/*.webp` — screenshots captured from a live self-hosted deployment

Screenshots show demo data only (the `acme` demo workspace from the bundled Keycloak realm).
Follow-up: migrate docs to per-route pages (Nextra) when the content outgrows one file.
