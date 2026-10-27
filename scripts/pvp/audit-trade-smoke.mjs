// SPDX-License-Identifier: AGPL-3.0-only
// Run inside the audit container. Never prints the private bridge credential.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const base = process.env.PVP_AUDIT_SMOKE_URL || "http://localhost:8002";
const fixture = JSON.parse(await readFile("test/fixtures/pvp/audit-trade-run.json", "utf8"));
fixture.manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
const decode = log => JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")).toString("utf8"));
const index = fixture.logs.findIndex(log => decode(log).captures.some(capture => capture.outgoing !== undefined));
assert.ok(index >= 0, "fixture must execute a native Pokemon trade");
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
for (const proof of ["partyVerified", "inventoryVerified", "formItemsVerified", "levelsVerified", "moneyVerified"]) {
  assert.equal(valid[proof], true, proof);
}
console.log(JSON.stringify({ case: "native 200-wave Wonder Trade", result: valid }));
const rejected = {};
for (const [name, change, reason] of [
  [
    "missingOutgoing",
    frame => {
      Reflect.deleteProperty(
        frame.captures.find(c => c.outgoing !== undefined),
        "outgoing",
      );
    },
    /ambiguous outgoing/,
  ],
  [
    "wrongOutgoing",
    frame => {
      const capture = frame.captures.find(c => c.outgoing !== undefined);
      capture.outgoing = frame.generation.basis.party.find(p => p.id !== capture.outgoing).id;
    },
    /captured level|unknown or retired|trade passive/,
  ],
  [
    "unpaidRelocation",
    frame => {
      const outgoing = frame.captures.find(c => c.outgoing !== undefined).outgoing;
      for (const item of frame.items.filter(item => item.kind === "state")) {
        item.changes = item.changes.filter(change => !(change.delta < 0 && change.data.args[0] === outgoing));
      }
    },
    /discarded source items/,
  ],
  [
    "inventedMove",
    frame => {
      frame.captures.find(c => c.outgoing !== undefined).pokemon.moveset[0].moveId = 147;
    },
    /captured moves/,
  ],
  [
    "duplicateGift",
    frame => {
      frame.captures.push(structuredClone(frame.captures.find(c => c.outgoing !== undefined)));
    },
    /too many direct gifts/,
  ],
]) {
  const changed = structuredClone(fixture);
  const frame = decode(changed.logs[index]);
  change(frame);
  changed.logs[index].payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
  const result = await verify(changed);
  assert.equal(result.ok, false, name);
  assert.match(result.reason, reason, name);
  rejected[name] = result.reason;
  console.log(JSON.stringify({ case: name, rejected: result.reason }));
}
console.log(
  JSON.stringify({
    passed: true,
    valid,
    rejected,
    wave: index + 1,
    compressedBytes: Buffer.byteLength(JSON.stringify(fixture.logs)),
  }),
);
