/**
 * Generates one SVG per catalogue product into public/img/.
 * Offline, zero-dependency, no licensing questions - and they read clearly at
 * thumbnail size in chat. Swap in real photos any time: drop <id>.jpg into
 * public/img/ and point the product's `image` field at it.
 */
import fs from "node:fs";

const catalog = JSON.parse(fs.readFileSync("data/catalog.json", "utf8"));

const COLORS = {
  blue: "#3b6ea5", white: "#f2f0ea", black: "#2b2b30", maroon: "#7d2233",
  beige: "#cbb894", olive: "#6b7248", cream: "#efe4cc", teal: "#1f6f6b",
  grey: "#7a8087", yellow: "#d8a326", gold: "#c9a227", rust: "#a9542c", tan: "#b07d4f",
};
const shade = (hex, f) => "#" + hex.slice(1).match(/../g)
  .map((h) => Math.max(0, Math.min(255, Math.round(parseInt(h, 16) * f))).toString(16).padStart(2, "0")).join("");

/** Garment silhouettes, drawn in a 200x200 box. */
const SHAPES = {
  kurta: (c, d) => `
    <path d="M64 46 L84 36 Q100 48 116 36 L136 46 L150 62 L136 76 L130 68 L130 168 Q100 176 70 168 L70 68 L64 76 L50 62 Z" fill="${c}"/>
    <path d="M100 48 L100 168" stroke="${d}" stroke-width="1.5" opacity=".55"/>
    <path d="M84 36 Q100 60 116 36" fill="none" stroke="${d}" stroke-width="2.5"/>
    <circle cx="100" cy="74" r="2.4" fill="${d}"/><circle cx="100" cy="92" r="2.4" fill="${d}"/>`,
  coat: (c, d) => `
    <path d="M62 46 L84 34 L100 44 L116 34 L138 46 L152 64 L138 78 L132 70 L132 170 Q100 178 68 170 L68 70 L62 78 L48 64 Z" fill="${c}"/>
    <path d="M84 34 L100 60 L116 34" fill="none" stroke="${d}" stroke-width="3"/>
    <path d="M100 60 L100 170" stroke="${d}" stroke-width="2" opacity=".6"/>
    <path d="M68 70 L68 170 M132 70 L132 170" stroke="${d}" stroke-width="1" opacity=".35"/>
    <circle cx="100" cy="84" r="2.6" fill="${d}"/><circle cx="100" cy="106" r="2.6" fill="${d}"/><circle cx="100" cy="128" r="2.6" fill="${d}"/>`,
  bottom: (c, d) => `
    <path d="M70 40 L130 40 L136 76 L124 172 L106 172 L100 96 L94 172 L76 172 L64 76 Z" fill="${c}"/>
    <path d="M70 40 L130 40" stroke="${d}" stroke-width="4"/>
    <path d="M100 96 L100 44" stroke="${d}" stroke-width="1.5" opacity=".5"/>`,
  cloth: (c, d) => `
    <path d="M42 58 Q70 42 100 58 Q130 74 158 58 L158 132 Q130 148 100 132 Q70 116 42 132 Z" fill="${c}"/>
    <path d="M42 76 Q70 60 100 76 Q130 92 158 76" fill="none" stroke="${d}" stroke-width="2" opacity=".5"/>
    <path d="M42 112 Q70 96 100 112 Q130 128 158 112" fill="none" stroke="${d}" stroke-width="2" opacity=".5"/>`,
  shoe: (c, d) => `
    <path d="M46 128 Q46 96 74 90 Q100 86 124 94 Q152 104 154 126 Q154 138 140 138 L58 138 Q46 138 46 128 Z" fill="${c}"/>
    <path d="M46 130 L154 130" stroke="${d}" stroke-width="4"/>
    <path d="M74 92 Q100 112 126 96" fill="none" stroke="${d}" stroke-width="2.5" opacity=".7"/>`,
  trinket: (c, d) => `
    <circle cx="78" cy="82" r="17" fill="${c}" stroke="${d}" stroke-width="2"/>
    <circle cx="122" cy="82" r="17" fill="${c}" stroke="${d}" stroke-width="2"/>
    <circle cx="78" cy="126" r="17" fill="${c}" stroke="${d}" stroke-width="2"/>
    <circle cx="122" cy="126" r="17" fill="${c}" stroke="${d}" stroke-width="2"/>
    <circle cx="78" cy="82" r="4" fill="${d}"/><circle cx="122" cy="82" r="4" fill="${d}"/>
    <circle cx="78" cy="126" r="4" fill="${d}"/><circle cx="122" cy="126" r="4" fill="${d}"/>`,
};

function shapeFor(p) {
  const t = p.tags.join(" ");
  if (/buttons/.test(t)) return "trinket";
  if (/chappal|mojari/.test(t)) return "shoe";
  if (/dupatta|stole/.test(t)) return "cloth";
  if (/bottom|pyjama|churidar/.test(t)) return "bottom";
  if (/sherwani|blazer|bandhgala|jacket|nehru/.test(t)) return "coat";
  return "kurta";
}

let n = 0;
for (const p of catalog.products) {
  const base = COLORS[p.color] ?? "#8a8a8a";
  const dark = shade(base, 0.62);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="${p.name}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f7f4ef"/><stop offset="1" stop-color="#e8e2d8"/></linearGradient></defs>
  <rect width="200" height="200" fill="url(#bg)"/>
  <ellipse cx="100" cy="180" rx="52" ry="7" fill="#000" opacity=".07"/>
  ${SHAPES[shapeFor(p)](base, dark)}
</svg>`;
  fs.writeFileSync(`public/img/${p.id}.svg`, svg);
  p.image = `/img/${p.id}.svg`;
  n++;
}

fs.writeFileSync("data/catalog.json", JSON.stringify(catalog, null, 2) + "\n");
console.log(`✅ generated ${n} product images into public/img/ and added "image" to each catalogue entry`);
