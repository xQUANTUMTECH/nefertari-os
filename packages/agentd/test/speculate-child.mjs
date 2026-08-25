// Why the speculative copy moved out of the daemon.
//
// It used to run in-process, yielding to the event loop between files. That is
// fine until one of the files is large, because `copyFileSync` does not yield:
// a single big file blocked the daemon, and the daemon is what every tool call
// goes through. Speculation that can stall a real call is worse than none — the
// cost lands on exactly the path it was supposed to make faster.
//
// So this measures the thing that actually changed: EVENT LOOP LAG while the
// same copy happens, in-process against in a child. Everything else about
// speculation (what may be adopted, what must be re-copied) is unchanged and
// covered by speculate.mjs; this covers the reason for the move.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawn } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-spc-"));
process.env.NEFERTARI_HOME = home;

const speculate = await import("../src/speculate.mjs");
const cgroups = await import("../src/cgroups.mjs");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-spc-ws-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Big enough that copying it is measurable, small enough to be polite about
// disk in a test: 128MB of real bytes, not a sparse file, because a hole costs
// nothing to copy and would measure nothing.
const BIG = 128 * 1024 * 1024;
const big = path.join(ws, "big.bin");
{
  const chunk = Buffer.alloc(4 * 1024 * 1024, 7);
  const fd = fs.openSync(big, "w");
  for (let n = 0; n < BIG; n += chunk.length) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  fs.writeFileSync(path.join(ws, "small.txt"), "hello");
}

/**
 * Measure how long the event loop was blocked while `run` happened.
 *
 * A timer asked to fire in 10ms that fires 500ms late says the loop was blocked
 * for 490ms — which is exactly how long a tool call arriving at that moment
 * would have waited.
 *
 * The timer is scheduled BEFORE the work and read AFTER a turn of the loop, and
 * both halves matter. The first version used setInterval and cleared it as soon
 * as `run` resolved — but a synchronous body resolves in a MICROtask, and timers
 * are MACROtasks, so the interval was cleared before it had ever fired and every
 * measurement came back a confident 0ms. A meter that reads zero for a 300ms busy
 * loop is worse than no meter: it does not fail, it agrees with you.
 */
async function worstStall(run) {
  let firedAt = null;
  const scheduled = process.hrtime.bigint();
  const t = setTimeout(() => {
    firedAt = process.hrtime.bigint();
  }, 10);
  await run();
  // One turn of the loop, so a timer that came due during the work can run.
  await new Promise((r) => setTimeout(r, 0));
  clearTimeout(t);
  if (firedAt === null) return -1;
  return Math.max(0, Math.round(Number(firedAt - scheduled) / 1e6 - 10));
}

try {
  // The meter is checked against a known stall before it is trusted for the
  // measurement below. See the note above for why that is not paranoia.
  {
    const known = await worstStall(async () => {
      const end = Date.now() + 300;
      while (Date.now() < end);
    });
    assert.ok(known > 250, `the stall meter must see a 300ms block (saw ${known}ms)`);
    console.log(`  ok — the stall meter reads a known 300ms block as ${known}ms`);
  }

  // --- the old way: the copy happens on the daemon's own thread ---
  const inProcess = await worstStall(async () => {
    // Exactly what the in-process build did per file, and the reason it was a
    // problem: copyFileSync returns when the copy is done, not before.
    fs.copyFileSync(big, path.join(ws, "copy-inproc.bin"));
  });
  console.log(`  · copying 128MB in-process stalls the loop for ${inProcess}ms`);

  // --- the new way: a child does it ---
  const outDir = path.join(ws, "childout");
  const child = await worstStall(
    () =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "prebuild.mjs"), ws, outDir], {
          stdio: "ignore",
        });
        c.on("exit", resolve);
      })
  );
  console.log(`  · the same copy in a child stalls it for ${child}ms`);

  // The daemon must stay answerable. 50ms is the threshold because a tool call
  // that waits longer than that is a call the agent notices, and the point of
  // speculation is that nobody notices it.
  assert.ok(child < 50, `a child must not stall the daemon (${child}ms)`);
  assert.ok(
    inProcess > child * 3,
    `sanity: the in-process copy must be the one that hurts (in-process ${inProcess}ms vs child ${child}ms)`
  );
  console.log(`  ok — the copy no longer blocks the daemon: ${inProcess}ms → ${child}ms of worst-case stall`);

  // --- and the child really produced a usable shadow ---
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    assert.ok(manifest.startedAt > 0, "the manifest carries the stamp adoption is judged against");
    assert.ok("big.bin" in manifest.files && "small.txt" in manifest.files, "and every file it copied");
    assert.equal(
      fs.statSync(path.join(outDir, "tree", "big.bin")).size,
      BIG,
      "PHYSICAL: the shadow holds the whole file, not a truncated one"
    );
    console.log("  ok — the child's shadow is complete, with the stamp adoption depends on");
  }

  // --- a manifest appears only when the copy finished ---
  {
    const partial = path.join(ws, "partial");
    const c = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "prebuild.mjs"), ws, partial], {
      stdio: "ignore",
    });
    await sleep(120);
    c.kill("SIGKILL");
    await sleep(150);
    assert.ok(!fs.existsSync(path.join(partial, "manifest.json")), "a killed copy must not look finished");
    console.log("  ok — a killed copy leaves no manifest, so a partial tree can never be adopted");
  }

  // --- a tool call kills the copy outright, rather than asking it to stop ---
  {
    speculate.reset();
    speculate.windowOpen(ws);
    // LEAD_MS is 250 by default; wait past it, then let the copy get going.
    await sleep(700);
    const before = speculate.speculationStats();
    assert.equal(before.started, 1, "the window should have started a copy");

    speculate.windowClose();
    await sleep(200);
    const after = speculate.speculationStats();
    assert.equal(after.abandoned, 1, "a tool call abandons it");
    assert.equal(after.ready, false, "and nothing half-done is left offered as ready");
    console.log("  ok — a tool call kills the copy: instant and total, not a request to stop");
  }

  // --- under cgroups, the copy is marked as work that yields ---
  {
    const cg = cgroups.available();
    if (!cg.ok || !cgroups.ensure(`spc-probe-${process.pid}`).cpu) {
      cgroups.destroy(`spc-probe-${process.pid}`);
      console.log("  skip — cpu not delegated here, so priority cannot be checked (the child still isolates)");
    } else {
      cgroups.destroy(`spc-probe-${process.pid}`);
      speculate.reset();
      speculate.windowOpen(ws);
      await sleep(700);
      const s = speculate.speculationStats();
      assert.equal(s.background, true, "with cpu delegated the copy must run at background priority");
      speculate.windowClose();
      console.log("  ok — the copy runs under cpu.idle: it only gets the CPU nobody else wants");
    }
  }
} finally {
  speculate.windowClose();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("SPECULATE-CHILD TESTS PASSED");
