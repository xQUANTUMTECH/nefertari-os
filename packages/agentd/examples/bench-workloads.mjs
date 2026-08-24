// The two workloads, shared by every harness under test.
//
// One definition, imported by bench-on-nefertari.mjs and bench-dsh.mjs, because
// a comparison where each side owns its own copy of the task stops being a
// comparison the first time one copy is edited.
//
// Both verdicts are PHYSICAL: they read the filesystem, never the model's claim
// to have finished. Agents announce success they did not achieve often enough
// that a benchmark trusting the transcript measures confidence, not work.

import fs from "node:fs";
import path from "node:path";

export const FILES = {
  "src/index.html": "<h1>Cellnovis</h1>",
  "src/styles.css": "body{color:#0E4D64}",
  "src/app.js": "console.log('cellnovis')",
  "docs/README.md": "# Cellnovis site",
  "docs/DEPLOY.md": "deploy: cloudflare pages",
  "data/products.csv": "sku,name\ncn-derm,CN-Derm",
};

export const fileSpec = Object.entries(FILES)
  .map(([f, c]) => `- "${f}" containing EXACTLY (no extra whitespace):\n${c}`)
  .join("\n");

export const CANDIDATES = [
  "La rivoluzione della diagnostica è arrivata",
  "Tecnologia medicale che stupisce il mercato",
  "Diagnostica di cui i clinici si fidano, ogni giorno",
];

export const candSpec = CANDIDATES.map((c, i) => `${i + 1}. ${c}`).join("\n");

// The winner is the THIRD candidate on purpose. For anything sequential that is
// the worst case and the cost scales with position; for a parallel race the cost
// is the same wherever the winner sits. A benchmark whose winner came first
// would flatter the sequential baseline and prove nothing.
export const ACCEPTANCE = "grep -qi fidano hero.md";

export function verifyFiles(ws) {
  return Object.entries(FILES).every(([f, c]) => {
    try {
      return fs.readFileSync(path.join(ws, f), "utf8").trim() === c.trim();
    } catch {
      return false;
    }
  });
}

export function verifyTagline(ws) {
  try {
    return /fidano/i.test(fs.readFileSync(path.join(ws, "hero.md"), "utf8"));
  } catch {
    return false;
  }
}
