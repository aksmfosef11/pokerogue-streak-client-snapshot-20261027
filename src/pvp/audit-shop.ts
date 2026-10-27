// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import type { ModifierTypeOption } from "#modifiers/modifier-type";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { AuditInputError } from "./audit-errors";
import { parseAuditSession } from "./audit-input";
import { canonicalItem } from "./audit-inventory";
import { decodeEncounterRewards } from "./audit-me-rewards";
import { loadSession } from "./loader";
import { optionData, type ShopOffer } from "./shop";

export interface RerollBasis {
  count: number;
  tiers: number[];
  multiplier?: number | undefined;
}

/** Returns a server-derived RNG continuation for the next reroll. Client RNG
 * state is never an input. Copies reuse the already audited options. */
export async function replayShop(
  scene: BattleScene,
  offer: ShopOffer,
  seed: string,
  priorRng?: string,
  sourceEncounter = -1,
  previousReroll?: RerollBasis,
) {
  if (
    !offer?.session
    || !Number.isInteger(offer.rerolls)
    || offer.rerolls < 0
    || offer.rerolls > 64
    || offer.session.seed !== seed
    || typeof offer.locked !== "boolean"
    || typeof offer.special !== "boolean"
    || typeof offer.copy !== "boolean"
    || (offer.tiers != null
      && (!Array.isArray(offer.tiers)
        || offer.tiers.length > 32
        || offer.tiers.some(t => !Number.isInteger(t) || t < 0 || t > 4)))
  ) {
    throw new AuditInputError("invalid shop checkpoint");
  }
  const basis = parseAuditSession(scene.gameData, offer.session, seed);
  const owners = new Set(basis.party.map(p => p.id));
  for (const raw of basis.modifiers ?? []) {
    const item = canonicalItem(raw);
    if (!raw.player || (item.owner != null && !owners.has(item.owner))) {
      throw new AuditInputError("shop inventory owner mismatch");
    }
  }
  scene.phaseManager.clearPhaseQueue();
  scene.reset(false, true);
  await loadSession(scene.gameData, basis);
  scene.phaseManager.clearPhaseQueue();
  scene.lockModifierTiers = offer.locked;
  if (offer.rerolls) {
    if (!priorRng) {
      throw new AuditInputError("reroll has no preceding offer");
    }
    Phaser.Math.RND.state(priorRng);
  }
  const fixed = scene.gameMode.getFixedBattle(offer.session.waveIndex)?.customModifierRewardSettings;
  let rewards = fixed;
  if (offer.special && !fixed) {
    if (sourceEncounter < 0 || offer.session.mysteryEncounterType !== sourceEncounter || !offer.custom) {
      throw new AuditInputError("custom reward requires its verified encounter source");
    }
    rewards = decodeEncounterRewards(offer.custom, sourceEncounter, offer.session.waveIndex, scene.getPlayerParty());
  } else if (offer.special !== !!fixed) {
    throw new AuditInputError("fixed reward policy mismatch");
  }
  const phase = new SelectModifierPhase(offer.rerolls, offer.tiers, rewards);
  phase.start();
  const options = Reflect.get(phase, "typeOptions") as ModifierTypeOption[];
  const multiplier = (Reflect.get(phase, "customModifierSettings") as typeof rewards)?.rerollMultiplier;
  let rerollCost: number | undefined;
  if (previousReroll) {
    // The preceding native options/multiplier fix the fee, while current
    // verified inventory supplies Black Sludge's native cost modifier.
    const costPhase = new SelectModifierPhase(previousReroll.count, undefined, {
      rerollMultiplier: previousReroll.multiplier,
    });
    Reflect.set(
      costPhase,
      "typeOptions",
      previousReroll.tiers.map(tier => ({ type: { tier } })),
    );
    rerollCost = costPhase.getRerollCost(offer.locked);
  }
  return {
    options: options.map(optionData),
    rng: Phaser.Math.RND.state(),
    rerollCost,
    nextReroll: { count: offer.rerolls, tiers: options.map(o => o.type.tier ?? 0), multiplier },
  };
}
