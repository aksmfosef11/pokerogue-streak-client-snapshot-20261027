// SPDX-License-Identifier: AGPL-3.0-only
// Run inside the private audit container. Never prints its credential.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const base = process.env.PVP_AUDIT_SMOKE_URL || "http://localhost:8002";
const fixture = JSON.parse(await readFile("test/fixtures/pvp/audit-money-run.json", "utf8"));
fixture.manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
const decode = log => JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")));
const encode = (input, index, frame) => {
  input.logs[index].payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
};
const verify = async input => {
  const response = await fetch(`${base}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(310000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.policy, policy);
  return result;
};
const valid = await verify(fixture);
assert.equal(valid.ok, true, JSON.stringify(valid));
for (const flag of ["partyVerified", "inventoryVerified", "formItemsVerified", "levelsVerified", "moneyVerified"]) {
  assert.equal(valid[flag], true, flag);
}
console.log(JSON.stringify({ case: "native 200-wave income and paid reroll", result: valid }));
const rerollIndex = fixture.logs.findIndex(log => decode(log).shops.some(s => s.kind === "offer" && s.rerolls > 0));
assert.ok(rerollIndex >= 0);
assert.equal(decode(fixture.logs[0]).money, 1000);
assert.ok(fixture.run.candidate.modifiers.some(m => m.typeId === "AMULET_COIN" && m.stackCount > 0));
const rejected = {};
const tamper = async (name, change, pattern) => {
  const input = structuredClone(fixture);
  change(input);
  const result = await verify(input);
  assert.equal(result.ok, false, name);
  assert.match(result.reason, pattern, name);
  rejected[name] = result.reason;
  console.log(JSON.stringify({ case: name, rejected: result.reason }));
};
await tamper(
  "startingMoney",
  input => {
    const frame = decode(input.logs[0]);
    frame.money = 1001;
    frame.generation.basis.money = 1001;
    encode(input, 0, frame);
  },
  /money provenance: starting money/,
);
await tamper(
  "extraFirstWaveIncome",
  input => {
    const frame = decode(input.logs[1]);
    frame.money = ++frame.generation.basis.money;
    encode(input, 1, frame);
  },
  /money provenance: increase has no verified income source/,
);
await tamper(
  "unpaidReroll",
  input => {
    const frame = decode(input.logs[rerollIndex]);
    frame.shops.find(s => s.kind === "offer" && s.rerolls > 0).session.money++;
    encode(input, rerollIndex, frame);
  },
  /money provenance: reroll fee was not paid/,
);
await tamper(
  "extraCandidateIncome",
  input => {
    input.run.candidate.money++;
  },
  /money provenance: increase has no verified income source/,
);
await tamper(
  "unsafeCandidateMoney",
  input => {
    input.run.candidate.money = Number.MAX_SAFE_INTEGER + 1;
  },
  /money provenance: invalid native wallet amount/,
);
console.log(
  JSON.stringify({
    passed: true,
    valid,
    rejected,
    seed: fixture.run.seed,
    rerollWave: rerollIndex + 1,
    initialMoney: decode(fixture.logs[0]).money,
    finalMoney: fixture.run.candidate.money,
    compressedBytes: Buffer.byteLength(JSON.stringify(fixture.logs)),
  }),
);
