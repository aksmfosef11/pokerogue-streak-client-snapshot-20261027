// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { PokemonData } from "#system/pokemon-data";
import type { SessionSaveData } from "#types/save-data";
import i18next from "i18next";

export interface GenerationBasis {
  basis: SessionSaveData;
  active: number[];
  identity: { trainerId: number; secretId: number };
  language: string;
}
export interface GenerationCheckpoint extends GenerationBasis {
  schema: 2;
  wave: number;
  initial: boolean;
  trainerTeras?: number[] | undefined;
}
export function serialCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function generationBefore(scene: BattleScene): GenerationBasis | undefined {
  return scene.currentBattle
    ? {
        basis: serialCopy(scene.gameData.getSessionSaveData()),
        active: scene
          .getPlayerParty()
          .filter(p => p.isOnField())
          .map(p => p.id),
        identity: { trainerId: scene.gameData.trainerId, secretId: scene.gameData.secretId },
        language: i18next.language,
      }
    : undefined;
}
export function generationAfter(scene: BattleScene, previous?: GenerationBasis): GenerationCheckpoint {
  return {
    schema: 2,
    wave: scene.currentBattle.waveIndex,
    initial: !previous,
    trainerTeras: scene.currentBattle.trainer
      ? [...new Set(scene.currentBattle.trainer.config.trainerAI.instantTeras)].sort()
      : undefined,
    ...(previous ?? {
      basis: serialCopy(scene.gameData.getSessionSaveData()),
      active: [],
      identity: { trainerId: scene.gameData.trainerId, secretId: scene.gameData.secretId },
      language: i18next.language,
    }),
  };
}
export function customTypes(p: PokemonData, fusion = false) {
  const types = [...((fusion ? p.fusionCustomPokemonData : p.customPokemonData)?.types ?? [])];
  while (types.length > 0 && types.at(-1) == null) {
    types.pop();
  }
  return types;
}
export function customAbility(p: PokemonData, fusion = false) {
  return (fusion ? p.fusionCustomPokemonData : p.customPokemonData)?.ability ?? -1;
}
export function customPassive(p: PokemonData, fusion = false) {
  return (fusion ? p.fusionCustomPokemonData : p.customPokemonData)?.passive ?? -1;
}
export function generatedPokemon(p: PokemonData) {
  const types = customTypes(p);
  const fusionTypes = customTypes(p, true);
  const ppUps = p.moveset.map(m => m.ppUp ?? 0);
  return {
    id: p.id,
    species: p.species,
    formIndex: p.formIndex,
    abilityIndex: p.abilityIndex,
    passive: p.passive,
    level: p.level,
    nature: p.nature,
    customNature: p.customPokemonData?.nature ?? -1,
    ...(types.length > 0 ? { customTypes: types } : {}),
    ...(fusionTypes.length > 0 ? { fusionCustomTypes: fusionTypes } : {}),
    ...(customAbility(p) >= 0 ? { customAbility: customAbility(p) } : {}),
    ...(customAbility(p, true) >= 0 ? { fusionCustomAbility: customAbility(p, true) } : {}),
    ...(customPassive(p) >= 0 ? { customPassive: customPassive(p) } : {}),
    ...(customPassive(p, true) >= 0 ? { fusionCustomPassive: customPassive(p, true) } : {}),
    ...(ppUps.some(value => value > 0) ? { ppUps } : {}),
    gender: p.gender,
    shiny: p.shiny,
    variant: p.variant,
    fusionSpecies: p.fusionSpecies,
    ivs: p.ivs,
    moves: p.moveset.map(m => m.moveId),
    boss: p.boss,
    bossSegments: p.bossSegments,
  };
}
export function generationResult(scene: BattleScene) {
  const data = scene.gameData.getSessionSaveData();
  const encounter = scene.currentBattle.mysteryEncounter;
  const gift =
    encounter?.encounterType === ME.DANCING_LESSONS
      ? encounter.misc?.oricorioData
      : encounter && [ME.THE_POKEMON_SALESMAN, ME.UNCOMMON_BREED].includes(encounter.encounterType)
        ? encounter.misc?.pokemon
        : undefined;
  return serialCopy({
    wave: data.waveIndex,
    battleType: data.battleType,
    mysteryEncounterType: data.mysteryEncounterType,
    trainer: data.trainer,
    enemyParty: data.enemyParty.map(generatedPokemon),
    giftParty: gift ? [generatedPokemon(gift instanceof PokemonData ? gift : new PokemonData(gift))] : [],
    enemyModifiers: data.enemyModifiers,
    weather: data.arena.weather,
    terrain: data.arena.terrain,
  });
}
