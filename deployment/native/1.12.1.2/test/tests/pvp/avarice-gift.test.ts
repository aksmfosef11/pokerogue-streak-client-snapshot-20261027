// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { BattleType } from "#enums/battle-type";
import { BerryType } from "#enums/berry-type";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { BerryModifier, type PersistentModifier } from "#modifiers/modifier";
import { AbsoluteAvariceEncounter } from "#mystery-encounters/absolute-avarice-encounter";
// biome-ignore lint/performance/noNamespaceImport: Keep the original option callback; suppress only animation.
import * as encounterPhases from "#mystery-encounters/encounter-phase-utils";
// biome-ignore lint/performance/noNamespaceImport: Capture the native generated enemy at the existing catch boundary.
import * as encounterPokemon from "#mystery-encounters/encounter-pokemon-utils";
import { MysteryEncounterOptionSelectedPhase } from "#phases/mystery-encounter-phases";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { encounterItemGrants } from "../../../src/pvp/audit-item-sources";
import { replayAvariceGift } from "../../../src/pvp/audit-me-gifts";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { serialCopy } from "../../../src/pvp/generation";

describe("Native Absolute Avarice gift and exclusive berry cost", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let inventory: InventoryAudit;
  let partyAudit: PartyAudit;
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  const stock = () => game.scene.modifiers.map(m => new ModifierData(m, true));
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    game.override.normalizeNatures = false;
    game.override.normalizeIVs = false;
    await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
    game.scene.currentBattle.waveIndex = 80;
    game.scene.currentBattle.battleType = BattleType.MYSTERY_ENCOUNTER;
    game.scene.currentBattle.mysteryEncounter = AbsoluteAvariceEncounter;
    Reflect.set(AbsoluteAvariceEncounter, "seedOffset", undefined);
    inventory = new InventoryAudit();
    for (const type of [BerryType.SITRUS, BerryType.LUM, BerryType.LEPPA]) {
      const berry = encounterPhases
        .generateModifierType(modifierTypes.BERRY, [type])!
        .newModifier(game.scene.getPlayerParty()[0]) as PersistentModifier;
      berry.stackCount = 2;
      const data = new ModifierData(berry, true);
      inventory.grant({ base: canonicalItem(data).base, count: 2, source: "SelectModifierPhase" });
      inventory.acquire(data, "SelectModifierPhase", new Set(party().map(p => p.id)));
      game.scene.addModifier(berry, true);
    }
    inventory.observe(party(), stock());
    expect(AbsoluteAvariceEncounter.onInit!()).toBe(true);
    inventory.begin(encounterItemGrants(game.scene));
    partyAudit = new PartyAudit({
      claimEncounter: (group, choice) => inventory.claimEncounter(group, choice),
      inventory: id => inventory.provedItems(id),
      deferResources: true,
    });
    partyAudit.start(party());
    partyAudit.beginEncounter(AbsoluteAvariceEncounter.encounterType, game.scene.getMaxExpLevel());
  });
  function stolen() {
    for (const berry of game.scene.modifiers.filter(m => m instanceof BerryModifier)) {
      game.scene.removeModifier(berry);
    }
    inventory.observe(party(), stock());
  }
  async function nativeGift() {
    const rng = Phaser.Math.RND.state();
    const offset = AbsoluteAvariceEncounter.getSeedOffset();
    const expected = replayAvariceGift(game.scene)!;
    expect(Phaser.Math.RND.state()).toBe(rng);
    expect(AbsoluteAvariceEncounter.getSeedOffset()).toBe(offset);
    let caught: PokemonData | undefined;
    vi.spyOn(encounterPhases, "transitionMysteryEncounterIntroVisuals").mockResolvedValue(true);
    vi.spyOn(encounterPokemon, "catchPokemon").mockImplementation(async pokemon => {
      caught = serialCopy(new PokemonData(pokemon.addToParty(PokeballType.POKEBALL)!));
    });
    AbsoluteAvariceEncounter.selectedOption = AbsoluteAvariceEncounter.options[2];
    AbsoluteAvariceEncounter.updateSeedOffset();
    const phase = new MysteryEncounterOptionSelectedPhase();
    vi.spyOn(phase, "end").mockImplementation(() => {});
    phase.start();
    await vi.waitUntil(() => caught !== undefined);
    return { caught: caught!, expected, source: phase.phaseName };
  }
  it("matches the actual seeded option's individual and admits it only after the theft", async () => {
    stolen();
    const { caught, expected, source } = await nativeGift();
    expect(caught.species).toBe(SpeciesId.GREEDENT);
    expect(caught.passive).toBe(true);
    expect(caught.shiny).toBe(false);
    partyAudit.capture(caught, expected, source, true);
    partyAudit.observe(party());
    expect(() => partyAudit.finishWave()).not.toThrow();
  });
  it("rejects the genuine gift if the original berries were never removed", async () => {
    const { caught, expected, source } = await nativeGift();
    partyAudit.capture(caught, expected, source, true);
    partyAudit.observe(party());
    expect(() => partyAudit.finishWave()).toThrow(/original stolen inventory/);
  });
  it("cannot combine the genuine gift with the berry-return option", async () => {
    stolen();
    const berry = encounterPhases
      .generateModifierType(modifierTypes.BERRY, [BerryType.SITRUS])!
      .newModifier(game.scene.getPlayerParty()[0]) as PersistentModifier;
    inventory.acquire(
      new ModifierData(berry, true),
      "MysteryEncounterOptionSelectedPhase",
      new Set(party().map(p => p.id)),
    );
    game.scene.addModifier(berry, true);
    inventory.observe(party(), stock());
    const { caught, expected, source } = await nativeGift();
    partyAudit.capture(caught, expected, source, true);
    partyAudit.observe(party());
    expect(() => partyAudit.finishWave()).toThrow(/exclusive paid option/);
  });
  it.each(["id", "nature", "level"] as const)("rejects a forged %s on the native gift", async key => {
    stolen();
    const { caught, expected, source } = await nativeGift();
    caught[key]++;
    expect(() => partyAudit.capture(caught, expected, source, true)).toThrow(/capture|captured/);
  });
  it("does not grant a second individual or battle-only reward from the same paid option", async () => {
    stolen();
    const { caught, expected, source } = await nativeGift();
    partyAudit.capture(caught, expected, source, true);
    partyAudit.observe(party());
    partyAudit.finishWave();
    expect(() => partyAudit.capture(caught, expected, source, true)).toThrow(/too many direct gifts/);
    const seed = encounterPhases
      .generateModifierType(modifierTypes.REVIVER_SEED)!
      .newModifier(game.scene.getPlayerParty()[0]) as PersistentModifier;
    expect(() =>
      inventory.acquire(new ModifierData(seed, true), "MysteryEncounterRewardsPhase", new Set(party().map(p => p.id))),
    ).toThrow(/certified source/);
  });
});
