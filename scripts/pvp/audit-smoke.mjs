// SPDX-License-Identifier: AGPL-3.0-only
// Run inside the audit container; prints metrics, never the bridge credential.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const base = process.env.PVP_AUDIT_SMOKE_URL || "http://localhost:8002";
const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
const token = createHmac("sha256", key).update("pvp-audit-v1").digest("hex");
const fixture = JSON.parse(await readFile(process.env.PVP_AUDIT_FIXTURE || "test/fixtures/pvp/audit-run.json", "utf8"));
fixture.manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const policy = JSON.parse(await readFile("src/pvp/audit-policy.json", "utf8")).policy;
const verify = async data => {
  const response = await fetch(`${base}/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(310000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.policy, policy, "worker policy mismatch, including rejection results");
  return result;
};
assert.equal((await fetch(`${base}/verify`, { method: "POST", body: "{}" })).status, 401);
const valid = await verify(fixture);
assert.equal(valid.ok, true, JSON.stringify(valid));
assert.equal(valid.policy, policy);
assert.equal(valid.partyVerified, true, "party provenance was not verified");
assert.equal(valid.inventoryVerified, true, "inventory provenance was not verified");
assert.equal(valid.formItemsVerified, true, "form-item ownership was not verified");
assert.equal(valid.levelsVerified, true, "earned level budget was not verified");
assert.equal(valid.moneyVerified, true, "native income budget was not verified");
assert.ok(fixture.run.candidate?.party.length, "the positive control must include a clear candidate");
const changed = structuredClone(fixture);
const log = changed.logs[1];
const frame = JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")).toString("utf8"));
frame.generated.enemyParty[0].species = 150;
log.payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
const invalid = await verify(changed);
assert.equal(invalid.ok, false);
assert.match(invalid.reason, /wave 2: generated encounter mismatch/);
const malformed = structuredClone(fixture);
const brokenFrame = JSON.parse(gunzipSync(Buffer.from(malformed.logs[1].payload.slice(3), "base64")).toString("utf8"));
brokenFrame.generation.basis.party[0].moveset = [null];
malformed.logs[1].payload = `gz:${gzipSync(JSON.stringify(brokenFrame)).toString("base64")}`;
const rejectedInput = await verify(malformed);
assert.equal(rejectedInput.ok, false);
assert.match(rejectedInput.reason, /invalid audit input: party\[0\].moveset\[0\]/);
const badCandidate = structuredClone(fixture);
badCandidate.run.candidate = { party: structuredClone(brokenFrame.generation.basis.party) };
badCandidate.run.candidate.party[0].species = 999999;
const rejectedCandidate = await verify(badCandidate);
assert.equal(rejectedCandidate.ok, false);
assert.match(rejectedCandidate.reason, /invalid audit input: candidate.party\[0\].species/);
const unrelated = structuredClone(fixture);
const finalFrame = JSON.parse(
  gunzipSync(Buffer.from(unrelated.logs.at(-1).payload.slice(3), "base64")).toString("utf8"),
);
unrelated.run.candidate = structuredClone(finalFrame.generation.basis);
unrelated.run.candidate.party[0].species = 150;
const rejectedOrigin = await verify(unrelated);
assert.equal(rejectedOrigin.ok, false);
assert.match(rejectedOrigin.reason, /party provenance: species\/form/);
const illegalMove = structuredClone(fixture);
illegalMove.run.candidate.party[0].moveset = [{ moveId: 147, ppUsed: 0, ppUp: 0 }]; // Spore on Bulbasaur
const rejectedMove = await verify(illegalMove);
assert.equal(rejectedMove.ok, false);
assert.match(rejectedMove.reason, /party provenance: move 147 has no legal learning source/);
const uncertifiedMint = structuredClone(fixture);
uncertifiedMint.run.candidate.party[0].customPokemonData = { nature: 3 };
const rejectedMint = await verify(uncertifiedMint);
assert.equal(rejectedMint.ok, false);
assert.match(rejectedMint.reason, /party provenance: custom nature changed/);
const freePp = structuredClone(fixture);
freePp.run.candidate.party[0].moveset[0].ppUp = 3;
const rejectedPp = await verify(freePp);
assert.equal(rejectedPp.ok, false);
assert.match(rejectedPp.reason, /party provenance: PP increase has no verified reward source/);
const alteredGift = structuredClone(fixture);
const giftLog = alteredGift.logs.find(log => {
  const frame = JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")).toString("utf8"));
  return frame.captures.some(c => c.source === "MysteryEncounterOptionSelectedPhase");
});
assert.ok(giftLog, "positive control must contain a mystery encounter gift");
const giftFrame = JSON.parse(gunzipSync(Buffer.from(giftLog.payload.slice(3), "base64")).toString("utf8"));
const giftCapture = giftFrame.captures.find(c => c.source === "MysteryEncounterOptionSelectedPhase");
giftCapture.pokemon.species = 150;
giftLog.payload = `gz:${gzipSync(JSON.stringify(giftFrame)).toString("base64")}`;
const rejectedGift = await verify(alteredGift);
assert.equal(rejectedGift.ok, false);
assert.match(rejectedGift.reason, /capture has no reproduced individual/);
async function changedInventory(change, pattern) {
  const input = structuredClone(fixture);
  change(input);
  const result = await verify(input);
  assert.equal(result.ok, false);
  assert.match(result.reason, pattern);
  return result.reason;
}
function alterFrame(input, index, change) {
  const log = input.logs[index];
  const frame = JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")).toString("utf8"));
  change(frame);
  log.payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
}
assert.ok(fixture.run.candidate.modifiers.length, "positive control must retain a selected persistent item");
const inflatedItem = await changedInventory(input => input.run.candidate.modifiers[0].stackCount++, /item provenance:/);
const substitutedItem = await changedInventory(input => {
  input.run.candidate.modifiers[0].className = "MapModifier";
}, /item provenance:/);
const missingCompletion = await changedInventory(
  input =>
    alterFrame(input, 1, frame => {
      frame.items = frame.items.filter(item => item.kind !== "battle-end");
    }),
  /battle completion missing/,
);
const duplicateCompletion = await changedInventory(
  input =>
    alterFrame(input, 1, frame => {
      frame.items.push({ kind: "battle-end", source: "BattleEndPhase" });
    }),
  /excess battle completions/,
);
const wrongItemSource = await changedInventory(input => {
  const index = input.logs.findIndex(log =>
    JSON.parse(gunzipSync(Buffer.from(log.payload.slice(3), "base64")).toString("utf8")).items.some(
      item => item.kind === "acquire" && item.source === "SelectModifierPhase",
    ),
  );
  assert.ok(index >= 0);
  alterFrame(input, index, frame => {
    frame.items.find(item => item.kind === "acquire" && item.source === "SelectModifierPhase").source = "CommandPhase";
  });
}, /item provenance:/);
const freeMega = await changedInventory(input => {
  input.run.candidate.party[0].species = 3; // Bulbasaur -> Venusaur -> Mega Venusaur is a registry path.
  input.run.candidate.party[0].level = 36;
  input.run.candidate.party[0].formIndex = 1;
}, /form item has no certified ownership/);
const missingShopMarker = await changedInventory(input => {
  alterFrame(input, 1, frame => {
    frame.items = frame.items.filter(item => item.kind !== "shop");
  });
}, /shop timeline missing|certified source/);
const duplicateShopMarker = await changedInventory(input => {
  alterFrame(input, 1, frame => {
    const index = frame.items.findIndex(item => item.kind === "shop");
    assert.ok(index >= 0);
    frame.items.splice(index, 0, structuredClone(frame.items[index]));
  });
}, /shop order mismatch/);
const prematureReward = await changedInventory(input => {
  alterFrame(input, 1, frame => {
    const index = frame.items.findIndex(item => item.kind === "acquire" && item.source === "SelectModifierPhase");
    assert.ok(index >= 0);
    const receipt = frame.items.splice(index, 1)[0];
    const firstShop = frame.items.findIndex(item => item.kind === "shop");
    assert.ok(firstShop >= 0);
    frame.items.splice(firstShop, 0, receipt);
  });
}, /certified source/);
const unearnedLevel = await changedInventory(input => {
  input.run.candidate.party[0].level = 10000;
}, /level increase has no certified candy source|Candy Jar budget/);
console.log(
  JSON.stringify({
    passed: true,
    valid,
    tamperRejected: invalid.reason,
    malformedInputRejected: rejectedInput.reason,
    malformedCandidateRejected: rejectedCandidate.reason,
    unrelatedSpeciesRejected: rejectedOrigin.reason,
    illegalMoveRejected: rejectedMove.reason,
    uncertifiedMintRejected: rejectedMint.reason,
    freePpRejected: rejectedPp.reason,
    giftSpeciesRejected: rejectedGift.reason,
    inflatedItemRejected: inflatedItem,
    substitutedItemRejected: substitutedItem,
    missingCompletionRejected: missingCompletion,
    duplicateCompletionRejected: duplicateCompletion,
    wrongItemSourceRejected: wrongItemSource,
    freeMegaRejected: freeMega,
    missingShopMarkerRejected: missingShopMarker,
    duplicateShopMarkerRejected: duplicateShopMarker,
    prematureRewardRejected: prematureReward,
    unearnedLevelRejected: unearnedLevel,
    compressedBytes: Buffer.byteLength(JSON.stringify(fixture.logs)),
  }),
);
