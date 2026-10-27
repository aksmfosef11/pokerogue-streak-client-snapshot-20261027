// SPDX-License-Identifier: AGPL-3.0-only

import { loggedInUser } from "#app/account";
import { modifierTypes } from "#data/data-lists";
import { BiomeId } from "#enums/biome-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { PokemonType, type RegularPokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
// biome-ignore lint/performance/noNamespaceImport: Skip only the transformation animation in the UI control.
import * as encounterAnimation from "#mystery-encounters/encounter-transformation-sequence";
// biome-ignore lint/performance/noNamespaceImport: Select the real Weird Dream without replacing its generation.
import * as mysteryBiomes from "#mystery-encounters/mystery-encounter-biomes";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replayWeirdDreamTransformation } from "../../../scripts/pvp/audit-me-selections";
import { findTradeGift } from "../../../src/pvp/audit-me-gifts";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { generatedPokemon, serialCopy } from "../../../src/pvp/generation";
import { installGenerationCapture, recordWave } from "../../../src/pvp/log";
import { installBattleHooks } from "../../../src/pvp/runtime";
import type { ShopOffer } from "../../../src/pvp/shop";
// biome-ignore lint/performance/noNamespaceImport: Enable only the journal while running the real native option.
import * as pvpState from "../../../src/pvp/state";

describe("Native Weird Dream transformation audit", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    game.override.normalizeNatures = false;
    game.override.normalizeIVs = false;
    game.override.disableShinies = false;
    game.override.mysteryEncounterChance(100).startingWave(45).startingBiome(BiomeId.CAVE).disableTrainerWaves();
    vi.spyOn(mysteryBiomes, "mysteryEncountersByBiome", "get").mockReturnValue(
      new Map([[BiomeId.CAVE, [ME.WEIRD_DREAM]]]),
    );
    vi.spyOn(encounterAnimation, "doPokemonTransformationSequence").mockResolvedValue();
  });
  async function setup(species = [SpeciesId.MAGBY, SpeciesId.HAUNTER, SpeciesId.ABRA]) {
    await game.runToMysteryEncounter(ME.WEIRD_DREAM, species);
    return game.scene;
  }
  async function proof() {
    const scene = await setup();
    const before = scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    const expected = (await replayWeirdDreamTransformation(scene))!;
    const audit = new PartyAudit({ deferResources: true });
    audit.start(before);
    audit.beginEncounter(ME.WEIRD_DREAM, scene.getMaxExpLevel());
    const capture = (g: (typeof expected.gifts)[number], pokemon = g.pokemon) =>
      audit.capture(pokemon, generatedPokemon(g.pokemon), "MysteryEncounterOptionSelectedPhase", true, g.outgoing);
    return { before, expected, audit, capture };
  }
  it("reproduces the original UI option's whole party, inherited moves and random permanent types", async () => {
    const scene = await setup();
    const encounter = scene.currentBattle.mysteryEncounter!;
    const before = scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    const offset = encounter.getSeedOffset();
    const transformations = encounter.misc.teamTransformations.map(t => ({
      ...t,
      birth: serialCopy(new PokemonData(t.newPokemon)),
    }));
    const oldParty = scene.getPlayerParty().slice();
    const enabled = vi.spyOn(pvpState, "pvpEnabled", "get").mockReturnValue(true);
    const key = `pvp:run:${loggedInUser?.username}:dream-native-journal`;
    localStorage.setItem(key, JSON.stringify({ id: "dream-native-journal", seed: scene.seed, logs: [], anchored: 0 }));
    Object.defineProperty(localStorage, key, { value: true, enumerable: true, configurable: true });
    await recordWave(scene.gameData.getSessionSaveData(), false);
    installGenerationCapture();
    const restore = installBattleHooks({
      handlePvpForfeit: () => false,
      replayPvpCommand: () => false,
      pausePvpTurn: () => false,
      handlePvpSwitch: () => false,
      handlePvpVictory: () => false,
      handlePvpLoss: () => false,
    });
    await runMysteryEncounterToEnd(game, 1);
    const expected = scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    const nativeItems = scene.modifiers.map(m => serialCopy(new ModifierData(m, true)));
    restore();
    enabled.mockReturnValue(false);
    const captures = JSON.parse(localStorage.getItem(key)!).frame.captures;
    localStorage.removeItem(key);
    Reflect.deleteProperty(localStorage, key);
    expect(captures.map(c => c.pokemon)).toEqual(expected);
    expect(captures.map(c => c.outgoing)).toEqual(before.map(p => p.id));
    scene.getPlayerParty().splice(0, scene.getPlayerParty().length, ...oldParty);
    scene.modifiers = [];
    Reflect.set(encounter, "seedOffset", offset);
    encounter.misc.teamTransformations = transformations.map(t => ({
      ...t,
      newPokemon: new PokemonData(t.birth).toPokemon(),
    }));
    encounter.misc.loadAssets = [];
    const replayed = await replayWeirdDreamTransformation(scene);
    expect(replayed?.items).toEqual(nativeItems);
    expect(
      replayed?.gifts.map(g => ({
        id: g.pokemon.id,
        species: g.pokemon.species,
        nature: g.pokemon.nature,
        abilityIndex: g.pokemon.abilityIndex,
        passive: g.pokemon.passive,
        types: g.pokemon.customPokemonData.types,
        moves: g.pokemon.moveset.map(m => m.moveId),
      })),
    ).toEqual(
      expected.map(p => ({
        id: p.id,
        species: p.species,
        nature: p.nature,
        abilityIndex: p.abilityIndex,
        passive: p.passive,
        types: p.customPokemonData.types,
        moves: p.moveset.map(m => m.moveId),
      })),
    );
    const audit = new PartyAudit({ deferResources: true });
    audit.start(before);
    audit.beginEncounter(ME.WEIRD_DREAM, scene.getMaxExpLevel());
    for (const g of replayed!.gifts) {
      audit.capture(
        expected.find(p => p.id === g.pokemon.id)!,
        generatedPokemon(g.pokemon),
        "MysteryEncounterOptionSelectedPhase",
        true,
        g.outgoing,
      );
    }
    audit.observe(expected);
    expect(() => audit.finishWave()).not.toThrow();
  });
  it("requires every original party member and forbids retaining a consumed owner", async () => {
    const { before, expected, audit, capture } = await proof();
    capture(expected.gifts[0]);
    expect(() => audit.finishWave()).toThrow(/entire original party/);
    for (const gift of expected.gifts.slice(1)) {
      capture(gift);
    }
    expect(() => audit.observe([before[0], ...expected.gifts.slice(1).map(g => g.pokemon)])).toThrow(
      /unknown or retired/,
    );
  });
  it("binds each transformed individual to its exact generated outgoing owner", async () => {
    const { expected } = await proof();
    const gifts = expected.gifts.map(g => ({ outgoing: g.outgoing, pokemon: generatedPokemon(g.pokemon) }));
    expect(() => findTradeGift(gifts, expected.gifts[0].pokemon, expected.gifts[1].outgoing)).toThrow(
      /no reproduced outgoing/,
    );
  });
  it("rejects arbitrary permanent types on a generated transformed individual", async () => {
    const { expected, capture } = await proof();
    const forged = serialCopy(expected.gifts[0].pokemon);
    forged.customPokemonData.types[1] = ((forged.customPokemonData.types[1]! + 1) % 18) as RegularPokemonType;
    expect(() => capture(expected.gifts[0], forged)).toThrow(/permanent types/);
  });
  it("does not permit a second free passive or a later type change", async () => {
    const { expected, audit, capture } = await proof();
    for (const gift of expected.gifts) {
      capture(gift);
    }
    const party = expected.gifts.map(g => serialCopy(g.pokemon));
    audit.observe(party);
    audit.finishWave();
    const boosted = serialCopy(party);
    boosted.find(p => !p.passive)!.passive = true;
    expect(() => audit.observe(boosted)).toThrow(/passive changed without a source/);
    const altered = serialCopy(party);
    altered[0].customPokemonData.types[1] = ((altered[0].customPokemonData.types[1]! + 1) % 18) as RegularPokemonType;
    expect(() => audit.observe(altered)).toThrow(/permanent types changed/);
  });
  it("rejects forged starter types and extra captured PP Ups", async () => {
    const { before, expected, capture } = await proof();
    before[0].customPokemonData.types = [null, PokemonType.FIRE];
    expect(() => new PartyAudit().start(before)).toThrow(/unverified permanent types/);
    const forged = serialCopy(expected.gifts[0].pokemon);
    forged.moveset[0].ppUp = 3;
    expect(() => capture(expected.gifts[0], forged)).toThrow(/unverified PP Ups/);
  });
  it("replaces all six party members through the original side-by-side branch", async () => {
    const scene = await setup([
      SpeciesId.MAGBY,
      SpeciesId.HAUNTER,
      SpeciesId.ABRA,
      SpeciesId.PIKACHU,
      SpeciesId.EEVEE,
      SpeciesId.RIOLU,
    ]);
    const before = scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    const expected = (await replayWeirdDreamTransformation(scene))!;
    expect(expected.gifts).toHaveLength(6);
    const audit = new PartyAudit({ deferResources: true });
    audit.start(before);
    audit.beginEncounter(ME.WEIRD_DREAM, scene.getMaxExpLevel());
    for (const gift of expected.gifts) {
      audit.capture(
        gift.pokemon,
        generatedPokemon(gift.pokemon),
        "MysteryEncounterOptionSelectedPhase",
        true,
        gift.outgoing,
      );
    }
    audit.observe(expected.gifts.map(g => g.pokemon));
    expect(() => audit.finishWave()).not.toThrow();
  });
  it("does not combine the transformed party with the future-self battle reward branch", async () => {
    const { expected, audit, capture } = await proof();
    for (const gift of expected.gifts) {
      capture(gift);
    }
    const offer = {
      kind: "offer",
      rerolls: 0,
      copy: false,
      special: true,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [],
      custom: { tiers: [3, 3, 2, 2, 1, 1], functions: [], options: [], fill: false, luck: true },
    } as ShopOffer;
    expect(() => audit.offer(offer)).toThrow(/dream reward branch/);
  });
  it("transfers the certified secondary type through the real DNA Splicers effect", async () => {
    const { expected, audit, capture } = await proof();
    for (const gift of expected.gifts) {
      capture(gift);
    }
    audit.observe(expected.gifts.map(g => g.pokemon));
    audit.finishWave();
    audit.beginEncounter(-1, game.scene.getMaxExpLevel());
    const offer = {
      kind: "offer",
      rerolls: 0,
      copy: false,
      special: false,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [{ id: "DNA_SPLICERS", args: [], tier: 4, upgradeCount: 0, cost: 0 }],
    } as ShopOffer;
    audit.offer(offer);
    audit.selection(1, 0);
    const [primary, secondary] = game.scene.getPlayerParty();
    const secondaryTypes = [...secondary.customPokemonData.types];
    const modifier = generateModifierType(modifierTypes.DNA_SPLICERS)!.newModifier(primary, secondary)!;
    Reflect.get(modifier, "apply").call(modifier, primary, secondary);
    const party = game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    expect(party[0].fusionCustomPokemonData.types).toEqual(secondaryTypes);
    expect(() => audit.observe(party)).not.toThrow();
    const forged = serialCopy(party);
    forged[0].fusionCustomPokemonData.types[1] = ((forged[0].fusionCustomPokemonData.types[1]! + 1)
      % 18) as RegularPokemonType;
    expect(() => audit.observe(forged)).toThrow(/fusion.*source/);
  });
  it("captures unlocked egg moves during the original transformation", async () => {
    const scene = await setup();
    const replayed = (await replayWeirdDreamTransformation(scene))!;
    expect(replayed.eggMoves).toBeDefined();
    expect(Array.isArray(replayed.eggMoves)).toBe(true);
    expect(replayed.eggMoves.length).toBeGreaterThan(0);
    for (const em of replayed.eggMoves) {
      expect(typeof em.species).toBe("number");
      expect(em.species).toBeGreaterThan(0);
      expect(em.moveIndex).toBeGreaterThanOrEqual(0);
      expect(em.moveIndex).toBeLessThan(4);
    }
  });
});
