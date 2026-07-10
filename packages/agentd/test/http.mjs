// Headless approval API smoke: auth, list, approve, deny, journal, single-use
// consumption — over a real HTTP socket.
import assert from "node:assert";
import { createServer, loadOrCreateToken } from "../src/http.mjs";
import * as approvals from "../src/approvals.mjs";

assert.ok(process.env.NEFERTARI_HOME, "set NEFERTARI_HOME to a temp dir");

const token = loadOrCreateToken();
const server = createServer({ token });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { authorization: `Bearer ${token}` };
const j = async (res) => ({ code: res.status, body: await res.json() });

let step = 0;
const done = (m) => console.log(`  ✓ [${++step}] ${m}`);

// health is public
let r = await j(await fetch(`${base}/health`));
assert.equal(r.code, 200);
assert.equal(r.body.ok, true);
done("GET /health public");

// everything else requires the token
r = await j(await fetch(`${base}/pending`));
assert.equal(r.code, 401);
r = await j(await fetch(`${base}/pending`, { headers: { authorization: "Bearer wrong" } }));
assert.equal(r.code, 401);
done("401 without / with wrong token");

// register two pendings, list them over HTTP
const p1 = approvals.registerPending("shell", { command: "rm -rf /srv/a" }, "test");
const p2 = approvals.registerPending("shell", { command: "rm -rf /srv/b" }, "test");
r = await j(await fetch(`${base}/pending`, { headers: auth }));
assert.equal(r.code, 200);
assert.equal(r.body.length, 2);
done("GET /pending lists both");

// approve one → consumable exactly once
r = await j(await fetch(`${base}/pending/${p1.id}/approve`, { method: "POST", headers: auth }));
assert.equal(r.code, 200);
assert.equal(r.body.approved, true);
assert.equal(approvals.consumeApproval("shell", { command: "rm -rf /srv/a" }), true);
assert.equal(approvals.consumeApproval("shell", { command: "rm -rf /srv/a" }), false, "single-use");
done("POST approve → consumable exactly once");

// deny the other → gone
r = await j(await fetch(`${base}/pending/${p2.id}/deny`, { method: "POST", headers: auth }));
assert.equal(r.code, 200);
r = await j(await fetch(`${base}/pending`, { headers: auth }));
assert.equal(r.body.length, 0);
done("POST deny removes it");

// unknown id → 404, journal has both human decisions with via:http
r = await j(await fetch(`${base}/pending/act_nope/approve`, { method: "POST", headers: auth }));
assert.equal(r.code, 404);
r = await j(await fetch(`${base}/journal?n=10`, { headers: auth }));
const via = r.body.filter((e) => e.via === "http").map((e) => e.decision);
assert.ok(via.includes("human_approved") && via.includes("human_denied"));
done("404 on unknown id; journal records via:http decisions");

server.close();
console.log("\nHTTP API SMOKE PASSED");
