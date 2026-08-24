// Generates the static /hexagrams/ pages from data.js. Re-run this after
// editing data.js:
//   node hexagrams-src/generate.mjs
//
// Output goes to ../hexagrams/<slug>/index.html and ../hexagrams/index.html
// (relative to this file), and sitemap.xml is rewritten to include every
// generated URL alongside the homepage.

import { HEXAGRAMS } from "./data.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HEX_DIR = join(ROOT, "hexagrams");
const SITE = "https://thebookofchanges.app";

const PAGE_HEAD = ({ title, description, canonical }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#FAFAFA">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The Book of Changes">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/iching-art.webp">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${SITE}/iching-art.webp">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23FAFAFA' stroke='%231A1A1A' stroke-width='1.5'/%3E%3Crect x='8' y='10' width='16' height='3' fill='%231A1A1A'/%3E%3Crect x='8' y='15' width='6' height='3' fill='%231A1A1A'/%3E%3Crect x='18' y='15' width='6' height='3' fill='%231A1A1A'/%3E%3Crect x='8' y='20' width='16' height='3' fill='%231A1A1A'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;500;600;700&family=Kalam:wght@300;400;700&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{--text-black:#1A1A1A;--vibrant-blue:#cde8f1;--vibrant-red:#e1daf3;--split:linear-gradient(90deg,var(--vibrant-blue) 50%,var(--vibrant-red) 50%);--font-body:'Kalam',cursive}
  html{font-size:106%}
  body{font-family:'Kalam',cursive;background:#FAFAFA;color:var(--text-black);margin:0;padding:0 1.5rem 4rem;display:flex;flex-direction:column;align-items:center}
  .wrap{max-width:720px;width:100%}
  a{color:var(--text-black)}
  .top-nav{padding:1.5rem 0;font-size:1.3rem}
  .top-nav a{text-decoration:none;border-bottom:1px solid rgba(26,26,26,0.25)}
  .symbol{font-size:5rem;text-align:center;line-height:1;margin:1rem 0}
  h1{font-size:clamp(2.2rem,7vw,3.2rem);text-align:center;margin:0 0 0.2rem 0;background:var(--split);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent;font-weight:700}
  .pinyin{text-align:center;font-size:1.4rem;color:#777;margin-bottom:2.5rem}
  h2{font-size:1.7rem;margin:2.2rem 0 0.6rem 0}
  p{font-family:var(--font-body);font-size:1.35rem;line-height:1.75;color:#444;margin:0 0 1rem 0}
  .cta{margin:3rem 0;padding:2rem;text-align:center;background:#fff;border-radius:16px;box-shadow:0 4px 30px rgba(0,0,0,0.06)}
  .cta p{color:#666}
  .btn{display:inline-block;margin-top:0.5rem;padding:0.7rem 2rem;border-radius:999px;background:var(--split);color:var(--text-black);text-decoration:none;font-size:1.4rem;font-weight:600}
  .prevnext{display:flex;justify-content:space-between;margin-top:3rem;font-size:1.3rem}
  .related{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0.7rem;margin-top:1rem}
  .related a{display:flex;align-items:center;gap:0.6rem;background:#fff;border-radius:10px;padding:0.7rem 0.9rem;text-decoration:none;color:var(--text-black);box-shadow:0 2px 10px rgba(0,0,0,0.05);font-size:1.15rem}
  .related .rsym{font-size:1.6rem}
  footer{margin-top:3rem;font-size:1.1rem;color:#999;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<div class="top-nav"><a href="/">&larr; The Book of Changes</a> &nbsp;/&nbsp; <a href="/hexagrams/">All 64 Hexagrams</a></div>
`;

const PAGE_FOOT = `</div>
</body>
</html>
`;

function relatedFor(h, all) {
  // Spread related links across the whole set (not just neighbors) so the
  // internal link graph reaches broadly rather than chaining locally -
  // deterministic offsets keep this stable across regenerations.
  const n = all.length;
  const offsets = [8, 23, 41];
  return offsets.map(off => all[(h.number - 1 + off) % n]);
}

function hexagramPage(h, prev, next, related) {
  const title = `Hexagram ${h.number}: ${h.name} (${h.pinyin}) - I Ching Meaning`;
  const description = `Hexagram ${h.number}, ${h.name} (${h.pinyin}): ${h.judgment}`;
  const canonical = `${SITE}/hexagrams/${h.slug}/`;

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "The Book of Changes", "item": SITE + "/" },
      { "@type": "ListItem", "position": 2, "name": "All 64 Hexagrams", "item": SITE + "/hexagrams/" },
      { "@type": "ListItem", "position": 3, "name": `Hexagram ${h.number}: ${h.name}`, "item": canonical }
    ]
  };

  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": `Hexagram ${h.number}: ${h.name} (${h.pinyin})`,
    "description": description,
    "url": canonical,
    "mainEntityOfPage": canonical,
    "isPartOf": { "@type": "WebSite", "name": "The Book of Changes", "url": SITE + "/" }
  };

  const structuredData = `<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
<script type="application/ld+json">${JSON.stringify(article)}</script>`;

  const relatedLinks = related.map(r => `<a href="/hexagrams/${r.slug}/"><span class="rsym" aria-hidden="true">${r.symbol}</span><span>${r.number}. ${r.name}</span></a>`).join("\n  ");

  return `${PAGE_HEAD({ title, description, canonical })}${structuredData}
<div class="symbol" aria-hidden="true">${h.symbol}</div>
<h1>${h.number}. ${h.name}</h1>
<div class="pinyin">${h.pinyin}</div>

<h2>Judgment</h2>
<p>${h.judgment}</p>

<h2>The Image</h2>
<p>${h.image}</p>

<h2>Guidance</h2>
<p>${h.guidance}</p>

<div class="cta">
  <p>Curious how Hexagram ${h.number} applies to your own situation?</p>
  <a class="btn" href="/">Ask the Oracle a Question</a>
</div>

<h2>Related Hexagrams</h2>
<div class="related">
  ${relatedLinks}
</div>

<div class="prevnext">
  <a href="/hexagrams/${prev.slug}/">&larr; ${prev.number}. ${prev.name}</a>
  <a href="/hexagrams/${next.slug}/">${next.number}. ${next.name} &rarr;</a>
</div>

<footer>Part of <a href="/">The Book of Changes</a>, a free online I Ching oracle.</footer>
${PAGE_FOOT}`;
}

function hubPage() {
  const title = "All 64 I Ching Hexagrams - Meanings & Guidance";
  const description = "Browse the full list of all 64 I Ching hexagrams, from The Creative to Before Completion, with the traditional judgment, image, and modern guidance for each.";
  const canonical = `${SITE}/hexagrams/`;

  const items = HEXAGRAMS.map(h => `
  <a class="hex-card" href="/hexagrams/${h.slug}/">
    <span class="hex-symbol" aria-hidden="true">${h.symbol}</span>
    <span class="hex-info"><strong>${h.number}. ${h.name}</strong><span class="hex-pinyin">${h.pinyin}</span></span>
  </a>`).join("");

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "The 64 I Ching Hexagrams",
    "url": canonical,
    "itemListElement": HEXAGRAMS.map(h => ({
      "@type": "ListItem",
      "position": h.number,
      "name": `Hexagram ${h.number}: ${h.name}`,
      "url": `${SITE}/hexagrams/${h.slug}/`
    }))
  };
  const structuredData = `<script type="application/ld+json">${JSON.stringify(itemList)}</script>`;

  return `${PAGE_HEAD({ title, description, canonical })}${structuredData}
<h1 style="margin-bottom:0.3rem;">The 64 Hexagrams</h1>
<p style="text-align:center;color:#666;margin-bottom:2.5rem;">The complete set of I Ching hexagrams, each a distinct pattern of change. Select one to read its traditional meaning, or return to the oracle to cast your own.</p>
<div class="hex-grid">${items}
</div>
<div class="cta">
  <p>Want a reading built around your own question?</p>
  <a class="btn" href="/">Ask the Oracle a Question</a>
</div>
<footer>Part of <a href="/">The Book of Changes</a>, a free online I Ching oracle.</footer>
<style>
.hex-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0.8rem;margin-top:1rem}
.hex-card{display:flex;align-items:center;gap:0.8rem;background:#fff;border-radius:12px;padding:0.8rem 1rem;text-decoration:none;color:var(--text-black);box-shadow:0 2px 10px rgba(0,0,0,0.05)}
.hex-symbol{font-size:2rem;line-height:1}
.hex-info{display:flex;flex-direction:column;font-size:1.15rem;line-height:1.3}
.hex-pinyin{color:#888;font-size:1rem}
</style>
${PAGE_FOOT}`;
}

// --- Generate hexagram pages ---
mkdirSync(HEX_DIR, { recursive: true });
HEXAGRAMS.forEach((h, i) => {
  const prev = HEXAGRAMS[(i - 1 + HEXAGRAMS.length) % HEXAGRAMS.length];
  const next = HEXAGRAMS[(i + 1) % HEXAGRAMS.length];
  const related = relatedFor(h, HEXAGRAMS);
  const dir = join(HEX_DIR, h.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), hexagramPage(h, prev, next, related));
});

// --- Generate hub page ---
writeFileSync(join(HEX_DIR, "index.html"), hubPage());

// --- Rewrite sitemap.xml with every URL ---
const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: `${SITE}/`, priority: "1.0" },
  { loc: `${SITE}/hexagrams/`, priority: "0.8" },
  ...HEXAGRAMS.map(h => ({ loc: `${SITE}/hexagrams/${h.slug}/`, priority: "0.6" })),
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join("\n")}
</urlset>
`;
writeFileSync(join(ROOT, "sitemap.xml"), sitemap);

console.log(`Generated ${HEXAGRAMS.length} hexagram pages + hub page + sitemap.xml (${urls.length} URLs, lastmod ${today}).`);
