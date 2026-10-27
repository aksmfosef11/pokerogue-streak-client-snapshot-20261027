// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { gameVersion, runContract } from "./run-contract.mjs";

const base = process.env.PVP_TEST_URL ?? "http://localhost:8001";
async function request(path, token, body, expected = 200, includeContract = true) {
  if (path === "/pvp/runs" && body && includeContract) {
    body = { contract: runContract, ...body };
  }
  const res = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: token ?? "", "Content-Type": "application/json", "PKR-Client-Version": gameVersion },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.equal(res.status, expected, `${path}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
async function account() {
  const username = "pvp_" + randomBytes(4).toString("hex");
  const password = randomBytes(16).toString("hex");
  for (const action of ["register", "login"]) {
    const res = await fetch(base + "/account/" + action, {
      method: "POST",
      body: new URLSearchParams({ username, password }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    if (action === "login") {
      return { username, password, token: (await res.json()).token };
    }
  }
}
const a = await account();
const b = await account();
const c = await account();
const verified = await account();
writeFileSync("pvp-smoke-accounts.local", JSON.stringify({ verified: verified.username, flagged: c.username }));
const clientSessionId = "pvp-smoke-active-client";
const query = `?clientSessionId=${clientSessionId}`;
await request("/savedata/system/get" + query, c.token, undefined, 404);
const system = {
  trainerId: 1234,
  secretId: 5678,
  gameVersion,
  gameStats: { playTime: 1 },
  starterData: { 1: { candyCount: 0, valueReduction: 0, eggMoves: 0, passiveAttr: 0 } },
  dexData: {},
  eggs: [],
  appliedMigrators: {},
};
await request("/savedata/system/get" + query, verified.token, undefined, 404);
await request("/savedata/system/update" + query, verified.token, system, 204);
const starters = [{ speciesId: 1, passive: false, moveset: [33] }];
const savedBeforeContract = await request("/savedata/system/get" + query, verified.token);
const legacy = await request("/pvp/runs", verified.token, { version: gameVersion, starters }, 409, false);
assert.match(String(legacy), /검증 규칙.*새로고침/);
for (const change of [
  { auditPolicy: `${gameVersion}:retired-policy` },
  { rulesSHA256: "0".repeat(64) },
  { auditSchema: runContract.auditSchema + 1 },
  { harness: "other/audit.ts" },
]) {
  const rejected = await request(
    "/pvp/runs",
    verified.token,
    {
      version: gameVersion,
      starters,
      contract: { ...runContract, ...change },
    },
    409,
  );
  assert.match(String(rejected), /검증 규칙.*새로고침/);
}
const rejectedStatus = await request("/pvp/status", verified.token);
assert.equal(rejectedStatus.flags?.length ?? 0, 0);
assert.equal(Object.keys(rejectedStatus.runs ?? {}).length, 0, "incompatible requests must not issue a ranked seed");
assert.deepEqual(
  (await request("/savedata/system/get" + query, verified.token)).starterData,
  savedBeforeContract.starterData,
);
const ranked = await request("/pvp/runs", verified.token, { version: gameVersion, starters });
assert.ok(ranked.seed && ranked.identity.trainerId === system.trainerId);
assert.deepEqual(ranked.contract, runContract);
assert.deepEqual((await request("/pvp/status", verified.token)).runs[ranked.id].contract, runContract);
await request(
  "/pvp/runs",
  verified.token,
  { version: gameVersion, starters: [{ ...starters[0], passive: true }] },
  409,
);
for (const moveset of [[165], [0], [33, 33], [733]]) {
  await request("/pvp/runs", verified.token, { version: gameVersion, starters: [{ ...starters[0], moveset }] }, 409);
}
await request(
  "/pvp/runs",
  verified.token,
  { version: gameVersion, starters: [{ ...starters[0], formIndex: 999 }] },
  409,
);
await request("/pvp/runs", verified.token, { version: "unsupported", starters }, 409);
await request(
  "/pvp/runs",
  verified.token,
  { version: gameVersion, starters: [1, 4, 7, 25].map(speciesId => ({ speciesId, moveset: [] })) },
  409,
);
await request("/savedata/system/update" + query, c.token, system, 204);
system.starterData[1].valueReduction = 1;
await request("/savedata/system/update" + query, c.token, system, 204);
assert.ok((await request("/pvp/status", c.token)).flags.includes("candy-purchase-mismatch"));
assert.equal((await request("/savedata/system/get" + query, c.token)).starterData[1].valueReduction, 1);
system.starterData[1].eggMoves = 15;
system.gameStats.playTime++;
await request("/savedata/updateall", c.token, {
  clientSessionId,
  sessionSlotId: 0,
  system,
  session: {
    playTime: 1,
    gameVersion,
    party: [],
    enemyParty: [],
    modifiers: [],
    enemyModifiers: [],
    money: 0,
    battleType: 0,
    gameMode: 1,
    waveIndex: 1,
    seed: "pvp-smoke-nonclassic",
  },
});
assert.ok((await request("/pvp/status", c.token)).flags.includes("egg-move-hatch-bound"));
await request("/pvp/status", undefined, undefined, 401);
const m = await request("/pvp/matches", a.token, { practice: true });
assert.equal(m.session.battleType, 1);
assert.notEqual(m.session.party[0].id, m.session.enemyParty[0].id);
for (const p of [...m.session.party, ...m.session.enemyParty]) {
  assert.deepEqual(p.ivs, [31, 31, 31, 31, 31, 31]);
}
assert.equal((await request("/pvp/matches", a.token, { practice: true })).id, m.id);
const d = {
  matchId: m.id,
  index: 0,
  kind: "turn",
  digest: "a".repeat(64),
  choice: { command: { command: 0, cursor: 0 } },
};
await request("/pvp/commit", b.token, d, 409);
const first = await request("/pvp/commit", a.token, d);
const attempts = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    request("/pvp/commit", a.token, { ...d, choice: { command: { command: 0, cursor: i % 4 } } }),
  ),
);
for (const other of attempts) {
  assert.equal(other.seed, first.seed);
  assert.deepEqual(other.choice, first.choice);
}
assert.equal((await request("/pvp/status", a.token)).match.decisions.length, 1);
await request("/pvp/commit", a.token, { ...d, index: 2 }, 409);
await request("/pvp/commit", a.token, { ...d, digest: "b".repeat(64) }, 409);
assert.equal((await request("/pvp/status", a.token)).match.status, "invalid");
const second = await request("/pvp/matches", a.token, { practice: true });
await request("/pvp/commit", a.token, { ...d, matchId: second.id });
const result = { matchId: second.id, result: "won", index: 1, playerHP: [100, 100, 100], enemyHP: [0, 0, 0] };
await request("/pvp/finish", a.token, result);
await request("/pvp/finish", a.token, result);
const status = await request("/pvp/status", a.token);
assert.equal(status.practiceStreak, 1);
assert.equal(status.streak, 0);
await request("/pvp/matches", a.token, { practice: false }, 409);
const third = await request("/pvp/matches", a.token, { practice: true });
await request("/pvp/commit", a.token, { ...d, matchId: third.id });
await request("/pvp/commit", a.token, { ...d, matchId: third.id, digest: "b".repeat(64) }, 409);
const invalidated = await request("/pvp/status", a.token);
assert.equal(invalidated.match.status, "invalid");
assert.equal(invalidated.practiceStreak, 0);
assert.equal(invalidated.practiceBest, 1);
if (process.env.PVP_UPDATE_FIXTURES === "1") {
  mkdirSync("test/fixtures/pvp", { recursive: true });
  writeFileSync("test/fixtures/pvp/session.json", JSON.stringify(second.session, null, 2) + "\n");
}
console.log(
  "PASS: ranked policy/rules/schema/harness handshake and legacy rejection without account flag, trusted starter/form/move allowlist, both save validators accept/soft-flag, auth, owner isolation, normalized trainer session, 8 concurrent first-write attempts, replay divergence, sequence validation, idempotent result, practice/ranked separation",
);
// Only local test credentials; do not print auth tokens into build logs.
if (process.env.PVP_UI_ACCOUNT_FILE) {
  writeFileSync(process.env.PVP_UI_ACCOUNT_FILE, JSON.stringify(b));
}
