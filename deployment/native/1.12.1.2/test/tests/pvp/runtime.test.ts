// SPDX-License-Identifier: AGPL-3.0-only

import { Command } from "#enums/command";
import { SpeciesId } from "#enums/species-id";
import { SwitchType } from "#enums/switch-type";
import { CommandPhase } from "#phases/command-phase";
import { EnemyCommandPhase } from "#phases/enemy-command-phase";
import { GameOverPhase } from "#phases/game-over-phase";
import { SwitchPhase } from "#phases/switch-phase";
import { VictoryPhase } from "#phases/victory-phase";
import { GameManager } from "#test/framework/game-manager";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installBattleHooks } from "../../../src/pvp/runtime";
import { setPvpMatchActive } from "../../../src/pvp/state";

describe("Addon battle seams", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let restore: () => void;
  let handlers: Parameters<typeof installBattleHooks>[0];
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    setPvpMatchActive(false);
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
    game.scene.phaseManager.clearPhaseQueue();
    handlers = {
      handlePvpForfeit: vi.fn(() => false),
      replayPvpCommand: vi.fn(() => false),
      pausePvpTurn: vi.fn(() => true),
      handlePvpSwitch: vi.fn(() => true),
      handlePvpVictory: vi.fn(() => true),
      handlePvpLoss: vi.fn(() => true),
    };
    restore = installBattleHooks(handlers);
  });
  afterEach(() => {
    setPvpMatchActive(false);
    restore?.();
  });
  it("passes ordinary commands through without invoking PvP handlers", () => {
    new CommandPhase(0).start();
    for (const handler of Object.values(handlers!)) {
      expect(handler).not.toHaveBeenCalled();
    }
  });
  it("replays after upstream queued-move handling and intercepts forfeit", () => {
    setPvpMatchActive(true);
    vi.mocked(handlers!.replayPvpCommand).mockReturnValue(true);
    const phase = new CommandPhase(0);
    phase.start();
    expect(handlers!.replayPvpCommand).toHaveBeenCalledWith(phase);
    vi.mocked(handlers!.handlePvpForfeit).mockReturnValue(true);
    expect(phase.handleCommand(Command.RUN, 0)).toBe(true);
    expect(handlers!.handlePvpForfeit).toHaveBeenCalledWith(Command.RUN, expect.any(Function));
  });
  it("pauses before enemy AI and bypasses campaign victory/loss effects", () => {
    setPvpMatchActive(true);
    const stats = JSON.stringify(game.scene.gameData.gameStats);
    new EnemyCommandPhase(0).start();
    new VictoryPhase(2).start();
    new GameOverPhase().start();
    expect(handlers!.pausePvpTurn).toHaveBeenCalledOnce();
    expect(handlers!.handlePvpVictory).toHaveBeenCalledOnce();
    expect(handlers!.handlePvpLoss).toHaveBeenCalledOnce();
    expect(JSON.stringify(game.scene.gameData.gameStats)).toEqual(stats);
  });
  it("uses upstream switch eligibility/index and restores the UI method", () => {
    setPvpMatchActive(true);
    const phase = new SwitchPhase(SwitchType.SWITCH, 0, false, true);
    vi.spyOn(game.scene.phaseManager, "getCurrentPhase").mockReturnValue(phase);
    const setMode = game.scene.ui.setMode;
    phase.start();
    expect(handlers!.handlePvpSwitch).toHaveBeenCalledWith(phase, 0, SwitchType.SWITCH, true, false);
    expect(game.scene.ui.setMode).toBe(setMode);
  });
});
