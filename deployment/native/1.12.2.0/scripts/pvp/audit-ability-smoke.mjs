// SPDX-License-Identifier: AGPL-3.0-only
// Run inside the private audit container. Never prints its credential.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const base = process.env.PVP_AUDIT_SMOKE_URL || "http://localhost:8002";
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
const manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const decode = log => JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")));
const encode = (input, index, frame) => {
  input.logs[index].payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
};
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
for (const name of ["clown-ability", "fiery"]) {
  const fixture = JSON.parse(await readFile(`test/fixtures/pvp/audit-${name}-run.json`, "utf8"));
  fixture.manifest = manifest;
  const type = name === "fiery" ? 11 : 20;
  const index = fixture.logs.findIndex(log => {
    const f = decode(log);
    return f.encounterChoice && f.generated.mysteryEncounterType === type;
  });
  assert.ok(index >= 0 && index < 199);
  const owner = fixture.run.candidate.party.find(p => p.customPokemonData.ability >= 0);
  assert.ok(owner);
  const valid = await verify(fixture);
  assert.equal(valid.ok, true, JSON.stringify(valid));
  for (const flag of ["partyVerified", "inventoryVerified", "formItemsVerified", "levelsVerified", "moneyVerified"]) {
    assert.equal(valid[flag], true, flag);
  }
  console.log(JSON.stringify({ name, case: "native 200-wave ability", result: valid }));
  const rejected = {};
  const tamper = async (label, change, pattern) => {
    const input = structuredClone(fixture);
    change(input);
    const result = await verify(input);
    assert.equal(result.ok, false, `${name}:${label}`);
    assert.match(result.reason, pattern, label);
    rejected[label] = result.reason;
    console.log(JSON.stringify({ name, case: label, rejected: result.reason }));
  };
  await tamper(
    "missingSelection",
    input => {
      const f = decode(input.logs[index]);
      Reflect.deleteProperty(f, "encounterChoice");
      encode(input, index, f);
    },
    /permanent ability.*source/,
  );
  await tamper(
    "wrongOption",
    input => {
      const f = decode(input.logs[index]);
      f.encounterChoice.option = name === "fiery" ? 0 : 1;
      encode(input, index, f);
    },
    /permanent ability.*source/,
  );
  await tamper(
    "unofferedAbility",
    input => {
      const f = decode(input.logs[index + 1]);
      f.generation.basis.party.find(p => p.id === owner.id).customPokemonData.ability = 25;
      encode(input, index + 1, f);
    },
    /permanent ability.*source/,
  );
  await tamper(
    "extraOwner",
    input => {
      const f = decode(input.logs[index + 1]);
      f.generation.basis.party.find(p => p.id !== owner.id).customPokemonData.ability = owner.customPokemonData.ability;
      encode(input, index + 1, f);
    },
    /permanent ability.*source/,
  );
  await tamper(
    "lateAbilityChange",
    input => {
      input.run.candidate.party.find(p => p.id === owner.id).customPokemonData.ability = 25;
    },
    /permanent ability.*source/,
  );
  await tamper(
    "inventedPassive",
    input => {
      input.run.candidate.party[0].customPokemonData.passive = 5;
    },
    /custom passive.*source/,
  );
  console.log(
    JSON.stringify({
      passed: true,
      name,
      valid,
      rejected,
      wave: index + 1,
      ability: owner.customPokemonData.ability,
      compressedBytes: Buffer.byteLength(JSON.stringify(fixture.logs)),
    }),
  );
}
