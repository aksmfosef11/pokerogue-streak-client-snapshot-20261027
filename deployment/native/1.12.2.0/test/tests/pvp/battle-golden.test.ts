// SPDX-License-Identifier: AGPL-3.0-only
import { BattleScene } from "#app/battle-scene";
import { Command } from "#enums/command";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import { createHmac } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { battleDigest, reseedBattle } from "../../../src/pvp/battle-state";
import { installBattleHooks } from "../../../src/pvp/runtime";
import { setPvpMatchActive } from "../../../src/pvp/state";
import fixture from "../../fixtures/pvp/session.json";

describe("PvP full battle determinism", () => {
  let phaser: Phaser.Game;
  let restore: (() => void) | undefined;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
    setPvpMatchActive(false);
  });
  it("matches the complete HP/status/PP digest transcript with real battle RNG and trainer AI", async () => {
    const game = new GameManager(phaser);
    // GameManager normally replaces this with max rolls. The golden must use
    // the upstream implementation, including its independent cached RNG state.
    BattleScene.prototype.randBattleSeedInt = function (range, min = 0) {
      return this.currentBattle?.randSeedInt(range, min);
    };
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    Reflect.set(
      game.reload,
      "sessionData",
      game.scene.gameData.parseSessionData(JSON.stringify({ ...fixture, seed: "pvp-full-battle-v1" })),
    );
    await game.reload.reloadSession();
    const scene = game.scene;
    for (const p of [...scene.getPlayerParty(), ...scene.getEnemyParty()]) {
      p.calculateStats();
      p.hp = p.stats[0];
      p.status = null;
    }
    let index = 0;
    let ended = false;
    let committed = -1;
    const transcript: unknown[] = [];
    function commit(kind: string, choice: unknown) {
      const seed = createHmac("sha256", "pvp-golden-secret").update(`golden-match:${index}`).digest("hex");
      transcript.push({ index: index++, kind, choice, digest: battleDigest(scene) });
      reseedBattle(scene, seed);
    }
    restore = installBattleHooks({
      handlePvpForfeit: () => false,
      replayPvpCommand: () => false,
      pausePvpTurn: () => {
        if (committed !== scene.currentBattle.turn) {
          commit("turn", JSON.parse(JSON.stringify(scene.currentBattle.turnCommands[0])));
          committed = scene.currentBattle.turn;
        }
        return false;
      },
      handlePvpSwitch: (phase, field, type, doReturn) => {
        const slot = scene
          .getPlayerParty()
          .findIndex((p, i) => i >= scene.currentBattle.getBattlerCount() && !p.isFainted());
        expect(slot).toBeGreaterThanOrEqual(1);
        commit("switch", { slotIndex: slot });
        scene.phaseManager.unshiftNew("SwitchSummonPhase", type, field, slot, doReturn);
        void scene.ui.setMode(UiMode.MESSAGE).then(() => phase.end());
        return true;
      },
      handlePvpVictory: end => {
        ended = scene.getEnemyParty().every(p => p.isFainted());
        end();
        return true;
      },
      handlePvpLoss: () => {
        ended = true;
        scene.phaseManager.unshiftNew("TurnEndPhase");
        scene.phaseManager.getCurrentPhase().end();
        return true;
      },
    });
    setPvpMatchActive(true);
    for (let turn = 0; turn < 80 && !ended; turn++) {
      const p = scene.getPlayerPokemon()!;
      const position = p.getMoveset().findIndex(m => m.ppUsed < m.getMovePp());
      expect(position).toBeGreaterThanOrEqual(0);
      const phase = scene.phaseManager.getCurrentPhase();
      expect(phase.phaseName).toBe("CommandPhase");
      expect(Reflect.get(phase, "handleCommand").call(phase, Command.FIGHT, position)).toBe(true);
      await game.toEndOfTurn(false);
      transcript.push({
        afterTurn: scene.currentBattle.turn,
        digest: battleDigest(scene),
        hp: [...scene.getPlayerParty(), ...scene.getEnemyParty()].map(mon => mon.hp),
      });
      if (!ended) {
        await game.toNextTurn();
      }
    }
    expect(ended).toBe(true);
    expect(index).toBeGreaterThan(3);
    await expect(transcript).toMatchFileSnapshot("./snapshots/battle-golden.snap");
  }, 120000);
});
