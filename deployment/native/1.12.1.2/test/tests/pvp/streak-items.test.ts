// SPDX-License-Identifier: AGPL-3.0-only
import { Stat } from "#enums/stat";
// biome-ignore lint/performance/noNamespaceImport: Verify the complete upstream held-item class contract.
import * as nativeModifiers from "#modifiers/modifier";
import {
  BaseStatModifier,
  HitHealModifier,
  PokemonNatureWeightModifier,
  TempCritBoosterModifier,
  TempStatStageBoosterModifier,
} from "#modifiers/modifier";
import { PokemonHealPhase } from "#phases/pokemon-heal-phase";
import { GameManager } from "#test/framework/game-manager";
import { NumberHolder } from "#utils/common";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import heldModifierNames from "../../../src/pvp/held-modifiers.json";
import { loadSession } from "../../../src/pvp/loader";
import fixture from "../../fixtures/pvp/streak-item-session.json";

describe("Registered team held items through the server's synthetic session", () => {
  let game: GameManager;
  let phaser: Phaser.Game;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.runToTitle();
    game.override.normalizeNatures = false;
    await loadSession(game.scene.gameData, game.scene.gameData.parseSessionData(JSON.stringify(fixture)));
    game.scene.phaseManager.clearPhaseQueue();
  });
  it("covers every native held-item class in the shared owner-remapping contract", () => {
    const native = Object.entries(nativeModifiers)
      .filter(
        ([, value]) =>
          typeof value === "function"
          && (value === nativeModifiers.PokemonHeldItemModifier
            || value.prototype instanceof nativeModifiers.PokemonHeldItemModifier),
      )
      .map(([name]) => name)
      .sort();
    expect(heldModifierNames).toEqual(native);
  });
  it("preserves all six vitamin stats, Soul Dew and Shell Bell stacks on both owners", () => {
    for (const [party, modifiers, id] of [
      [game.scene.getPlayerParty(), game.scene.modifiers, 1],
      [game.scene.getEnemyParty(), game.scene.findModifiers(() => true, false), 101],
    ] as const) {
      expect(party[0].id).toBe(id);
      expect(modifiers).toHaveLength(9);
      expect(modifiers.filter(m => m instanceof BaseStatModifier)).toHaveLength(6);
      for (const vitamin of modifiers.filter(m => m instanceof BaseStatModifier)) {
        expect(vitamin.pokemonId).toBe(id);
        expect(vitamin.stackCount).toBe(7);
      }
      expect(modifiers.find(m => m instanceof PokemonNatureWeightModifier)?.stackCount).toBe(3);
      expect(modifiers.find(m => m instanceof HitHealModifier)?.stackCount).toBe(2);
      expect(
        modifiers.some(m => m instanceof TempStatStageBoosterModifier || m instanceof TempCritBoosterModifier),
      ).toBe(false);
    }
  });
  it("applies vitamin stat increases and Soul Dew's nature multiplier to both sides", () => {
    const scene = game.scene;
    const playerMods = scene.modifiers.slice();
    const enemyMods = scene.findModifiers(() => true, false);
    for (const p of [scene.getPlayerParty()[0], scene.getEnemyParty()[0]]) {
      p.calculateStats();
      const boosted = p.stats.slice();
      const nature = new NumberHolder(1.1);
      scene.applyModifiers(PokemonNatureWeightModifier, p.isPlayer(), p, nature);
      expect(nature.value).toBeCloseTo(1.4);
      scene.modifiers = [];
      Reflect.set(scene, "enemyModifiers", []);
      p.calculateStats();
      for (const stat of [Stat.HP, Stat.ATK, Stat.DEF, Stat.SPATK, Stat.SPDEF, Stat.SPD]) {
        expect(boosted[stat], `side=${p.isPlayer()}, stat=${stat}`).toBeGreaterThan(p.stats[stat]);
      }
      scene.modifiers = playerMods;
      Reflect.set(scene, "enemyModifiers", enemyMods);
    }
  });
  it("uses the restored Shell Bell to heal actual damage on both sides", async () => {
    const scene = game.scene;
    for (const p of [scene.getPlayerParty()[0], scene.getEnemyParty()[0]]) {
      scene.field.add(p);
      p.calculateStats();
      p.hp = p.getMaxHp() - 40;
      p.turnData.totalDamageDealt = 80;
      const before = p.hp;
      const queued = vi.spyOn(scene.phaseManager, "unshiftNew");
      scene.applyModifiers(HitHealModifier, p.isPlayer(), p);
      const healing = queued.mock.calls.find(call => call[0] === "PokemonHealPhase");
      expect(healing?.[2]).toBe(20);
      const phase = Reflect.construct(PokemonHealPhase, healing!.slice(1)) as PokemonHealPhase;
      await phase.end();
      expect(p.hp).toBe(before + 20);
      queued.mockRestore();
      scene.phaseManager.clearPhaseQueue();
    }
  });
});
