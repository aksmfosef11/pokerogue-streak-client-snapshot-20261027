// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync(new URL("../../src/pvp/audit-policy.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../../src/pvp/rules-manifest.json", import.meta.url), "utf8"));
export const gameVersion = manifest.version;
export const runContract = {
  auditPolicy: policy.policy,
  rulesSHA256: manifest.rulesSHA256,
  auditSchema: manifest.auditSchema,
  harness: manifest.harness,
};
