// SPDX-License-Identifier: AGPL-3.0-only

import { BattleScene } from "#app/battle-scene";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { UiMode } from "#enums/ui-mode";
import { version } from "#package.json";
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { PartyOption } from "#ui/party-ui-handler";
import { createHmac } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pvpApi } from "../../../src/pvp/api";
import { battleDigest } from "../../../src/pvp/battle-state";
import {
  handlePvpForfeit,
  handlePvpLoss,
  handlePvpSwitch,
  handlePvpVictory,
  pausePvpTurn,
  replayPvpCommand,
} from "../../../src/pvp/index";
import { installBattleHooks } from "../../../src/pvp/runtime";
// biome-ignore lint/performance/noNamespaceImport: Enable the production controller only after the native fixture is ready.
import * as state from "../../../src/pvp/state";
import fixture from "../../fixtures/pvp/session.json";

describe("Complete native PvP victory through the production controller", () => {
  let phaser: Phaser.Game;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  afterEach(() => {
    installBattleHooks({
      handlePvpForfeit,
      handlePvpLoss,
      handlePvpSwitch,
      handlePvpVictory,
      pausePvpTurn,
      replayPvpCommand,
    })();
    state.setPvpMatchActive(false);
    vi.unstubAllGlobals();
  });
  it("wins with native AI, Sword Dance/Baton Pass, lost switch/result responses, and isolated saves", async () => {
    state.setPvpMatchActive(false);
    const enabled = vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(false);
    const game = new GameManager(phaser);
    BattleScene.prototype.randBattleSeedInt = function (range, min = 0) {
      return this.currentBattle?.randSeedInt(range, min);
    };
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    // This is a controlled synthetic battle profile; source/earning audits are
    // separate. All damage, AI, PP, stat transfer and fainting below are native.
    const input = structuredClone(fixture);
    input.gameVersion = version;
    input.seed = "pvp-native-victory-v1";
    for (const pokemon of input.party) {
      pokemon.level = 200;
      pokemon.moveset = [{ moveId: MoveId.TACKLE, ppUsed: 0, ppUp: 0 }];
    }
    input.party[0].moveset = [MoveId.SWORDS_DANCE, MoveId.BATON_PASS, MoveId.TACKLE].map(moveId => ({
      moveId,
      ppUsed: 0,
      ppUp: 0,
    }));
    for (const pokemon of input.enemyParty) {
      pokemon.level = 5;
      pokemon.moveset = [{ moveId: MoveId.TACKLE, ppUsed: 0, ppUp: 0 }];
    }
    Reflect.set(game.reload, "sessionData", game.scene.gameData.parseSessionData(JSON.stringify(input)));
    await game.reload.reloadSession();
    const scene = game.scene;
    let wins = 0;
    let droppedSwitch = false;
    let droppedResult = false;
    let ended = false;
    let batonTransferred = false;
    const decisions: any[] = [];
    const requests: any[] = [];
    const server = {
      id: "native-victory",
      practice: true,
      opponent: "native controlled trainer",
      session: input,
      decisions,
      status: "active",
      expires: Math.floor(Date.now() / 1000) + 1800,
    };
    vi.spyOn(pvpApi, "request").mockImplementation(async (path, body) => {
      requests.push({ path, body: structuredClone(body) });
      if (path === "egg-tickets") {
        return { epoch: 1, usedThrough: 0, tickets: [], certifiedIds: [] };
      }
      if (path === "status") {
        return { match: structuredClone(server), practiceStreak: wins, streak: 0, runs: {}, flags: [] };
      }
      if (path === "commit") {
        const data = body as any;
        let decision = decisions[data.index];
        if (decision) {
          expect(data.digest).toBe(decision.digest);
          expect(data.kind).toBe(decision.kind);
        } else {
          expect(data.index).toBe(decisions.length);
          decision = {
            ...structuredClone(data),
            seed: createHmac("sha256", "native-victory-secret").update(String(data.index)).digest("hex"),
          };
          decisions.push(decision);
        }
        if (data.kind === "switch" && !droppedSwitch) {
          droppedSwitch = true;
          throw new Error("native switch receipt lost after save");
        }
        return structuredClone(decision);
      }
      if (path === "finish") {
        expect(body!.index).toBe(decisions.length);
        expect(body!.result).toBe("won");
        expect((body!.enemyHP as number[]).every(hp => hp === 0)).toBe(true);
        expect((body!.playerHP as number[]).some(hp => hp > 0)).toBe(true);
        if (server.status === "active") {
          server.status = "won";
          wins++;
        }
        if (!droppedResult) {
          droppedResult = true;
          throw new Error("native victory receipt lost after save");
        }
        return structuredClone(server);
      }
      throw new Error(`unexpected native battle request: ${path}`);
    });
    const setMode = scene.ui.setMode;
    vi.spyOn(scene.ui, "setMode").mockImplementation(async (mode, ...args) => {
      if (state.isPvpMatchActive() && mode === UiMode.PARTY) {
        const slot = scene
          .getPlayerParty()
          .findIndex((pokemon, index) => index >= scene.currentBattle.getBattlerCount() && !pokemon.isFainted());
        expect(slot).toBeGreaterThan(0);
        queueMicrotask(() => (args[2] as (slot: number, option: PartyOption) => void)(slot, PartyOption.SEND_OUT));
        return;
      }
      await setMode.call(scene.ui, mode, ...args);
      const config = args[0] as any;
      if (mode === UiMode.OPTION_SELECT && config?.options?.[0]?.label === "다시 시도") {
        queueMicrotask(() => config.options[0].handler());
      }
    });
    const showText = scene.ui.showText;
    vi.spyOn(scene.ui, "showText").mockImplementation((text, delay, next, ...args) => {
      if (/^(연습 연승전|연승전 ·|연습전 |연승전:)/.test(text)) {
        if (next) {
          queueMicrotask(next);
        }
        return;
      }
      return showText.call(scene.ui, text, delay, next, ...args);
    });
    vi.stubGlobal("location", {
      hostname: "localhost",
      reload: vi.fn(),
    });
    // Keep the final battlers for this battle transcript; navigation/reset is
    // exercised separately. Release the native turn observer at the lobby handoff.
    const cleanup = vi.spyOn(scene, "reset").mockImplementation(() => {});
    vi.spyOn(scene.phaseManager, "toTitleScreen").mockImplementation(() => {
      ended = true;
      scene.phaseManager.unshiftNew("TurnEndPhase");
    });
    enabled.mockReturnValue(true);
    // Enter through the actual title hook: its loaded-session continuation
    // runs Encounter/Summon before the first command, as a browser reload does.
    scene.phaseManager.clearPhaseQueue();
    scene.phaseManager.pushNew("TitlePhase");
    scene.phaseManager.getCurrentPhase().end();
    await game.phaseInterceptor.to("CommandPhase", false);
    expect(state.isPvpMatchActive()).toBe(true);
    const defeated = scene.gameData.gameStats.pokemonDefeated;
    const candy = JSON.stringify(scene.gameData.starterData);
    localStorage.setItem("ordinary-victory-proof", "retained");
    const transcript: { turn: number; digest: string; hp: number[] }[] = [];
    for (let turn = 0; turn < 30 && !ended; turn++) {
      const phase = scene.phaseManager.getCurrentPhase();
      expect(phase.phaseName).toBe("CommandPhase");
      const move = turn === 0 ? 0 : turn === 1 ? 1 : 0;
      expect(Reflect.get(phase, "handleCommand").call(phase, Command.FIGHT, move)).toBe(true);
      await game.toEndOfTurn(false);
      transcript.push({
        turn: scene.currentBattle.turn,
        digest: battleDigest(scene),
        hp: [...scene.getPlayerParty(), ...scene.getEnemyParty()].map(p => p.hp),
      });
      if (turn === 1) {
        expect(scene.getPlayerParty()[0].getStatStage(Stat.ATK)).toBe(2);
        batonTransferred = true;
      }
      if (!ended) {
        expect(await GameData.prototype.saveSystem.call(scene.gameData)).toBe(true);
        expect(await GameData.prototype.saveAll.call(scene.gameData, true, true)).toBe(true);
      }
      expect(localStorage.getItem("ordinary-victory-proof")).toBe("retained");
      if (!ended) {
        await game.toNextTurn();
      }
    }
    expect(ended).toBe(true);
    expect(cleanup).toHaveBeenCalledWith(false, false);
    expect(location.reload).not.toHaveBeenCalled();
    expect(server.status).toBe("won");
    expect(wins).toBe(1);
    expect(batonTransferred && droppedSwitch && droppedResult).toBe(true);
    expect(decisions.filter(d => d.kind === "switch")).toHaveLength(1);
    expect(requests.filter(r => r.path === "finish")).toHaveLength(2);
    expect(scene.getEnemyParty().every(p => p.isFainted())).toBe(true);
    expect(scene.gameData.gameStats.pokemonDefeated).toBe(defeated);
    expect(JSON.stringify(scene.gameData.starterData)).toBe(candy);
    await expect({ decisions, transcript }).toMatchFileSnapshot("./snapshots/battle-victory.snap");
  }, 120000);
});
