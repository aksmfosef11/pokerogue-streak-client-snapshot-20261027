// SPDX-License-Identifier: AGPL-3.0-only
import { timedEventManager } from "#app/global-event-manager";
import { speciesDataRegistry as registry } from "#app/global-species-data-registry";
import { CLASSIC_CANDY_FRIENDSHIP_MULTIPLIER, getStarterValueFriendshipCap } from "#balance/starters";
import { timedEvents } from "#balance/timed-events";
import { modifierTypes } from "#data/data-lists";
import { Egg } from "#data/egg";
import { BiomeId } from "#enums/biome-id";
import { EggSourceType } from "#enums/egg-source-types";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId as Species } from "#enums/species-id";
import type { PlayerPokemon } from "#field/pokemon";
import type { PersistentModifier } from "#modifiers/modifier";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
// biome-ignore lint/performance/noNamespaceImport: Suppress visuals while the native option updates the real system save.
import * as encounterAnimations from "#mystery-encounters/encounter-transformation-sequence";
// biome-ignore lint/performance/noNamespaceImport: Select one native encounter for its reward-boundary control.
import * as mysteryBiomes from "#mystery-encounters/mystery-encounter-biomes";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd, skipBattleRunMysteryEncounterRewardsPhase } from "#test/utils/encounter-test-utils";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../../../src/pvp/rules-manifest.json";

type NativeSave = ReturnType<GameManager["scene"]["gameData"]["getSystemSaveData"]>;
const eventMultiplier = Math.max(
  CLASSIC_CANDY_FRIENDSHIP_MULTIPLIER,
  ...timedEvents.map(e => e.classicFriendshipMultiplier ?? 0),
);
const catchBonus = Math.max(0, ...timedEvents.map(e => e.extraCatchCandy ?? 0));

describe("Native system income boundaries consumed by the Go validator", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  const samples: { name: string; waves: number; old: NativeSave; next: NativeSave; facts: Record<string, unknown> }[] =
    [];
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(() => {
    game = new GameManager(phaser);
    game.override.disableShinies = false;
    timedEventManager.disable();
    for (const entry of Object.values(game.scene.gameData.starterData)) {
      entry.candyCount = 0;
      entry.friendship = 0;
      entry.valueReduction = 0;
      entry.passiveAttr = 0;
      entry.eggMoves = 0;
    }
    game.scene.gameData.eggs = [];
  });
  afterAll(() => {
    if (process.env.PVP_NATIVE_INCOME_FIXTURE) {
      writeFileSync(process.env.PVP_NATIVE_INCOME_FIXTURE, JSON.stringify({ manifest, samples }, null, 2));
    }
  });
  function snapshot(): NativeSave {
    return JSON.parse(
      JSON.stringify(game.scene.gameData.getSystemSaveData(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  }
  function record(name: string, old: NativeSave, facts: Record<string, unknown>, waves = 1) {
    const next = snapshot();
    // Project only unchanged context away. Both sides retain every changed
    // starter/dex entry, native egg stock, voucher counts and version.
    for (const key of ["starterData", "dexData"] as const) {
      const ids = new Set([...Object.keys(old[key]), ...Object.keys(next[key])]);
      for (const keyId of ids) {
        const id = Number(keyId) as Species;
        if (JSON.stringify(old[key][id]) === JSON.stringify(next[key][id])) {
          delete old[key][id];
          delete next[key][id];
        }
      }
    }
    samples.push({ name, waves, old, next, facts });
  }
  function bells() {
    for (const pokemon of game.scene.getPlayerParty()) {
      const bell = generateModifierType(modifierTypes.SOOTHE_BELL)!.newModifier(pokemon) as PersistentModifier;
      bell.stackCount = 3;
      game.scene.addModifier(bell, true);
    }
  }
  it("accounts for a native epic shiny evolved boss as one physical catch", async () => {
    game.override.startingWave(10).enemySpecies(Species.VENUSAUR).enemyShiny(true, 2);
    await game.classicMode.startBattle(Species.BULBASAUR);
    vi.spyOn(timedEventManager, "getExtraCatchCandy").mockReturnValue(catchBonus);
    const pokemon = game.scene.getEnemyParty()[0];
    expect(pokemon.isBoss()).toBe(true);
    const old = snapshot();
    await game.scene.gameData.setPokemonCaught(pokemon, true, false, false);
    expect(
      game.scene.gameData.starterData[Species.BULBASAUR].candyCount - old.starterData[Species.BULBASAUR].candyCount,
    ).toBe(40 + catchBonus);
    record("evolved-shiny-boss-catch", old, { root: Species.BULBASAUR, physicalCatches: 1, candy: 40 + catchBonus });
  });
  it("accounts for native hatch candy and one egg move against mature egg stock", async () => {
    await game.classicMode.startBattle(Species.BULBASAUR);
    const egg = new Egg({
      id: 12345679,
      sourceType: EggSourceType.SAME_SPECIES_EGG,
      species: Species.BULBASAUR,
      hatchWaves: 0,
      isShiny: true,
      variantTier: 2,
      eggMoveIndex: 0,
    });
    egg.addEggToGameData();
    const old = snapshot();
    const hatch = egg.generatePlayerPokemon();
    await game.scene.gameData.setPokemonCaught(hatch, true, true, false);
    await game.scene.gameData.setEggMoveUnlocked(hatch.species, egg.eggMoveIndex, false);
    game.scene.gameData.eggs = game.scene.gameData.eggs.filter(e => e.id !== egg.id);
    expect(
      game.scene.gameData.starterData[Species.BULBASAUR].candyCount - old.starterData[Species.BULBASAUR].candyCount,
    ).toBe(40);
    record("epic-shiny-hatch", old, { root: Species.BULBASAUR, physicalHatches: 1, candy: 40 });
  });
  it("applies native trainer participation, three bells, event multiplier and each species cap", async () => {
    game.override.startingWave(195);
    await game.classicMode.startBattle(
      Species.BULBASAUR,
      Species.CHARMANDER,
      Species.SQUIRTLE,
      Species.RATTATA,
      Species.PARAS,
      Species.EEVEE,
    );
    expect(game.scene.currentBattle.trainer).toBeDefined();
    expect(game.scene.getEnemyParty()).toHaveLength(6);
    bells();
    vi.spyOn(timedEventManager, "getClassicFriendshipMultiplier").mockReturnValue(eventMultiplier);
    const old = snapshot();
    const ids = new Set(game.scene.getPlayerParty().map(p => p.id));
    for (let defeated = 0; defeated < 6; defeated++) {
      game.scene.applyPartyExp(0, true, false, ids);
    }
    const points = 7 * eventMultiplier * 6;
    for (const pokemon of game.scene.getPlayerParty()) {
      const root = pokemon.species.getRootSpeciesId();
      const cap = getStarterValueFriendshipCap(registry.getStarterCost(root));
      const entry = game.scene.gameData.starterData[root];
      expect(entry.candyCount).toBe(Math.floor(points / cap));
      expect(entry.friendship).toBe(points % cap);
    }
    record("trainer-six-defeats", old, { pointsPerMember: points, defeated: 6, party: 6, multiplier: eventMultiplier });
  });
  it.each([false, true])("uses native DNA fusion friendship division (boosted=%s)", async boosted => {
    await game.classicMode.startBattle(Species.BULBASAUR, Species.CHARMANDER);
    const [primary, secondary] = game.scene.getPlayerParty();
    const dna = generateModifierType(modifierTypes.DNA_SPLICERS)!.newModifier(primary, secondary)!;
    Reflect.get(dna, "apply").call(dna, primary, secondary);
    bells();
    vi.spyOn(timedEventManager, "areFusionsBoosted").mockReturnValue(boosted);
    const old = snapshot();
    game.scene.applyPartyExp(0, true, false, new Set([primary.id]));
    const points = Math.floor((7 * CLASSIC_CANDY_FRIENDSHIP_MULTIPLIER) / (boosted ? 1.5 : 2));
    expect(game.scene.gameData.starterData[Species.BULBASAUR].friendship).toBe(points);
    expect(game.scene.gameData.starterData[Species.CHARMANDER].friendship).toBe(points);
    record(`fusion-friendship-${boosted}`, old, { pointsPerComponent: points });
  });
  it("retains native candy friendship when Rare Candy reaches the ordinary friendship cap", async () => {
    await game.classicMode.startBattle(Species.BULBASAUR, Species.CHARMANDER, Species.SQUIRTLE);
    for (const pokemon of game.scene.getPlayerParty()) {
      pokemon.friendship = 255;
    }
    bells();
    const old = snapshot();
    game.scene.addModifier(generateModifierType(modifierTypes.RARER_CANDY)!.newModifier(), true);
    for (const pokemon of game.scene.getPlayerParty()) {
      expect(pokemon.friendship).toBe(255);
      expect(game.scene.gameData.starterData[pokemon.species.getRootSpeciesId()].friendship).toBe(45);
    }
    record("party-candy-at-friendship-cap", old, { pointsPerMember: 45 });
  });
  it("executes the native Breeder's thirteen-egg reward and post-battle friendship", async () => {
    game.override.mysteryEncounterChance(100).startingWave(45).startingBiome(BiomeId.CAVE).disableTrainerWaves();
    vi.spyOn(mysteryBiomes, "mysteryEncountersByBiome", "get").mockReturnValue(
      new Map([[BiomeId.CAVE, [ME.THE_EXPERT_POKEMON_BREEDER]]]),
    );
    await game.runToMysteryEncounter(ME.THE_EXPERT_POKEMON_BREEDER, [Species.PARAS, Species.PARAS, Species.PARAS]);
    const encounter = game.scene.currentBattle.mysteryEncounter!;
    expect(encounter.misc.pokemon1CommonEggs + encounter.misc.pokemon1RareEggs).toBe(13);
    const old = snapshot();
    await runMysteryEncounterToEnd(game, 1, undefined, true);
    await skipBattleRunMysteryEncounterRewardsPhase(game);
    await game.phaseInterceptor.to("SelectModifierPhase");
    game.endPhase();
    await game.phaseInterceptor.to("PostMysteryEncounterPhase");
    expect(game.scene.gameData.eggs).toHaveLength(13);
    expect(game.scene.gameData.starterData[Species.PARAS].candyCount).toBeGreaterThan(0);
    record("breeder-thirteen-eggs", old, { eventEggs: 13 });
  });
  it("executes Weird Dream's direct candy and egg move system rewards", async () => {
    game.override.mysteryEncounterChance(100).startingWave(45).startingBiome(BiomeId.CAVE).disableTrainerWaves();
    vi.spyOn(mysteryBiomes, "mysteryEncountersByBiome", "get").mockReturnValue(
      new Map([[BiomeId.CAVE, [ME.WEIRD_DREAM]]]),
    );
    vi.spyOn(encounterAnimations, "doPokemonTransformationSequence").mockResolvedValue();
    await game.runToMysteryEncounter(ME.WEIRD_DREAM, [Species.MAGBY, Species.HAUNTER, Species.ABRA]);
    const roots = new Set<Species>(
      game.scene.currentBattle.mysteryEncounter!.misc.teamTransformations.map((t: { newPokemon: PlayerPokemon }) =>
        t.newPokemon.species.getRootSpeciesId(),
      ),
    );
    const old = snapshot();
    await runMysteryEncounterToEnd(game, 1);
    expect(Object.values(game.scene.gameData.starterData).some(e => e.candyCount > 0)).toBe(true);
    const physicalCatches = [...roots].reduce(
      (sum, root) => sum + game.scene.gameData.dexData[root].caughtCount - old.dexData[root].caughtCount,
      0,
    );
    record("weird-dream-direct-rewards", old, { transformed: 3, physicalCatches });
  });
});
