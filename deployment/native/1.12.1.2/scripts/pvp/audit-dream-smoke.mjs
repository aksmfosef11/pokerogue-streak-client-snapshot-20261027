// SPDX-License-Identifier: AGPL-3.0-only
// Execute inside the isolated audit container; never prints its private key.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const base = process.env.PVP_AUDIT_SMOKE_URL || "http://localhost:8002";
const fixture = JSON.parse(await readFile("test/fixtures/pvp/audit-dream-run.json", "utf8"));
fixture.manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
const decode = log => JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")).toString("utf8"));
const index = fixture.logs.findIndex(log => {
  const f = decode(log);
  return f.generated.mysteryEncounterType === 23 && f.captures.length >= 3;
});
assert.ok(index >= 0, "fixture must contain the original whole-party transformation");
const source = decode(fixture.logs[index]);
assert.ok(
  source.captures.some(c => c.pokemon.moveset.some(m => m.ppUp > 0)),
  "must inherit a previously selected PP Up",
);
assert.ok(source.captures.every(c => c.pokemon.customPokemonData.types.length === 2));
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
console.log(JSON.stringify({ case: "native 200-wave Weird Dream", result: valid }));
const rejected = {};
const changedFrame = async (name, change, pattern) => {
  const input = structuredClone(fixture);
  const frame = decode(input.logs[index]);
  change(frame, input);
  input.logs[index].payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
  const result = await verify(input);
  assert.equal(result.ok, false, name);
  assert.match(result.reason, pattern, name);
  rejected[name] = result.reason;
  console.log(JSON.stringify({ case: name, rejected: result.reason }));
};
await changedFrame(
  "inventedBirthType",
  frame => {
    const types = frame.captures[0].pokemon.customPokemonData.types;
    types[1] = (types[1] + 1) % 18;
  },
  /capture permanent types/,
);
await changedFrame(
  "partialReplacement",
  frame => {
    frame.captures.pop();
  },
  /unknown or retired|entire original party/,
);
await changedFrame(
  "wrongOutgoing",
  frame => {
    frame.captures[0].outgoing = frame.captures[1].outgoing;
  },
  /no reproduced outgoing/,
);
await changedFrame(
  "unpaidRelocation",
  frame => {
    const outgoing = frame.captures[0].outgoing;
    assert.ok(
      frame.items.some(
        item => item.kind === "state" && item.changes.some(c => c.delta < 0 && c.data.args[0] === outgoing),
      ),
    );
    for (const item of frame.items.filter(item => item.kind === "state")) {
      item.changes = item.changes.filter(c => !(c.delta < 0 && c.data.args[0] === outgoing));
    }
  },
  /discarded source items/,
);
await changedFrame(
  "extraInheritedPp",
  frame => {
    frame.captures.flatMap(c => c.pokemon.moveset).find(m => m.ppUp > 0).ppUp++;
  },
  /unverified PP Ups/,
);
await changedFrame(
  "lateTypeChange",
  (_frame, input) => {
    const types = input.run.candidate.party[0].customPokemonData.types;
    types[1] = (types[1] + 1) % 18;
  },
  /permanent types changed/,
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
