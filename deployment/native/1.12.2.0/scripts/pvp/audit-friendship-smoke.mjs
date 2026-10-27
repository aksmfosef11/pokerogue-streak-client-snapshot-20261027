// SPDX-License-Identifier: AGPL-3.0-only
// Private verifier controls; does not register a team or change account data.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const fixture = JSON.parse(await readFile("test/fixtures/pvp/audit-run.json", "utf8"));
fixture.manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const base = process.env.PVP_AUDIT_SMOKE_URL || "http://localhost:8002";
async function verify(input) {
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
}
function frame(log) {
  return JSON.parse(
    log.payload.startsWith("gz:") ? gunzipSync(Buffer.from(log.payload.slice(3), "base64")).toString() : log.payload,
  );
}
function alter(input, index, change) {
  const value = frame(input.logs[index]);
  change(value);
  input.logs[index].payload = `gz:${gzipSync(JSON.stringify(value)).toString("base64")}`;
}
const valid = await verify(fixture);
assert.equal(valid.ok, true, JSON.stringify(valid));
for (const proof of ["partyVerified", "inventoryVerified", "formItemsVerified", "levelsVerified", "moneyVerified"]) {
  assert.equal(valid[proof], true);
}
const captureIndex = fixture.logs.findIndex(log => frame(log).captures.length > 0);
assert.ok(captureIndex >= 0);
const rejected = [];
for (const [name, change] of [
  [
    "initial friendship",
    input =>
      alter(input, 0, value => {
        value.generation.basis.party[0].friendship = 255;
      }),
  ],
  [
    "checkpoint friendship",
    input =>
      alter(input, 1, value => {
        value.generation.basis.party[0].friendship = 255;
      }),
  ],
  [
    "capture friendship",
    input =>
      alter(input, captureIndex, value => {
        value.captures[0].pokemon.friendship = 255;
      }),
  ],
  [
    "candidate friendship",
    input => {
      input.run.candidate.party[0].friendship = 255;
    },
  ],
]) {
  const changed = structuredClone(fixture);
  change(changed);
  const result = await verify(changed);
  assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`);
  assert.match(result.reason, /friendship/);
  rejected.push({ name, reason: result.reason });
}
console.log(JSON.stringify({ passed: true, gameVersion: fixture.manifest.version, valid, rejected }));
