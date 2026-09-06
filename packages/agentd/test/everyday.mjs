// What a person's ordinary request produces, and where the line falls.
//
// Found by driving a real "tidy my Downloads" through the broker: it gated a
// move inside the folder it was tidying, gated every test run, let a delete
// through in silence when the person had said "ask me first", and a promote
// rewound a git commit made in between. Each claim below is one of those.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyShell, CLASS } from "../src/broker.mjs";
import * as timeline from "../src/timeline.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const R = CLASS.REVERSIBLE, N = CLASS.NOISY, I = CLASS.IRREVERSIBLE;
const ok = (m) => console.log("  ok — " + m);

// -- moving and copying inside the working dir passes (noisy); leaving it gates --
const CASES = [
  ["mv -- *.jpg *.png Foto/", N, "move into a subfolder"],
  ["mv 'Copia di IMG.jpg' Foto/", N, "quoted name with spaces"],
  ["cp a.txt b.txt", N, "copy beside"],
  ["cp -r src build/", N, "recursive copy inside"],
  ["mv -t Foto/ a.jpg b.jpg", N, "-t with a relative dir"],
  ["mv --target-directory=Foto a.jpg", N, "--target-directory= relative"],
  ["mv a.txt /etc/a.txt", I, "absolute destination"],
  ["mv ../secret.txt .", I, "climbs out with .."],
  ["cp a.txt ~/a.txt", I, "home-relative"],
  ["mv a.txt $HOME/a.txt", I, "variable expansion"],
  ["mv --target-directory=/tmp a.jpg", I, "--target-directory= absolute"],
  ["rm -rf Foto", I, "rm stays gated: fs_delete snapshots, rm does not"],
  ["mkdir -p Foto && mv -- *.jpg Foto/", N, "a whole tidy-up is one noisy plan"],
];
for (const [cmd, want, why] of CASES) assert.equal(classifyShell(cmd), want, `${cmd} — ${why}`);
ok("mv/cp: relative paths pass as noisy, anything that leaves the dir gates (" + CASES.length + " cases)");

// -- running the tests is the most frequent action an agent takes: noisy, not a gate --
const RUNNERS = ["node --test test/x.mjs", "npm test", "npm t", "pnpm test", "yarn test", "npx vitest run", "npx jest",
  "pytest -q", "python -m pytest", "cargo test", "go test ./...", "make test",
  "node --test test/slug.test.mjs 2>&1 | grep -E '^# (pass|fail)'"];
for (const cmd of RUNNERS) assert.equal(classifyShell(cmd), N, cmd + " must be noisy");
assert.equal(classifyShell("node evil.mjs"), I, "a bare node script is still unknown");
assert.equal(classifyShell("npm test | sh"), I, "the danger scan still wins");
ok("test runners are noisy (" + RUNNERS.length + "), a bare `node script` and pipe-into-sh still gate");

// -- the checkpoint leaves .git alone: the timeline moves files, git keeps history --
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-everyday-"));
fs.mkdirSync(path.join(ws, ".git", "objects"), { recursive: true });
fs.writeFileSync(path.join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
fs.writeFileSync(path.join(ws, "a.txt"), "A1");
const ck = timeline.checkpoint(ws, { label: "t" });
assert.equal(ck.files, 1, ".git must not be checkpointed by default");
fs.writeFileSync(path.join(ws, ".git", "HEAD"), "ref: refs/heads/feature\n");
fs.writeFileSync(path.join(ws, "a.txt"), "A2");
timeline.restoreTo(ck.id, ws);
assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "A1", "the tree is restored");
assert.equal(fs.readFileSync(path.join(ws, ".git", "HEAD"), "utf8"), "ref: refs/heads/feature\n", ".git is untouched by restore");
ok("checkpoint skips .git; restore moves the tree and leaves git's history where it was");

// -- the person's line: NEFERTARI_ASK sends a named tool to the gate whatever the broker thinks --
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-ask-"));
const mcp = new Client({ name: "everyday-test", version: "0" });
await mcp.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(import.meta.dirname, "..", "src", "server.mjs")],
  env: { ...process.env, NEFERTARI_HOME: home, NEFERTARI_ASK: "fs_delete,shell:git commit" },
}));
const call = async (name, args) => JSON.parse((await mcp.callTool({ name, arguments: args })).content.map((c) => c.text).join(""));
fs.writeFileSync(path.join(ws, "dup.txt"), "dup");
const del = await call("fs_delete", { path: path.join(ws, "dup.txt") });
assert.equal(del.status, "pending_approval", "a delete is reversible to the broker but the person said ask");
assert.match(del.reason, /ask rule fs_delete/, "the pending entry names the rule");
assert.ok(fs.existsSync(path.join(ws, "dup.txt")), "and nothing was deleted");
const wr = await call("fs_write", { path: path.join(ws, "new.txt"), content: "x" });
assert.equal(wr.status, "written", "a tool the rule does not name is unaffected");
assert.equal(classifyShell("git commit -m x"), N, "to the broker a commit is noisy: it would pass");
const commit = await call("shell", { command: "git commit -m x", cwd: ws });
assert.equal(commit.status, "pending_approval", "…but the person's rule sends it to the gate");
assert.match(commit.reason, /ask rule shell:git commit/, "tool:REGEX form matches on the arguments");
const push = await call("shell", { command: "git push origin main", cwd: ws });
assert.equal(push.status, "pending_approval");
assert.doesNotMatch(push.reason, /ask rule/, "what the broker already gates keeps the broker's own reason: a rule only tightens");
const st = await call("sys_status", {});
assert.deepEqual(st.ask_rules, [{ tool: "fs_delete" }, { tool: "shell", pattern: "git commit" }], "the rules are visible in sys_status");
await mcp.close();
ok("NEFERTARI_ASK gates fs_delete and shell:git commit, leaves fs_write alone, never loosens, and shows in sys_status");

fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
console.log("EVERYDAY TESTS PASSED");
