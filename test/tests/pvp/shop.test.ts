// SPDX-License-Identifier: AGPL-3.0-only

import { SpeciesId } from "#enums/species-id";
import type { ModifierTypeOption } from "#modifiers/modifier-type";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replayShop } from "../../../src/pvp/audit-shop";
import { serialCopy } from "../../../src/pvp/generation";
import { optionData, type ShopOffer, shopSettings } from "../../../src/pvp/shop";

describe("Registration reward replay", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    game.scene.phaseManager.clearPhaseQueue();
  });
  function offer(phase: SelectModifierPhase): ShopOffer {
    phase.start();
    return serialCopy({
      kind: "offer",
      ...shopSettings(phase),
      locked: game.scene.lockModifierTiers,
      session: game.scene.gameData.getSessionSaveData(),
      options: (Reflect.get(phase, "typeOptions") as ModifierTypeOption[]).map(optionData),
    });
  }
  it("reproduces rewards, generated item arguments and the next reroll without accepting client RNG state", async () => {
    const first = offer(new SelectModifierPhase());
    const firstRng = Phaser.Math.RND.state();
    const second = offer(
      new SelectModifierPhase(
        1,
        first.options.map(o => o.tier!),
      ),
    );
    const seed = game.scene.seed;
    const replay = await replayShop(game.scene, first, seed);
    expect(replay.options).toEqual(first.options);
    expect(replay.rng).toEqual(firstRng);
    expect((await replayShop(game.scene, second, seed, replay.rng)).options).toEqual(second.options);
  });
  it("derives fixed battle reward tiers from the upstream rules", async () => {
    game.scene.currentBattle.waveIndex = 25;
    const settings = game.scene.gameMode.getFixedBattle(25)!.customModifierRewardSettings;
    const data = offer(new SelectModifierPhase(0, undefined, settings));
    expect((await replayShop(game.scene, data, game.scene.seed)).options).toEqual(data.options);
  });
});
