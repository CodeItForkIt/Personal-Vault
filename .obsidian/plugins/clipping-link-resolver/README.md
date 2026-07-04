# Clipping Link Resolver

Rewrites external links to internal `[[wikilinks]]` whenever the URL matches
another note in your vault — either via a `source` frontmatter property
(Obsidian Web Clipper's default), or by filename, scoped to your clippings
folder. Filename matching is the fallback for notes that don't have (or
don't reliably have) a source property set.

## Install (manual, no build needed)

1. In your vault: `VaultFolder/.obsidian/plugins/clipping-link-resolver/`
   (create the folder if it doesn't exist).
2. Copy `manifest.json` and `main.js` into it.
3. Reload Obsidian (or toggle the plugin off/on) and enable
   "Clipping Link Resolver" under Settings → Community plugins.

`main.ts` is included only as the readable source if you want to tweak the
matching/replacement logic — it isn't needed at runtime. If you do edit it,
rebuild with `node esbuild.config.mjs production` (needs `npm install` first
in the source folder for esbuild + obsidian types).

## What it does

1. **Frontmatter matching** (most precise): indexes every note's `source`
   property (configurable key) into a normalized-URL → note map.
2. **Filename matching** (fallback, for notes without a usable `source`):
   derives a "slug" from the last segment of the link's URL (e.g.
   `/wiki/Worldhopper` → `worldhopper`), then looks inside your configured
   clippings root folder (recursing into subfolders — so `Clippings/{{site}}`
   style structures work fine) for a note whose filename, **or one of its
   frontmatter `aliases`**, starts with that slug (e.g. a note titled
   "Hoid - The Coppermind" with `aliases: [Wit, Wandersail]` resolves links
   to any of those names). If zero or more than one note matches, it skips
   that link rather than guessing.

Either way, matches are then rewritten using Obsidian's own
`generateMarkdownLink` API, so the output respects whatever wikilink vs.
markdown-link and shortest-path settings your vault already uses. Links to
a specific section (`.../Hoid#Abilities`) are preserved as heading links
(`[[Hoid#Abilities]]`) rather than collapsed to a plain note link.

3. **Live redirect resolution** (opt-in, off by default): handles true
   wiki redirects — e.g. Coppermind's "Wit" silently redirecting server-side
   to "Hoid" — that neither frontmatter nor filename matching could ever
   catch on their own, since that mapping only exists on the wiki's server,
   not anywhere in your vault. When the two matchers above both come up
   empty, this fetches the URL directly (an ordinary page load, the same
   request your browser makes when you click the link — not the wiki's API
   endpoint) and reads its `<link rel="canonical">` tag (a standard,
   skin-independent signal MediaWiki always emits) to find the real target,
   then retries matching against that. See "Notes / caveats" below for the
   honest limits of this approach.

## Commands

- **Resolve external links to internal links (current note)** — only
  touches the active file.
- **Resolve external links to internal links (entire vault)** — runs across
  every markdown file not in an excluded folder. As each file is actually
  modified, a short notice pops up naming it and how many links it
  converted, so a long run gives you live proof it's working rather than
  going silent for a minute and leaving you guessing. A final summary
  notice reports the totals once everything's done.

## Settings

**Frontmatter matching**
- **Match using frontmatter source property** — on by default.
- **Source property key** — default `source` (Web Clipper's default).

**Filename matching (fallback)**
- **Match by filename when no frontmatter match is found** — on by default.
- **Clippings root folder** — default `Clippings`. Searched recursively, so
  per-site subfolders (`Clippings/coppermind.net/`, etc.) are covered
  automatically — you don't need to tell it the exact subfolder naming
  scheme. Leave blank to search the whole vault.
- **Also match against note aliases** — on by default. Checks each note's
  frontmatter `aliases` property in addition to its filename.

**General**
- **Excluded folders** — comma-separated paths to skip when *converting*
  links (separate from the clippings root folder, which only scopes the
  filename-match *search*), e.g. `Templates`.
- **Ignore query parameters / trailing slash / http vs https / www.**
  (frontmatter matching only) — toggle which URL differences are treated as
  "same page". All on by default.
- **Skip self-links** — don't replace a link with a link back to the note
  it's already in. Applies to both matching strategies.
- **Preserve links to headings** — on by default. A link to
  `.../Hoid#Abilities` becomes `[[Hoid#Abilities]]` rather than dropping
  the section and linking to the top of the note.

**Live redirect resolution (opt-in)**
- **Resolve wiki redirects via live lookup** — off by default, since it's
  the one feature here that makes real network requests. Only fires as a
  last resort, after frontmatter and filename matching both fail. Scoped
  automatically to domains already present in your vault (pulled from
  notes' `domain` frontmatter and `source` hostnames) — it will never fetch
  a domain it hasn't seen you clip from already.
- **Delay between lookups (ms)** — default 1000ms, applied before each new
  (uncached) lookup. Please don't drop this much lower; this is repeated
  automated traffic against someone else's server even though each
  individual request is indistinguishable from a normal page load.
- **Lookup timeout (ms)** — default 8000ms. Caps how long a single lookup
  can stall a vault-wide run. This is a *soft* timeout: Obsidian's
  `requestUrl` doesn't expose a documented way to actually abort an
  in-flight request, so past the deadline the plugin stops waiting and
  moves on, but the underlying network request may still be running
  unseen in the background rather than truly cancelled. A timed-out lookup
  is deliberately **not** cached — it's treated as a transient hiccup, not
  a fact about the page, so a later run will retry it rather than being
  stuck with a false "no redirect" verdict.
- **Clear redirect cache** — resolved redirects are cached (persisted
  across runs) so a given URL is only ever fetched once, not once per run.
  Clear this if a wiki reorganizes its pages and old cached targets might
  be stale.

## Notes / caveats

- Filename matching is a "starts with" heuristic: it expects something like
  `<Slug> - <Site Name>.md`, which matches common wiki-clip title formats
  (e.g. "Worldhopper - The Coppermind", à la Wikipedia's "Page - Wikipedia").
  If your template names files differently, this fallback may not fire —
  frontmatter matching is unaffected either way.
- If two clipped notes (or their aliases) normalize to the same slug, that
  link is left alone (ambiguous) rather than picking one arbitrarily.
- Heading-link matching does standard percent-decoding + underscore-to-space
  only. Older MediaWiki sites occasionally dot-encode punctuation in anchors
  (e.g. ".2C" for a comma) rather than percent-encoding it — those aren't
  unpacked, so a heading containing punctuation might land as
  `[[Note#Some Heading.2C Continued]]` instead of matching exactly. Worth a
  glance if a converted heading link looks like it didn't quite land.
- A link to a heading within the *same* note it appears in isn't converted
  to a same-note heading link (`[[#Heading]]`) — self-links are skipped
  entirely by default (see "Skip self-links" above).
- Only `[text](url)` and `[text](url "title")` markdown-style links are
  converted, not bare autolinked URLs or `<url>` angle-bracket links.
- **On live redirect resolution specifically**: this was built and unit-
  tested against realistic MediaWiki HTML (including attribute-order
  variations in the canonical tag), but wasn't run against Coppermind
  itself while building it — I don't have a way to verify that live. It's
  a well-known, standard pattern (any well-behaved site emits a canonical
  link), so it should hold up, but "should" is doing some work in that
  sentence. If it doesn't fire when you'd expect, a wrong assumption about
  Coppermind's actual HTML output is the most likely first suspect —
  worth a quick "view source" check on a known-redirect URL to confirm
  the canonical tag looks the way this expects.
