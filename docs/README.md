# docs

> Part of **`siphon_master`** — public documentation site.

Documentation site for [Siphon Protocol](https://siphon.money) — private DeFi execution with TFHE strategies and Groth16 private spends.

Built with [Fumadocs](https://fumadocs.dev) + Next.js. Target deploy: `docs.siphon.money` (infra cutover tracked in repo `STATUS.md`).

## Development

```bash
cd siphon-docs
npm install
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) — `/` redirects to `/docs`.

## Project structure

```
siphon-docs/
├── app/                  # Next.js App Router
│   ├── (home)/           # Landing page
│   ├── docs/             # Docs layout + catch-all pages
│   └── api/search/       # Orama full-text search
├── content/docs/         # MDX documentation (edit here)
├── components/           # MDX component overrides
├── lib/                  # Source loader, shared layout config
└── source.config.ts      # Fumadocs MDX config
```

## Adding pages

1. Create an `.mdx` file under `content/docs/`
2. Add frontmatter: `title`, `description`, optional `icon`
3. Update the folder's `meta.json` to include the page in the sidebar

## Deployment (Vercel)

1. Connect this folder as a project (or monorepo subpath)
2. Add domain `docs.siphon.money`
3. Build command: `npm run build`
4. Output: Next.js default

Optionally redirect `siphon.money/docs` → `docs.siphon.money`.

## Content sources

Protocol content can be synced from sibling repos:

| Source | Docs section |
|--------|----------------|
| `thesiphon.md` | Overview / protocol |
| `siphon-app/docs/` | Product / builder |
| `siphon-indexer/*.md` | Indexer |
