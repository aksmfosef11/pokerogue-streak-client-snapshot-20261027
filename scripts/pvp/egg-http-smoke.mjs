// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gameVersion, runContract } from "./run-contract.mjs";

const base = process.env.PVP_TEST_URL ?? "http://localhost:8000/api";
const compose = resolve(process.env.PVP_COMPOSE_FILE ?? "../compose.pvp.yml");
const auditService = process.env.PVP_AUDIT_SERVICE ?? "audit";
const username = `pvp_${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
let token;
const headers = () => ({
  Authorization: token ?? "",
  "Content-Type": "application/json",
  "PKR-Client-Version": gameVersion,
});
async function request(path, body, expected = 200) {
  if (path === "/pvp/runs" && body) {
    body = { contract: runContract, ...body };
  }
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${path}: ${text}`);
  if (!text) {
    return;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function docker(args) {
  const child = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (child.status !== 0) {
    throw new Error(`Docker integration command failed: ${child.stderr || child.stdout}`);
  }
  return child.stdout.trim();
}
for (const action of ["register", "login"]) {
  const r = await fetch(`${base}/account/${action}`, {
    method: "POST",
    body: new URLSearchParams({ username, password }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  if (action === "login") {
    token = (await r.json()).token;
  }
}
const clientSessionId = `egg-proof-${randomBytes(6).toString("hex")}`;
const query = `?clientSessionId=${clientSessionId}`;
await request("/savedata/system/get" + query, undefined, 404);
const system = {
  trainerId: 1234,
  secretId: 5678,
  gameVersion,
  gameStats: { playTime: 1 },
  starterData: { 1: { candyCount: 100 } },
  dexData: {},
  eggs: [],
  appliedMigrators: {},
};
await request("/savedata/system/update" + query, system, 204);
const session = wave => ({
  seed: "local-egg-proof-smoke",
  waveIndex: wave,
  gameVersion,
  gameMode: 1,
  playTime: wave,
  party: [],
  enemyParty: [],
  modifiers: [],
  enemyModifiers: [],
  money: 0,
  battleType: 0,
});
await request("/savedata/updateall", { clientSessionId, sessionSlotId: 0, system, session: session(1) });
docker([
  "compose",
  "-f",
  compose,
  "exec",
  "-T",
  "server",
  "/app/pvp-admin",
  "approve-baseline",
  "-operator",
  "integration-test",
  "-reason",
  "Generated local egg ticket integration baseline",
  username,
]);
const reviewedAt = Date.now();
const issued = await request("/pvp/egg-tickets", {});
assert.equal(issued.tickets.length, 64);
const again = await request("/pvp/egg-tickets", {});
assert.equal(again.tickets[0].seed, issued.tickets[0].seed, "prefetch must not reroll unused tickets");
const dir = await mkdtemp(join(tmpdir(), "pvp-egg-http-"));
if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith("pvp-egg-http-")) {
  throw new Error("unexpected temporary directory");
}
const container = docker(["compose", "-f", compose, "ps", "-q", auditService]);
const remote = `/tmp/egg-http-${randomBytes(6).toString("hex")}`;
let stopped = false;
try {
  const input = join(dir, "input.json");
  const output = join(dir, "output.json");
  await writeFile(input, JSON.stringify({ ticket: issued.tickets[0], system }));
  docker(["cp", input, `${container}:${remote}-input.json`]);
  docker([
    "compose",
    "-f",
    compose,
    "exec",
    "-T",
    "-e",
    `PVP_EGG_PRODUCER_INPUT=${remote}-input.json`,
    "-e",
    `PVP_EGG_PRODUCER_OUTPUT=${remote}-output.json`,
    "-e",
    "NODE_ENV=test",
    auditService,
    "node",
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "scripts/pvp/audit.config.ts",
    "--silent",
  ]);
  docker(["cp", `${container}:${remote}-output.json`, output]);
  const produced = JSON.parse(await readFile(output, "utf8"));
  if (process.env.PVP_EGG_OUTAGE === "1") {
    docker(["compose", "-f", compose, "stop", auditService]);
    stopped = true;
  }
  await request("/savedata/system/update" + query, produced.created, 204);
  const starters = [{ speciesId: produced.species, formIndex: 0, passive: false, moveset: [produced.move] }];
  await request("/pvp/runs", { version: gameVersion, starters }, 409);
  if (stopped) {
    const wait = Math.max(0, 11000 - (Date.now() - reviewedAt));
    if (wait) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    await request("/savedata/updateall", {
      clientSessionId,
      sessionSlotId: 0,
      system: produced.hatched,
      session: session(11),
    });
    assert.ok((await request("/pvp/status")).eggVerification.pendingJobs > 0);
    await request("/pvp/runs", { version: gameVersion, starters }, 409);
    docker(["compose", "-f", compose, "start", auditService]);
    stopped = false;
    docker(["compose", "-f", compose, "restart", "server"]);
    const readyBy = Date.now() + 15000;
    while (Date.now() < readyBy) {
      try {
        if ((await fetch(`${base}/health`)).ok) {
          break;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const deadline = Date.now() + 90000;
  let verified = false;
  while (Date.now() < deadline) {
    const state = await request("/pvp/status");
    assert.ok(!state.flags?.length, JSON.stringify(state.flags));
    const pool = await request("/pvp/egg-tickets", {});
    if (
      pool.certifiedIds.includes(produced.eggId)
      || (process.env.PVP_EGG_OUTAGE === "1" && state.eggVerification.pendingJobs === 0)
    ) {
      verified = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(verified, "actual engine did not verify the queued egg");
  const minimumWait = Math.max(0, 11000 - (Date.now() - reviewedAt));
  if (minimumWait) {
    await new Promise(resolve => setTimeout(resolve, minimumWait));
  }
  if (process.env.PVP_EGG_OUTAGE !== "1") {
    await request("/savedata/updateall", {
      clientSessionId,
      sessionSlotId: 0,
      system: produced.hatched,
      session: session(11),
    });
  }
  assert.ok(!(await request("/pvp/status")).flags?.length);
  const run = await request("/pvp/runs", { version: gameVersion, starters });
  assert.ok(run.seed);
  const replay = { ...produced.hatched, pvpEggProofs: [produced.receipt] };
  await request("/savedata/system/update" + query, replay, 204);
  assert.ok(!(await request("/pvp/status")).flags?.length, "idempotent receipt was rejected");
  replay.pvpEggProofs[0].egg.eggMoveIndex = (replay.pvpEggProofs[0].egg.eggMoveIndex + 1) % 4;
  await request("/savedata/system/update" + query, replay, 204);
  assert.ok((await request("/pvp/status")).flags.includes("egg-ticket-reused"));
  assert.equal((await request("/savedata/system/get" + query)).starterData[produced.species].eggMoves, produced.mask);
  console.log(
    JSON.stringify({
      passed: true,
      username,
      propertiesReproduced: true,
      hatchTrustedOnce: true,
      rankedStarterAccepted: true,
      reuseSoftFlagged: true,
      ordinarySaveRetained: true,
      recoveredAfterHatch: process.env.PVP_EGG_OUTAGE === "1",
      recoveredAfterServerRestart: process.env.PVP_EGG_OUTAGE === "1",
    }),
  );
} finally {
  if (stopped) {
    docker(["compose", "-f", compose, "start", auditService]);
  }
  docker([
    "compose",
    "-f",
    compose,
    "exec",
    "-T",
    auditService,
    "node",
    "-e",
    'const fs=require("fs");for(const p of process.argv.slice(1))fs.rmSync(p,{force:true});',
    `${remote}-input.json`,
    `${remote}-output.json`,
  ]);
  await rm(dir, { recursive: true, force: true });
}
