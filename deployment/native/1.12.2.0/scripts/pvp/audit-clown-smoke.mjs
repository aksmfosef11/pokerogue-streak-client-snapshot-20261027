// SPDX-License-Identifier: AGPL-3.0-only
// Execute inside the isolated audit container. Never prints bridge credentials.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const base = process.env.PVP_AUDIT_SMOKE_URL || "http://localhost:8002";
const fixture = JSON.parse(await readFile("test/fixtures/pvp/audit-clown-run.json", "utf8"));
fixture.manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
const decode = log => JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")));
const encode = (input, index, frame) => {
  input.logs[index].payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
};
const index = fixture.logs.findIndex(log => decode(log).encounterChoice?.option === 2);
assert.ok(index >= 0 && index < 199, "requires the native Clown type option and its next checkpoint");
assert.equal(decode(fixture.logs[index]).generated.mysteryEncounterType, 20);
assert.ok(fixture.run.candidate.party.every(p => p.customPokemonData.types[1] != null));
const verify = async data => {
  const response = await fetch(`${base}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
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
console.log(JSON.stringify({ case: "native 200-wave Clown type shuffle", result: valid }));
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
  "missingSelection",
  input => {
    const frame = decode(input.logs[index]);
    Reflect.deleteProperty(frame, "encounterChoice");
    encode(input, index, frame);
  },
  /permanent types changed without a source/,
);
await tamper(
  "wrongOption",
  input => {
    const frame = decode(input.logs[index]);
    frame.encounterChoice.option = 0;
    encode(input, index, frame);
  },
  /permanent types changed without a source/,
);
await tamper(
  "unearnedPriorityMove",
  input => {
    const frame = decode(input.logs[index]);
    frame.encounterChoice.party[0].moveset[0].moveId = 147;
    encode(input, index, frame);
  },
  /no legal learning source/,
);
await tamper(
  "partialShuffle",
  input => {
    const before = decode(input.logs[index]).encounterChoice.party;
    const next = decode(input.logs[index + 1]);
    next.generation.basis.party[1].customPokemonData.types = before[1].customPokemonData.types;
    encode(input, index + 1, next);
  },
  /entire selected party/,
);
await tamper(
  "inventedNativeType",
  input => {
    const next = decode(input.logs[index + 1]);
    const types = next.generation.basis.party[0].customPokemonData.types;
    types[1] = (types[1] + 1) % 18;
    encode(input, index + 1, next);
  },
  /permanent types changed without a source/,
);
await tamper(
  "lateTypeChange",
  input => {
    const types = input.run.candidate.party[0].customPokemonData.types;
    types[1] = (types[1] + 1) % 18;
  },
  /permanent types changed without a source/,
);
console.log(
  JSON.stringify({
    passed: true,
    valid,
    rejected,
    wave: index + 1,
    compressedBytes: Buffer.byteLength(JSON.stringify(fixture.logs)),
  }),
);
