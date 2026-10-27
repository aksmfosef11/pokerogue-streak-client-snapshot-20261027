// SPDX-License-Identifier: AGPL-3.0-only
import { loggedInUser } from "#app/account";
import { modifierTypes } from "#data/data-lists";
import { AbilityId } from "#enums/ability-id";
import { BiomeId } from "#enums/biome-id";
import { Button } from "#enums/buttons";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { StatusEffect } from "#enums/status-effect";
import { UiMode } from "#enums/ui-mode";
import type { PersistentModifier } from "#modifiers/modifier";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { applyAbilityOverrideToPokemon } from "#mystery-encounters/encounter-pokemon-utils";
// biome-ignore lint/performance/noNamespaceImport: Choose real encounter definitions without replacing their callbacks.
import * as mysteryBiomes from "#mystery-encounters/mystery-encounter-biomes";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd, skipBattleRunMysteryEncounterRewardsPhase } from "#test/utils/encounter-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replayFieryHeat } from "../../../scripts/pvp/audit-me-selections";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { encounterItemGrants } from "../../../src/pvp/audit-item-sources";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { customAbility, generatedPokemon, serialCopy } from "../../../src/pvp/generation";
import { recordWave } from "../../../src/pvp/log";
import { installBattleHooks } from "../../../src/pvp/runtime";
import type { ShopOffer } from "../../../src/pvp/shop";
// biome-ignore lint/performance/noNamespaceImport: Enable the journal only for its native UI control.
import * as pvpState from "../../../src/pvp/state";

describe("Native permanent ability provenance", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let restore: (() => void) | undefined;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(() => {
    game = new GameManager(phaser);
    game.override.normalizeIVs = false;
    game.override.normalizeNatures = false;
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });
  const snapshot = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  async function setup(type = ME.CLOWNING_AROUND, species = [SpeciesId.LAPRAS, SpeciesId.GENGAR, SpeciesId.ABRA]) {
    game.override.mysteryEncounterChance(100).startingWave(94).startingBiome(BiomeId.CAVE).disableTrainerWaves();
    vi.spyOn(mysteryBiomes, "mysteryEncountersByBiome", "get").mockReturnValue(new Map([[BiomeId.CAVE, [type]]]));
    await game.runToMysteryEncounter(type, species);
    return game.scene;
  }
  function auditBefore(type: ME) {
    const before = snapshot();
    const inventory = new InventoryAudit();
    const audit = new PartyAudit({ deferResources: true, claimEncounter: (g, c) => inventory.claimEncounter(g, c) });
    inventory.observe(before, []);
    inventory.begin(encounterItemGrants(game.scene));
    audit.start(before);
    audit.beginEncounter(type, game.scene.getMaxExpLevel());
    return { before, audit, inventory };
  }
  function clownGrant(audit: PartyAudit, before: PokemonData[]) {
    const ability = game.scene.currentBattle.mysteryEncounter!.misc.ability as AbilityId;
    audit.clownSelection(0);
    audit.authorizePermanentAbility(
      ability,
      before.flatMap(p => [
        { id: p.id, fusion: false },
        { id: p.id, fusion: true },
      ]),
    );
    return ability;
  }
  async function heatProof() {
    await setup(ME.FIERY_FALLOUT);
    const result = auditBefore(ME.FIERY_FALLOUT);
    const expected = (await replayFieryHeat(game.scene, result.before))!;
    expect(expected.target).toBeDefined();
    result.audit.fierySelection(1);
    result.audit.authorizePermanentAbility(expected.target!.ability, [expected.target!]);
    return { ...result, expected };
  }
  it("accepts the real post-battle Clown UI ability on one chosen Pokemon", async () => {
    await setup();
    const { audit, before } = auditBefore(ME.CLOWNING_AROUND);
    audit.beginEncounter(ME.CLOWNING_AROUND, game.scene.getMaxExpLevel(), 6);
    const ability = clownGrant(audit, before);
    await runMysteryEncounterToEnd(game, 1, undefined, true);
    await skipBattleRunMysteryEncounterRewardsPhase(game);
    game.onNextPrompt("PostMysteryEncounterPhase", UiMode.MESSAGE, () =>
      game.scene.ui.getHandler().processInput(Button.ACTION),
    );
    const confirm = game.scene.ui.handlers[UiMode.CONFIRM];
    const party = game.scene.ui.handlers[UiMode.PARTY];
    vi.spyOn(confirm, "show");
    vi.spyOn(party, "show");
    game.endPhase();
    await game.phaseInterceptor.to("PostMysteryEncounterPhase");
    await vi.waitFor(() => expect(confirm.show).toHaveBeenCalled());
    confirm.processInput(Button.ACTION);
    await vi.waitFor(() => expect(party.show).toHaveBeenCalled());
    party.processInput(Button.ACTION);
    party.processInput(Button.ACTION);
    await game.phaseInterceptor.to("NewBattlePhase", false);
    const after = snapshot();
    expect(customAbility(after[0])).toBe(ability);
    expect(after.filter(p => customAbility(p) >= 0)).toHaveLength(1);
    audit.observe(after);
    expect(() => audit.finishWave()).not.toThrow();
  });
  it("rejects an ability that the Clown did not offer", async () => {
    await setup();
    const { audit, before } = auditBefore(ME.CLOWNING_AROUND);
    clownGrant(audit, before);
    applyAbilityOverrideToPokemon(game.scene.getPlayerParty()[0], AbilityId.WONDER_GUARD);
    expect(() => audit.observe(snapshot())).toThrow(/permanent ability.*source/);
  });
  it("limits the Clown's offered ability to one owner", async () => {
    await setup();
    const { audit, before } = auditBefore(ME.CLOWNING_AROUND);
    const ability = clownGrant(audit, before);
    for (const p of game.scene.getPlayerParty().slice(0, 2)) {
      applyAbilityOverrideToPokemon(p, ability);
    }
    expect(() => audit.observe(snapshot())).toThrow(/permanent ability.*source/);
  });
  it("does not allow the ability on the item or type choices", async () => {
    await setup();
    const { audit, before } = auditBefore(ME.CLOWNING_AROUND);
    audit.clownSelection(1);
    expect(() => audit.authorizePermanentAbility(AbilityId.STURDY, [{ id: before[0].id, fusion: false }])).toThrow(
      /native encounter source/,
    );
  });
  it("overrides only the active fusion component and discards it on native unfusion", async () => {
    await setup();
    const [primary, donor] = game.scene.getPlayerParty();
    primary.fuse(donor);
    game.scene.getPlayerParty().splice(1, 1);
    const { audit, before } = auditBefore(ME.CLOWNING_AROUND);
    const ability = clownGrant(audit, before);
    applyAbilityOverrideToPokemon(primary, ability);
    expect(primary.customPokemonData.ability).toBe(-1);
    expect(primary.getAbility().id).toBe(ability);
    audit.observe(snapshot());
    primary.clearFusionSpecies();
    expect(() => audit.observe(snapshot())).not.toThrow();
    expect(() => audit.finishWave()).not.toThrow();
  });
  it("copies the certified ability of the consumed donor through native DNA Splicers", async () => {
    await setup();
    const { audit, before } = auditBefore(ME.CLOWNING_AROUND);
    const ability = clownGrant(audit, before);
    const [primary, donor] = game.scene.getPlayerParty();
    applyAbilityOverrideToPokemon(donor, ability);
    audit.observe(snapshot());
    audit.finishWave();
    audit.beginEncounter(-1, game.scene.getMaxExpLevel());
    audit.offer({
      kind: "offer",
      rerolls: 0,
      copy: false,
      special: false,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [{ id: "DNA_SPLICERS", args: [], tier: 4, upgradeCount: 0, cost: 0 }],
    } as ShopOffer);
    audit.selection(1, 0);
    const modifier = generateModifierType(modifierTypes.DNA_SPLICERS)!.newModifier(primary, donor)!;
    Reflect.get(modifier, "apply").call(modifier, primary, donor);
    expect(primary.getAbility().id).toBe(ability);
    expect(() => audit.observe(snapshot())).not.toThrow();
    const forged = snapshot();
    forged[0].fusionCustomPokemonData.ability = AbilityId.WONDER_GUARD;
    expect(() => audit.observe(forged)).toThrow(/fusion.*source/);
  });
  it.each(["ability", "passive"] as const)("does not accept an invented starter custom %s", async field => {
    await setup();
    const party = snapshot();
    party[0].customPokemonData[field] = AbilityId.STURDY;
    expect(() => new PartyAudit().start(party)).toThrow(/unverified custom abilities/);
  });
  it("rejects an invented captured custom ability", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    const audit = new PartyAudit();
    audit.start(snapshot());
    audit.beginEncounter(-1, game.scene.getMaxExpLevel());
    const enemy = game.scene.getEnemyParty()[0];
    const profile = generatedPokemon(new PokemonData(enemy));
    const caught = enemy.addToParty(PokeballType.POKEBALL)!;
    const forged = serialCopy(new PokemonData(caught));
    forged.customPokemonData.ability = AbilityId.STURDY;
    expect(() => audit.capture(forged, profile, "AttemptCapturePhase")).toThrow(/capture custom abilities/);
  });
  it("matches the real heat option's damage, chosen burn and ability while restoring replay state", async () => {
    await setup(ME.FIERY_FALLOUT);
    const before = snapshot();
    const rng = Phaser.Math.RND.state();
    const expected = (await replayFieryHeat(game.scene, before))!;
    expect(snapshot()).toEqual(before);
    expect(Phaser.Math.RND.state()).toBe(rng);
    const key = `pvp:run:${loggedInUser?.username}:fiery-native-journal`;
    vi.spyOn(pvpState, "pvpEnabled", "get").mockReturnValue(true);
    localStorage.setItem(
      key,
      JSON.stringify({ id: "fiery-native-journal", seed: game.scene.seed, logs: [], anchored: 0 }),
    );
    Object.defineProperty(localStorage, key, { value: true, enumerable: true, configurable: true });
    await recordWave(game.scene.gameData.getSessionSaveData(), false);
    restore = installBattleHooks({
      handlePvpForfeit: () => false,
      replayPvpCommand: () => false,
      pausePvpTurn: () => false,
      handlePvpSwitch: () => false,
      handlePvpVictory: () => false,
      handlePvpLoss: () => false,
    });
    await runMysteryEncounterToEnd(game, 2);
    const choice = JSON.parse(localStorage.getItem(key)!).frame.encounterChoice;
    localStorage.removeItem(key);
    Reflect.deleteProperty(localStorage, key);
    expect(choice).toEqual({ option: 1, party: before });
    const result = (party: PokemonData[]) =>
      party.map(p => ({
        id: p.id,
        hp: p.hp,
        status: p.status?.effect,
        ability: customAbility(p),
        fusionAbility: customAbility(p, true),
      }));
    expect(result(snapshot())).toEqual(result(expected.party));
    expect(expected.target!.ability).toBe(AbilityId.HEATPROOF);
  });
  it("accepts only the native heat target", async () => {
    const { audit, expected } = await heatProof();
    audit.observe(expected.party);
    expect(() => audit.finishWave()).not.toThrow();
  });
  it("rejects Heatproof on another owner", async () => {
    const { audit, before, expected } = await heatProof();
    before.find(p => p.id !== expected.target!.id)!.customPokemonData.ability = AbilityId.HEATPROOF;
    expect(() => audit.observe(before)).toThrow(/permanent ability.*source/);
  });
  it("does not combine the heat ability with encounter reward claims", async () => {
    const { audit, expected, inventory } = await heatProof();
    audit.observe(expected.party);
    expect(() => audit.offer({} as ShopOffer)).toThrow(/cannot also claim encounter rewards/);
    inventory.claimChoice("fiery:option", "reward");
    expect(() => audit.finishWave()).toThrow(/exclusive paid option source/);
  });
  it("does not burn or grant an ability to a party of Fire types", async () => {
    await setup(ME.FIERY_FALLOUT, [SpeciesId.CHARMANDER]);
    const before = snapshot();
    const expected = (await replayFieryHeat(game.scene, before))!;
    expect(expected.target).toBeUndefined();
    expect(expected.party[0].hp).toBe(before[0].hp);
    await runMysteryEncounterToEnd(game, 2);
    expect(customAbility(snapshot()[0])).toBe(-1);
    expect(snapshot()[0].status?.effect).not.toBe(StatusEffect.BURN);
  });
  it("ties native Macho Brace growth to the fight branch instead of the heat branch", async () => {
    const scene = await setup(ME.FIERY_FALLOUT);
    const party = scene.getPlayerParty();
    const ids = new Set(party.map(p => p.id));
    const inventory = new InventoryAudit();
    const brace = generateModifierType(modifierTypes.MYSTERY_ENCOUNTER_MACHO_BRACE)!.newModifier(
      party[0],
    ) as PersistentModifier;
    const data = new ModifierData(brace, true);
    inventory.grant({ base: canonicalItem(data).base, count: 1, source: "SelectModifierPhase" });
    inventory.acquire(data, "SelectModifierPhase", ids);
    scene.addModifier(brace, true);
    const stock = () => scene.modifiers.map(m => new ModifierData(m, true));
    inventory.observe(party, stock());
    inventory.begin(encounterItemGrants(scene));
    scene.applyPartyExp(0, true, false, new Set([party[0].id]));
    expect(brace.stackCount).toBe(2);
    inventory.observe(party, stock());
    expect(inventory.claimEncounter("fiery:option", "heat")).toBe(false);
  });
});
