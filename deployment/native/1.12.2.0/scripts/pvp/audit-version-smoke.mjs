// SPDX-License-Identifier: AGPL-3.0-only
// Execute in each native worker, naming the other worker through its private URL.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const other = process.env.PVP_OTHER_AUDIT_URL;
assert.ok(other, "PVP_OTHER_AUDIT_URL must name a different native version");
const fixture = JSON.parse(await readFile("test/fixtures/pvp/audit-run.json", "utf8"));
const manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
assert.equal(fixture.run.version, manifest.version, "fixture must be produced by this native release");
fixture.manifest = manifest;
const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const response = await fetch(`${other}/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify(fixture),
  signal: AbortSignal.timeout(310000),
});
const result = await response.json();
assert.equal(response.status, 200, JSON.stringify(result));
assert.equal(result.ok, false, "another native engine must never certify this run");
assert.notEqual(result.policy, policy, "the other worker must report its own version policy");
assert.match(result.reason, /version|manifest/i);
console.log(
  JSON.stringify({
    passed: true,
    submittedVersion: manifest.version,
    workerPolicy: result.policy,
    reason: result.reason,
  }),
);
