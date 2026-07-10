// Zero-cost broker probe: no LLM, no host mutation. Runs the REAL command
// sequence a model would use to install the GitHub CLI (gh) through Nefertari's
// classifier and prints the verdict for each step — proving which actions run
// and which hit the human gate BEFORE we spend a live-model run.
//
//   node examples/gh-install-probe.mjs

import { classify } from "../src/broker.mjs";

// The canonical GitHub-CLI install for Debian/Ubuntu, step by step.
const STEPS = [
  ["which gh", "check if already installed"],
  ["sys_status", "inspect host", "sys_status"],
  ["sudo mkdir -p -m 755 /etc/apt/keyrings", "ensure keyrings dir"],
  ["curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg", "add signing key"],
  ["sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg", "make key readable"],
  ['echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list', "add apt repo"],
  ["sudo apt update", "refresh package index"],
  ["sudo apt install gh -y", "install the package"],
  ["gh --version", "verify install"],
];

const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
const badge = (c) => ({ reversible: "  runs   ", noisy: " runs*   ", irreversible: "→ GATED  " }[c] || c);

console.log("── gh install · broker verdict (no model, no mutation) ──\n");
let gates = 0;
for (const [cmd, note, tool] of STEPS) {
  const t = tool || "shell";
  const { class: cls, reason } = classify(t, { command: tool ? undefined : cmd });
  if (cls === "irreversible") gates++;
  console.log(`${badge(cls)} ${pad(note, 22)} ${reason}`);
  console.log(`           $ ${cmd}\n`);
}
console.log("──────────────────────────────────────────────────────");
console.log(`* noisy = runs but is journaled and flagged to the human.`);
console.log(`${gates} of ${STEPS.length} steps hit the human gate (trust-boundary actions).`);
console.log(`\nThe agent physically cannot add a third-party apt key/repo without`);
console.log(`a human approving it — that is the whole thesis, on a real task.`);
