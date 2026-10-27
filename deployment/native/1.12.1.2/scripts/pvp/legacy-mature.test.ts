// SPDX-License-Identifier: AGPL-3.0-only
// QA fast-forward: native egg lapse/generation, without simulating campaign combat.
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { EggLapsePhase } from "#phases/egg-lapse-phase";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { loadSession } from "../../src/pvp/loader";
it("advances the existing egg through its native required hatch waves", async () => {
  const input = JSON.parse(readFileSync(process.env.PVP_PROGRESS_INPUT!, "utf8"));
  const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
  await game.runToTitle();
  game.scene.gameData = GameData.fromRawSystem(JSON.stringify(input.system));
  await loadSession(game.scene.gameData, game.scene.gameData.parseSessionData(JSON.stringify(input.session)));
  const frames: unknown[] = [];
  const waves = Math.max(...game.scene.gameData.eggs.map(e => e.hatchWaves));
  for (let i = 0; i < waves; i++) {
    const phase = new EggLapsePhase();
    vi.spyOn(phase, "end").mockImplementation(() => {});
    vi.spyOn(phase, "hatchEggsRegular").mockImplementation(() => {});
    phase.start();
    game.scene.phaseManager.clearPhaseQueue();
    game.scene.newBattle();
    frames.push(
      JSON.parse(
        JSON.stringify(
          { system: game.scene.gameData.getSystemSaveData(), session: game.scene.gameData.getSessionSaveData() },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      ),
    );
  }
  expect(game.scene.gameData.eggs.every(e => e.hatchWaves === 0)).toBe(true);
  writeFileSync(process.env.PVP_PROGRESS_OUTPUT!, JSON.stringify({ waves, frames }));
});
