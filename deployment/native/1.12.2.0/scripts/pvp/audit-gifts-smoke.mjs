// SPDX-License-Identifier: AGPL-3.0-only
// Read-only private HTTP controls. Prints results, never bridge credentials.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const base = process.env.PVP_AUDIT_SMOKE_URL || "http://localhost:8002";
const fixtureDir = process.env.PVP_AUDIT_FIXTURE_DIR || "test/fixtures/pvp";
const manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const decode = log => JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")));
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
for (const name of ["normal-trade", "avarice-gift", "avarice-return"]) {
  const fixture = JSON.parse(await readFile(`${fixtureDir}/audit-${name}-run.json`, "utf8"));
  assert.equal(fixture.run.version, manifest.version, "use native fixtures for this worker's actual version");
  fixture.manifest = manifest;
  const index = fixture.logs.findIndex(log => {
    const f = decode(log);
    return name === "normal-trade"
      ? f.captures.some(c => c.outgoing !== undefined)
      : f.generated.mysteryEncounterType === 16;
  });
  assert.ok(index >= 0, name);
  const valid = await verify(fixture);
  assert.equal(valid.ok, true, JSON.stringify({ name, ...valid }));
  for (const flag of ["partyVerified", "inventoryVerified", "formItemsVerified", "levelsVerified", "moneyVerified"]) {
    assert.equal(valid[flag], true, flag);
  }
  console.log(JSON.stringify({ case: name, wave: index + 1, valid }));
  const controls =
    name === "normal-trade"
      ? [
          [
            "invented offered species",
            f => {
              f.captures[0].pokemon.species = 150;
            },
          ],
          [
            "reused consumed individual",
            f => {
              f.captures.push(structuredClone(f.captures[0]));
            },
          ],
          [
            "unpaid held-item relocation",
            f => {
              const outgoing = f.captures[0].outgoing;
              for (const item of f.items.filter(i => i.kind === "state")) {
                item.changes = item.changes.filter(c => !(c.delta < 0 && c.data.args[0] === outgoing));
              }
            },
          ],
        ]
      : [
          [
            "kept stolen berries",
            (f, input) => {
              for (const item of f.items.filter(i => i.kind === "state")) {
                item.changes = item.changes.filter(c => !(c.delta < 0 && c.data.className === "BerryModifier"));
              }
              const next = decode(input.logs[index + 1]);
              next.generation.basis.modifiers.push(
                ...structuredClone(f.generation.basis.modifiers.filter(m => m.className === "BerryModifier")),
              );
              input.logs[index + 1].payload = `gz:${gzipSync(JSON.stringify(next)).toString("base64")}`;
            },
          ],
          name === "avarice-gift"
            ? [
                "invented gift identity",
                f => {
                  f.captures[0].pokemon.id = (f.captures[0].pokemon.id + 1) >>> 0;
                },
              ]
            : [
                "excess returned berries",
                f => {
                  f.items.find(i => i.kind === "acquire").data.stackCount += 20;
                },
              ],
        ];
  for (const [control, mutate] of controls) {
    const input = structuredClone(fixture);
    const frame = decode(input.logs[index]);
    mutate(frame, input);
    input.logs[index].payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
    const result = await verify(input);
    assert.equal(result.ok, false, control);
    assert.match(
      result.reason,
      /party provenance|item provenance|capture has no reproduced individual|trade gift has no reproduced outgoing individual/,
    );
    console.log(JSON.stringify({ case: `${name}: ${control}`, rejected: result.reason }));
  }
}
console.log(JSON.stringify({ passed: true, version: manifest.version, policy, native200WaveCases: 3, tamperCases: 7 }));
