// SPDX-License-Identifier: AGPL-3.0-only

import { generateRandomStatusEffect, getRandomStatusEffect } from "#data/status-effect";
import { AbilityId } from "#enums/ability-id";
import { BattleType } from "#enums/battle-type";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { StatusEffect } from "#enums/status-effect";
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSession } from "../../../src/pvp/loader";
import { setPvpMatchActive } from "../../../src/pvp/state";
import fixture from "../../fixtures/pvp/session.json";

describe("PvP synthetic sessions", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(() => {
    setPvpMatchActive(false);
    game = new GameManager(phaserGame);
  });
  afterEach(() => setPvpMatchActive(false));

  it("loads the server trainer snapshot through the real save loader", async () => {
    await game.runToTitle();
    const data = game.scene.gameData.parseSessionData(JSON.stringify(fixture));
    await loadSession(game.scene.gameData, data);
    expect(game.scene.currentBattle.battleType).toBe(BattleType.TRAINER);
    expect(game.scene.currentBattle.double).toBe(false);
    expect(game.scene.getPlayerParty()).toHaveLength(3);
    expect(game.scene.getEnemyParty()).toHaveLength(3);
    for (const p of [...game.scene.getPlayerParty(), ...game.scene.getEnemyParty()]) {
      p.calculateStats();
      p.hp = p.stats[0];
      expect(p.ivs).toEqual([31, 31, 31, 31, 31, 31]);
      expect(p.hp).toBeGreaterThan(100);
      expect(p.isBoss()).toBe(false);
    }
    expect(game.scene.getEnemyParty().every(p => p.isEnemy() && p.hasTrainer())).toBe(true);
    expect(game.scene.getPlayerParty()[0].id).not.toBe(game.scene.getEnemyParty()[0].id);
  });

  it("blocks both local and remote system/session saves while in a match", async () => {
    localStorage.setItem("ordinary-save", "keep");
    const before = JSON.stringify(localStorage);
    setPvpMatchActive(true);
    const data = game.scene.gameData;
    expect(await GameData.prototype.saveSystem.call(data)).toBe(true);
    expect(await GameData.prototype.saveAll.call(data, true, true)).toBe(true);
    expect(await data.tryClearSession(0)).toEqual([true, false]);
    expect(JSON.stringify(localStorage)).toBe(before);
  });
  it("preserves a certified mint effect through the real loader on both sides", async () => {
    await game.runToTitle();
    game.override.normalizeNatures = false;
    const input = structuredClone(fixture);
    for (const p of [...input.party, ...input.enemyParty]) {
      Object.assign(p, { nature: 0, customPokemonData: { nature: 3 } });
    }
    const data = game.scene.gameData.parseSessionData(JSON.stringify(input));
    await loadSession(game.scene.gameData, data);
    for (const p of [...game.scene.getPlayerParty(), ...game.scene.getEnemyParty()]) {
      expect(p.nature).toBe(0);
      expect(p.getNature()).toBe(3);
    }
  });
  it("keeps certified permanent secondary types through the real loader on both sides", async () => {
    await game.runToTitle();
    const input = structuredClone(fixture);
    for (const p of [...input.party, ...input.enemyParty]) {
      Object.assign(p, { customPokemonData: { types: [null, PokemonType.PSYCHIC] } });
    }
    await loadSession(game.scene.gameData, game.scene.gameData.parseSessionData(JSON.stringify(input)));
    for (const p of [...game.scene.getPlayerParty(), ...game.scene.getEnemyParty()]) {
      expect(p.customPokemonData.types).toEqual([null, PokemonType.PSYCHIC]);
      expect(p.getTypes()[1]).toBe(PokemonType.PSYCHIC);
      expect(p.ivs).toEqual([31, 31, 31, 31, 31, 31]);
    }
  });

  it("keeps certified primary and fusion abilities on both sides of the real loader", async () => {
    await game.runToTitle();
    const input = structuredClone(fixture);
    for (const party of [input.party, input.enemyParty]) {
      Object.assign(party[0], { customPokemonData: { ability: AbilityId.HEATPROOF } });
      Object.assign(party[1], {
        customPokemonData: { ability: AbilityId.HEATPROOF },
        fusionSpecies: SpeciesId.MAGIKARP,
        fusionFormIndex: 0,
        fusionAbilityIndex: 0,
        fusionGender: 0,
        fusionShiny: false,
        fusionVariant: 0,
        fusionCustomPokemonData: { ability: AbilityId.STURDY },
      });
    }
    await loadSession(game.scene.gameData, game.scene.gameData.parseSessionData(JSON.stringify(input)));
    for (const party of [game.scene.getPlayerParty(), game.scene.getEnemyParty()]) {
      expect(party[0].getAbility().id).toBe(AbilityId.HEATPROOF);
      expect(party[1].getAbility().id).toBe(AbilityId.STURDY);
      expect(party[1].customPokemonData.ability).toBe(AbilityId.HEATPROOF);
      expect(party[1].ivs).toEqual([31, 31, 31, 31, 31, 31]);
    }
  });
  it("migrates synthetic sessions from 1.12.1.2 through upstream migrators while preserving PvP normalization", async () => {
    await game.runToTitle();
    const input = structuredClone(fixture);
    input.gameVersion = "1.12.1.2";
    for (const party of [input.party, input.enemyParty]) {
      Object.assign(party[0], {
        customPokemonData: {
          nature: 3,
          types: [null, PokemonType.PSYCHIC],
          ability: AbilityId.HEATPROOF,
        },
      });
    }
    const data = game.scene.gameData.parseSessionData(JSON.stringify(input));
    await loadSession(game.scene.gameData, data);
    expect(game.scene.currentBattle.battleType).toBe(BattleType.TRAINER);
    expect(game.scene.getPlayerParty()).toHaveLength(3);
    expect(game.scene.getEnemyParty()).toHaveLength(3);
    for (const p of [...game.scene.getPlayerParty(), ...game.scene.getEnemyParty()]) {
      expect(p.ivs).toEqual([31, 31, 31, 31, 31, 31]);
      expect(p.isBoss()).toBe(false);
    }
    const playerFirst = game.scene.getPlayerParty()[0];
    expect(playerFirst.getNature()).toBe(3);
    expect(playerFirst.getTypes()[1]).toBe(PokemonType.PSYCHIC);
    expect(playerFirst.getAbility().id).toBe(AbilityId.HEATPROOF);
  });
  it("migrates synthetic sessions from 1.12.0.0 through upstream migrators while preserving PvP normalization", async () => {
    await game.runToTitle();
    const input = structuredClone(fixture);
    input.gameVersion = "1.12.0.0";
    for (const party of [input.party, input.enemyParty]) {
      Object.assign(party[0], {
        customPokemonData: {
          nature: 3,
          types: [null, PokemonType.PSYCHIC],
          ability: AbilityId.HEATPROOF,
        },
      });
    }
    const data = game.scene.gameData.parseSessionData(JSON.stringify(input));
    await loadSession(game.scene.gameData, data);
    expect(game.scene.currentBattle.battleType).toBe(BattleType.TRAINER);
    expect(game.scene.getPlayerParty()).toHaveLength(3);
    expect(game.scene.getEnemyParty()).toHaveLength(3);
    for (const p of [...game.scene.getPlayerParty(), ...game.scene.getEnemyParty()]) {
      expect(p.ivs).toEqual([31, 31, 31, 31, 31, 31]);
      expect(p.isBoss()).toBe(false);
    }
    const playerFirst = game.scene.getPlayerParty()[0];
    expect(playerFirst.getNature()).toBe(3);
    expect(playerFirst.getTypes()[1]).toBe(PokemonType.PSYCHIC);
    expect(playerFirst.getAbility().id).toBe(AbilityId.HEATPROOF);
  });
  it("replays nonvolatile status rolls from the same decision seed", async () => {
    const rolls = () =>
      Array.from({ length: 20 }, () => [
        generateRandomStatusEffect(),
        getRandomStatusEffect(StatusEffect.BURN, StatusEffect.POISON),
      ]);
    Phaser.Math.RND.sow(["pvp-status-golden-v1"]);
    const first = rolls();
    Phaser.Math.RND.sow(["different-seed"]);
    expect(rolls()).not.toEqual(first);
    Phaser.Math.RND.sow(["pvp-status-golden-v1"]);
    expect(rolls()).toEqual(first);
    await expect(first.slice(0, 4)).toMatchFileSnapshot("./snapshots/status-rolls.snap");
  });
});
