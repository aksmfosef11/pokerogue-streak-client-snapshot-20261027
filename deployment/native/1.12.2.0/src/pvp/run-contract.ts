// SPDX-License-Identifier: AGPL-3.0-only
import auditPolicy from "./audit-policy.json";
import rulesManifest from "./rules-manifest.json";

export const runContract = Object.freeze({
  auditPolicy: auditPolicy.policy,
  rulesSHA256: rulesManifest.rulesSHA256,
  auditSchema: rulesManifest.auditSchema,
  harness: rulesManifest.harness,
});
export type RunContract = typeof runContract;

export function matchesRunContract(value: unknown): value is RunContract {
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(runContract).every(([key, expected]) => Reflect.get(value, key) === expected);
}
