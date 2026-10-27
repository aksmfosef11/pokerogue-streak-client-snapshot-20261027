// SPDX-License-Identifier: AGPL-3.0-only
import { BattleScene } from "#app/battle-scene";
import { getGameMode } from "#app/game-mode";
import { settings } from "#app/global-settings-manager";
import { AbilityId } from "#enums/ability-id";
import { Command } from "#enums/command";
import { GameModes } from "#enums/game-modes";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import { GameManager } from "#test/framework/game-manager";
import { generateStarters } from "#test/utils/game-manager-utils";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import manifest from "../../src/pvp/rules-manifest.json";

// This measures a fast legal native progression path, including real run-away
// ability/command/battle-end/encounter phases. It is a headless lower-cost
// control, not a browser latency or full campaign timing measurement: upstream's
// GameWrapper skips visual tweens, text and network, and polls phases at 50 ms.
const samples: { seed: string; waves: number; elapsedMs: number; perWaveMs: number; phases: number }[] = [];
let phaser: Phaser.Game;
beforeAll(() => {
  phaser = new Phaser.Game({ type: Phaser.HEADLESS });
});
afterAll(() => {
  if (process.env.PVP_WAVE_RATE_OUTPUT) {
    writeFileSync(
      process.env.PVP_WAVE_RATE_OUTPUT,
      JSON.stringify(
        { manifest, path: "endless-native-run-away", environment: "headless-visuals-and-network-stubbed", samples },
        null,
        2,
      ),
    );
  }
});

it.each(["pvp-arrival-1", "pvp-arrival-2", "pvp-arrival-3"])("measures five native Run Away waves (%s)", async seed => {
  const game = new GameManager(phaser);
  game.override.seed(seed).startingLevel(5).ability(AbilityId.RUN_AWAY);
  // Restore real battle RNG, rather than GameManager's usual maximum rolls.
  BattleScene.prototype.randBattleSeedInt = function (range, min = 0) {
    return this.currentBattle?.randSeedInt(range, min);
  };
  await game.runToTitle();
  game.onNextPrompt("TitlePhase", UiMode.TITLE, () => {
    game.scene.gameMode = getGameMode(GameModes.ENDLESS);
    const starters = generateStarters(game.scene, [SpeciesId.EEVEE]);
    game.scene.phaseManager.pushNew("EncounterPhase", false);
    void new SelectStarterPhase().initBattle(starters);
  });
  await game.phaseInterceptor.to("CommandPhase");
  expect(game.scene.getPlayerPokemon()!.getSpeciesForm().getAbility(0)).toBe(AbilityId.RUN_AWAY);
  expect(settings.general.gameSpeed).toBe(5);
  expect(settings.display.enableMoveAnimations).toBe(false);
  const startWave = game.scene.currentBattle.waveIndex;
  const startPhase = game.phaseInterceptor.phaseLog.length;
  const start = performance.now();
  for (let index = 0; index < 5; index++) {
    const phase = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
    expect(phase.phaseName).toBe("CommandPhase");
    expect(phase.handleCommand(Command.RUN, 0)).toBe(true);
    await game.phaseInterceptor.to("TurnInitPhase");
    await game.phaseInterceptor.to("CommandPhase");
    expect(game.scene.currentBattle.waveIndex).toBe(startWave + index + 1);
  }
  const elapsedMs = performance.now() - start;
  const phases = game.phaseInterceptor.phaseLog.slice(startPhase);
  expect(phases.filter(name => name === "AttemptRunPhase")).toHaveLength(5);
  expect(phases.filter(name => name === "BattleEndPhase")).toHaveLength(5);
  expect(game.scene.getPlayerPokemon()!.level).toBe(5);
  samples.push({ seed, waves: 5, elapsedMs, perWaveMs: elapsedMs / 5, phases: phases.length });
});
