// SPDX-License-Identifier: AGPL-3.0-only
import { loggedInUser } from "#app/account";
import { modifierTypes } from "#data/data-lists";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import type { RegularPokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
// biome-ignore lint/performance/noNamespaceImport: Select the real encounter without replacing its callbacks.
import * as mysteryBiomes from "#mystery-encounters/mystery-encounter-biomes";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replayClownTypeShuffle } from "../../../scripts/pvp/audit-me-selections";
import { InventoryAudit } from "../../../src/pvp/audit-inventory";
import { encounterItemGrants } from "../../../src/pvp/audit-item-sources";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { serialCopy } from "../../../src/pvp/generation";
import { recordWave } from "../../../src/pvp/log";
import { installBattleHooks } from "../../../src/pvp/runtime";
import type { ShopOffer } from "../../../src/pvp/shop";
// biome-ignore lint/performance/noNamespaceImport: Enable only the native journal control.
import * as pvpState from "../../../src/pvp/state";

describe("Native Clowning Around permanent types", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let restore: (() => void) | undefined;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    game.override.normalizeNatures = false;
    game.override.normalizeIVs = false;
    game.override.mysteryEncounterChance(100).startingWave(94).startingBiome(BiomeId.CAVE).disableTrainerWaves();
    vi.spyOn(mysteryBiomes, "mysteryEncountersByBiome", "get").mockReturnValue(
      new Map([[BiomeId.CAVE, [ME.CLOWNING_AROUND]]]),
    );
    await game.runToMysteryEncounter(ME.CLOWNING_AROUND, [SpeciesId.LAPRAS, SpeciesId.GENGAR, SpeciesId.ABRA]);
    const party = game.scene.getPlayerParty();
    game.move.changeMoveset(party[0], [MoveId.ICE_BEAM, MoveId.SURF]);
    game.move.changeMoveset(party[1], [MoveId.GRASS_KNOT, MoveId.ELECTRO_BALL]);
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });
  const snapshot = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  async function proof() {
    const before = snapshot();
    const expected = (await replayClownTypeShuffle(game.scene, before))!;
    const inventory = new InventoryAudit();
    inventory.observe(before, []);
    inventory.begin(encounterItemGrants(game.scene));
    const audit = new PartyAudit({
      deferResources: true,
      claimEncounter: (group, choice) => inventory.claimEncounter(group, choice),
    });
    audit.start(before);
    audit.beginEncounter(ME.CLOWNING_AROUND, game.scene.getMaxExpLevel());
    audit.clownSelection(2, expected);
    return { before, expected, audit, inventory };
  }
  it("matches the real UI option and journals its reordered party before the effect", async () => {
    game.scene.getPlayerParty().reverse();
    const before = snapshot();
    const rng = Phaser.Math.RND.state();
    const expected = await replayClownTypeShuffle(game.scene, before);
    expect(Phaser.Math.RND.state()).toBe(rng);
    expect(snapshot()).toEqual(before);
    const key = `pvp:run:${loggedInUser?.username}:clown-native-journal`;
    vi.spyOn(pvpState, "pvpEnabled", "get").mockReturnValue(true);
    localStorage.setItem(
      key,
      JSON.stringify({ id: "clown-native-journal", seed: game.scene.seed, logs: [], anchored: 0 }),
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
    await runMysteryEncounterToEnd(game, 3);
    const choice = JSON.parse(localStorage.getItem(key)!).frame.encounterChoice;
    localStorage.removeItem(key);
    Reflect.deleteProperty(localStorage, key);
    expect(choice).toEqual({ option: 2, party: before });
    expect(snapshot().map(p => p.customPokemonData.types)).toEqual(expected!.map(p => p.customPokemonData.types));
    expect([11, 12]).toContain(expected![1].customPokemonData.types[1]);
  });
  it("accepts one whole-party native shuffle and preserves it in later waves", async () => {
    const { expected, audit } = await proof();
    audit.observe(expected);
    audit.finishWave();
    audit.beginEncounter(-1, game.scene.getMaxExpLevel());
    expect(() => audit.observe(expected)).not.toThrow();
  });
  it("rejects a partial party shuffle", async () => {
    const { before, expected, audit } = await proof();
    audit.observe([expected[0], ...before.slice(1)]);
    expect(() => audit.finishWave()).toThrow(/entire selected party/);
  });
  it("rejects a type the seeded native callback did not generate", async () => {
    const { expected, audit } = await proof();
    expected[0].customPokemonData.types[1] = ((expected[0].customPokemonData.types[1]! + 1) % 18) as RegularPokemonType;
    expect(() => audit.observe(expected)).toThrow(/permanent types changed without a source/);
  });
  it("rejects another free shuffle after consuming the native effect", async () => {
    const { expected, audit } = await proof();
    audit.observe(expected);
    const changed = serialCopy(expected);
    changed[0].customPokemonData.types[1] = ((changed[0].customPokemonData.types[1]! + 1) % 18) as RegularPokemonType;
    expect(() => audit.observe(changed)).toThrow(/permanent types changed without a source/);
  });
  it("does not grant types from the encounter name alone", async () => {
    const before = snapshot();
    const expected = (await replayClownTypeShuffle(game.scene, before))!;
    const audit = new PartyAudit({ deferResources: true });
    audit.start(before);
    audit.beginEncounter(ME.CLOWNING_AROUND, game.scene.getMaxExpLevel());
    expect(() => audit.observe(expected)).toThrow(/permanent types changed without a source/);
  });
  it("does not combine the type choice with a fight reward or item exchange", async () => {
    const { expected, audit, inventory } = await proof();
    audit.observe(expected);
    expect(() => audit.offer({} as ShopOffer)).toThrow(/clown options cannot be combined/);
    expect(inventory.claimChoice("clown:option", "exchange")).toBe(true);
    expect(() => audit.finishWave()).toThrow(/exclusive paid option source/);
  });
  it("updates both components of a native DNA fusion and rejects an invented fusion type", async () => {
    const [primary, donor] = game.scene.getPlayerParty();
    const modifier = generateModifierType(modifierTypes.DNA_SPLICERS)!.newModifier(primary, donor)!;
    Reflect.get(modifier, "apply").call(modifier, primary, donor);
    const { expected, audit } = await proof();
    expect(expected[0].customPokemonData.types).toEqual(expected[0].fusionCustomPokemonData.types);
    const changed = serialCopy(expected);
    changed[0].fusionCustomPokemonData.types[1] = ((changed[0].fusionCustomPokemonData.types[1]! + 1)
      % 18) as RegularPokemonType;
    expect(() => audit.observe(changed)).toThrow(/permanent types changed without a source/);
    audit.observe(expected);
    expect(() => audit.finishWave()).not.toThrow();
    const unfused = new PokemonData(expected[0]).toPokemon();
    unfused.clearFusionSpecies();
    const after = [serialCopy(new PokemonData(unfused)), ...expected.slice(1)];
    expect(after[0].fusionCustomPokemonData.types).toEqual([]);
    expect(after[0].customPokemonData.types).toEqual(expected[0].customPokemonData.types);
    expect(() => audit.observe(after)).not.toThrow();
    unfused.destroy();
  });
});
