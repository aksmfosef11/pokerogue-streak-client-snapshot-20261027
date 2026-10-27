// SPDX-License-Identifier: AGPL-3.0-only
// biome-ignore lint/performance/noNamespaceImport: Live account binding exercise
import * as account from "#app/account";
import { getGameMode } from "#app/game-mode";
import { modifierTypes } from "#data/data-lists";
import { GameModes } from "#enums/game-modes";
import { SpeciesId } from "#enums/species-id";
import { SwitchType } from "#enums/switch-type";
import type { PersistentModifier } from "#modifiers/modifier";
import { CommandPhase } from "#phases/command-phase";
import { GameOverPhase } from "#phases/game-over-phase";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { SwitchPhase } from "#phases/switch-phase";
import { VictoryPhase } from "#phases/victory-phase";
import { ModifierData } from "#system/modifier-data";
import { GameManager } from "#test/framework/game-manager";
import { initSceneWithoutEncounterPhase } from "#test/utils/game-manager-utils";
import { getModifierType } from "#utils/modifier-utils";
import { Blob as NodeBlob } from "node:buffer";
import {
  CompressionStream as NodeCompressionStream,
  DecompressionStream as NodeDecompressionStream,
} from "node:stream/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pvpApi } from "../../../src/pvp/api";
import {
  installJournalLoadHooks,
  logItem,
  logShop,
  prepareRankedRun,
  recording,
  recordWave,
} from "../../../src/pvp/log";
import { installBattleHooks } from "../../../src/pvp/runtime";
// biome-ignore lint/performance/noNamespaceImport: Feature gate toggle
import * as state from "../../../src/pvp/state";
import { setPvpMatchActive } from "../../../src/pvp/state";

describe("Mode-specific behavioral independence and failure injection", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let username: string;
  let restoreHooks: (() => void) | undefined;
  const createdKeys = new Set<string>();

  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    setPvpMatchActive(false);
    game = new GameManager(phaser);
    initSceneWithoutEncounterPhase(game.scene, [SpeciesId.BULBASAUR]);
    game.scene.currentBattle.waveIndex = 1;
    username = "mode-tester";
    vi.spyOn(account, "loggedInUser", "get").mockImplementation(
      () => ({ username }) as NonNullable<typeof account.loggedInUser>,
    );
    vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(true);
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("CompressionStream", NodeCompressionStream);
    vi.stubGlobal("DecompressionStream", NodeDecompressionStream);
    installJournalLoadHooks();
  });

  afterEach(() => {
    setPvpMatchActive(false);
    restoreHooks?.();
    restoreHooks = undefined;
    for (const key of createdKeys) {
      localStorage.removeItem(key);
      Reflect.deleteProperty(localStorage, key);
    }
    createdKeys.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const nonClassicModes = [GameModes.CHALLENGE, GameModes.ENDLESS, GameModes.SPLICED_ENDLESS, GameModes.DAILY] as const;

  describe.each(nonClassicModes)("Non-classic mode %i behavioral independence", mode => {
    it("bypasses ranked run preparation, preserves original seed, and creates no PvP storage keys", async () => {
      const scene = game.scene;
      const initialSeed = "upstream-seed-" + mode;
      scene.setSeed(initialSeed);
      scene.gameMode = getGameMode(mode);

      // Verify challenge mode shares upstream isClassic, while other modes do not
      if (mode === GameModes.CHALLENGE) {
        expect(scene.gameMode.isClassic).toBe(true);
      } else {
        expect(scene.gameMode.isClassic).toBeFalsy();
      }

      const requestSpy = vi.spyOn(pvpApi, "request");
      const saveSpy = vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(true);

      await prepareRankedRun([]);

      expect(requestSpy).not.toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
      expect(scene.seed).toBe(initialSeed);
      expect(recording()).toBe(false);

      // Verify no pvp run keys were created in localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        expect(key?.startsWith("pvp:")).toBe(false);
      }
    });

    it("applies upstream modifiers and shops without generating PvP item logs", () => {
      const scene = game.scene;
      scene.gameMode = getGameMode(mode);

      const modifier = getModifierType(modifierTypes.MAP).newModifier() as PersistentModifier;
      scene.addModifier(modifier, true);

      expect(scene.modifiers).toContain(modifier);
      expect(recording()).toBe(false);

      const phase = new SelectModifierPhase();
      vi.spyOn(scene.phaseManager, "getCurrentPhase").mockReturnValue(phase);

      // Calling logItem and logShop in non-classic mode
      expect(() => {
        logItem(
          new ModifierData(getModifierType(modifierTypes.SHINY_CHARM).newModifier(), true),
          "SelectModifierPhase",
        );
        logShop({ rowCursor: 0, cursor: 1, rerolls: 0 });
      }).not.toThrow();

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        expect(key?.startsWith("pvp:")).toBe(false);
      }
    });

    it("executes upstream battle phases without interception from PvP hooks", () => {
      const scene = game.scene;
      scene.gameMode = getGameMode(mode);

      const handlers = {
        handlePvpForfeit: vi.fn(() => false),
        replayPvpCommand: vi.fn(() => false),
        pausePvpTurn: vi.fn(() => true),
        handlePvpSwitch: vi.fn(() => true),
        handlePvpVictory: vi.fn(() => true),
        handlePvpLoss: vi.fn(() => true),
      };
      restoreHooks = installBattleHooks(handlers);

      // Normal play passes through
      scene.currentBattle.turnCommands = [];
      new CommandPhase(0).start();

      const victory = new VictoryPhase(2);
      vi.spyOn(victory, "getPokemon").mockReturnValue({
        getExpValue: () => 0,
      } as any);
      vi.spyOn(scene, "applyPartyExp").mockImplementation(() => {});
      vi.spyOn(victory, "end").mockImplementation(() => {});
      victory.start();

      const gameOver = new GameOverPhase();
      vi.spyOn(scene.phaseManager, "hideAbilityBar").mockImplementation(() => {});
      vi.spyOn(scene.ui, "setMode").mockImplementation(async () => {});
      vi.spyOn(gameOver, "end").mockImplementation(() => {});
      gameOver.start();

      new SwitchPhase(SwitchType.SWITCH, 0, false, true).start();

      expect(handlers.handlePvpForfeit).not.toHaveBeenCalled();
      expect(handlers.replayPvpCommand).not.toHaveBeenCalled();
      expect(handlers.pausePvpTurn).not.toHaveBeenCalled();
      expect(handlers.handlePvpSwitch).not.toHaveBeenCalled();
      expect(handlers.handlePvpVictory).not.toHaveBeenCalled();
      expect(handlers.handlePvpLoss).not.toHaveBeenCalled();
    });

    it("saves and loads sessions without restoring or mutating PvP journal", async () => {
      const scene = game.scene;
      scene.gameMode = getGameMode(mode);
      const initialSeed = "save-test-seed-" + mode;
      scene.setSeed(initialSeed);

      const data = scene.gameData.getSessionSaveData();
      data.gameMode = mode;
      data.seed = initialSeed;

      const requestSpy = vi.spyOn(pvpApi, "request");
      vi.spyOn(scene.gameData, "getSession").mockResolvedValue(data);

      expect(await scene.gameData.loadSession(0)).toBe(true);
      expect(scene.gameMode.modeId).toBe(mode);
      expect(scene.seed).toBe(initialSeed);

      // Record wave does nothing in non-classic mode
      await recordWave(data, true);
      expect(requestSpy).not.toHaveBeenCalled();

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        expect(key?.startsWith("pvp:")).toBe(false);
      }
    });
  });

  describe("Classic mode failure injection and unranked fallback", () => {
    it("falls back seamlessly to unranked classic on HTTP 500 server error and displays banner", async () => {
      const scene = game.scene;
      const initialSeed = "unranked-classic-seed-500";
      scene.setSeed(initialSeed);
      scene.gameMode = getGameMode(GameModes.CLASSIC);

      vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(true);
      vi.spyOn(pvpApi, "request").mockRejectedValue(new Error("HTTP 500: Internal Server Error"));
      const showTextSpy = vi.spyOn(scene.ui, "showText");

      await expect(prepareRankedRun([])).resolves.toBeUndefined();

      expect(scene.gameMode.modeId).toBe(GameModes.CLASSIC);
      expect(scene.seed).toBe(initialSeed);
      expect(recording()).toBe(false);

      expect(showTextSpy).toHaveBeenCalledOnce();
      const bannerText = String(showTextSpy.mock.calls[0][0]);
      expect(bannerText).toContain("비랭크 클래식: Error: HTTP 500: Internal Server Error");

      // Verify no PvP run created in localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        expect(key?.startsWith("pvp:")).toBe(false);
      }
    });

    it("falls back seamlessly to unranked classic on network unreachable / ECONNREFUSED", async () => {
      const scene = game.scene;
      const initialSeed = "unranked-classic-seed-network";
      scene.setSeed(initialSeed);
      scene.gameMode = getGameMode(GameModes.CLASSIC);

      vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(true);
      vi.spyOn(pvpApi, "request").mockRejectedValue(
        new TypeError("Failed to fetch: connect ECONNREFUSED 127.0.0.1:8001"),
      );
      const showTextSpy = vi.spyOn(scene.ui, "showText");

      await expect(prepareRankedRun([])).resolves.toBeUndefined();

      expect(scene.gameMode.modeId).toBe(GameModes.CLASSIC);
      expect(scene.seed).toBe(initialSeed);
      expect(recording()).toBe(false);

      expect(showTextSpy).toHaveBeenCalledOnce();
      const bannerText = String(showTextSpy.mock.calls[0][0]);
      expect(bannerText).toContain("비랭크 클래식: TypeError: Failed to fetch");
    });

    it("falls back to unranked classic on contract/rules mismatch drift", async () => {
      const scene = game.scene;
      const initialSeed = "unranked-classic-seed-contract";
      scene.setSeed(initialSeed);
      scene.gameMode = getGameMode(GameModes.CLASSIC);

      vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(true);
      vi.spyOn(pvpApi, "request").mockResolvedValue({
        id: "drift-run-id",
        seed: "rogue-server-seed",
        contract: {
          auditPolicy: "outdated-generation-v1",
          rulesSHA256: "different-sha256",
          auditSchema: 99,
          harness: "outdated-harness",
        },
      });
      const showTextSpy = vi.spyOn(scene.ui, "showText");

      await expect(prepareRankedRun([])).resolves.toBeUndefined();

      expect(scene.gameMode.modeId).toBe(GameModes.CLASSIC);
      expect(scene.seed).toBe(initialSeed); // preserved, not overwritten with "rogue-server-seed"
      expect(recording()).toBe(false);

      expect(showTextSpy).toHaveBeenCalledOnce();
      const bannerText = String(showTextSpy.mock.calls[0][0]);
      expect(bannerText).toContain("비랭크 클래식: Error: 연승전 검증 규칙이 변경되었습니다");
    });

    it("falls back to unranked classic when upstream saveSystem fails", async () => {
      const scene = game.scene;
      const initialSeed = "unranked-classic-seed-sync-fail";
      scene.setSeed(initialSeed);
      scene.gameMode = getGameMode(GameModes.CLASSIC);

      vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(false);
      const requestSpy = vi.spyOn(pvpApi, "request");
      const showTextSpy = vi.spyOn(scene.ui, "showText");

      await expect(prepareRankedRun([])).resolves.toBeUndefined();

      expect(requestSpy).not.toHaveBeenCalled();
      expect(scene.gameMode.modeId).toBe(GameModes.CLASSIC);
      expect(scene.seed).toBe(initialSeed);
      expect(recording()).toBe(false);

      expect(showTextSpy).toHaveBeenCalledOnce();
      const bannerText = String(showTextSpy.mock.calls[0][0]);
      expect(bannerText).toContain("비랭크 클래식: Error: 시스템 동기화 실패");
    });

    it("continues unranked classic progression through waves and modifiers without unhandled errors", async () => {
      const scene = game.scene;
      const initialSeed = "unranked-classic-gameplay";
      scene.setSeed(initialSeed);
      scene.gameMode = getGameMode(GameModes.CLASSIC);

      // Trigger unranked fallback via 500 error
      vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(true);
      vi.spyOn(pvpApi, "request").mockRejectedValue(new Error("HTTP 500: Server Down"));
      await prepareRankedRun([]);

      expect(recording()).toBe(false);

      // Simulate wave progression in unranked classic
      scene.currentBattle.waveIndex = 2;
      const data = scene.gameData.getSessionSaveData();

      // recordWave should not throw and should not contact API or store runs
      const requestSpy = vi.spyOn(pvpApi, "request");
      requestSpy.mockClear();
      await expect(recordWave(data, true)).resolves.toBeUndefined();
      expect(requestSpy).not.toHaveBeenCalled();

      // Adding modifier and logging shop should not throw
      const modifier = getModifierType(modifierTypes.EXP_SHARE).newModifier() as PersistentModifier;
      scene.addModifier(modifier, true);
      expect(scene.modifiers).toContain(modifier);

      expect(() => {
        logItem(new ModifierData(modifier, true), "SelectModifierPhase");
        logShop({ rowCursor: 0, cursor: 0, rerolls: 1 });
      }).not.toThrow();

      // Saving and loading session in unranked classic
      vi.spyOn(scene.gameData, "getSession").mockResolvedValue(data);
      expect(await scene.gameData.loadSession(0)).toBe(true);
      expect(scene.seed).toBe(initialSeed);
      expect(scene.getPlayerParty()).toHaveLength(1);

      // Verify no PvP runs were ever created in localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        expect(key?.startsWith("pvp:")).toBe(false);
      }
    });
  });
});
