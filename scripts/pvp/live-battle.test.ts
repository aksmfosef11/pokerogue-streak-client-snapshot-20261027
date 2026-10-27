// SPDX-License-Identifier: AGPL-3.0-only
// Uses the real HTTP service and unmodified audited parties. Never fabricates results.
import { BattleScene } from "#app/battle-scene";
import { allMoves } from "#data/data-lists";
import { Command } from "#enums/command";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { version } from "#package.json";
import { GameManager } from "#test/framework/game-manager";
import { PartyOption } from "#ui/party-ui-handler";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { pvpApi } from "../../src/pvp/api";
import * as state from "../../src/pvp/state";
import { loadAuditLocale } from "./audit-locale";

it("completes an actual ranked match through native phases and the production HTTP controller", async () => {
  const account = JSON.parse(readFileSync(process.env.PVP_BATTLE_ACCOUNT!, "utf8"));
  const server = process.env.PVP_SERVER_URL || "http://server:8001";
  global.server?.close();
  const http = globalThis.fetch;
  const request = async (path: string, body?: unknown) => {
    const res = await http(`${server}/pvp/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: account.token,
        "Content-Type": "application/json",
        "PKR-Client-Version": version,
        "PKR-PVP-Source-Version": account.version,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const initial = await request("status");
  const match =
    initial.match?.status === "active" ? initial.match : await request("matches", { practice: false, version, ...(account.teamId ? { teamId: account.teamId } : {}) });
  expect(match.session.gameVersion).toBe(version);
  await loadAuditLocale("ko");
  state.setPvpMatchActive(false);
  const enabled = vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(false);
  const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
  game.override.disableShinies = false;
  game.override.normalizeIVs = false;
  game.override.normalizeNatures = false;
  game.override.removeEnemyStartingItems = false;
  BattleScene.prototype.randBattleSeedInt = function (range, min = 0) {
    return this.currentBattle?.randSeedInt(range, min);
  };
  await game.classicMode.startBattle(SpeciesId.BULBASAUR);
  const scene = game.scene;
  let ended = false;
  let final: any;
  vi.spyOn(pvpApi, "request").mockImplementation(async (path, body) => {
    const response = await request(path, body);
    if (path === "finish") final = response;
    return response;
  });
  const setMode = scene.ui.setMode;
  vi.spyOn(scene.ui, "setMode").mockImplementation(async (mode, ...args) => {
    if (state.isPvpMatchActive() && mode === UiMode.PARTY) {
      const slot = scene
        .getPlayerParty()
        .findIndex((p, i) => i >= scene.currentBattle.getBattlerCount() && !p.isFainted());
      expect(slot).toBeGreaterThan(0);
      queueMicrotask(() => (args[2] as (slot: number, option: PartyOption) => void)(slot, PartyOption.SEND_OUT));
      return;
    }
    await setMode.call(scene.ui, mode, ...args);
  });
  const showText = scene.ui.showText;
  vi.spyOn(scene.ui, "showText").mockImplementation((text, delay, next, ...args) => {
    if (final && /^(연습전|연승전) (승리|패배|무효|시간 초과)/.test(text)) {
      ended = true;
      scene.phaseManager.unshiftNew("TurnEndPhase");
      scene.phaseManager.getCurrentPhase().end();
      return;
    }
    if (/^(연습 연승전|연승전 ·|연습전 |연승전:|연승전 승리|연승전 패배)/.test(text)) {
      if (next) queueMicrotask(next);
      return;
    }
    return showText.call(scene.ui, text, delay, next, ...args);
  });
  const leave = () => {
    ended = true;
    scene.phaseManager.unshiftNew("TurnEndPhase");
    scene.phaseManager.getCurrentPhase().end();
  };
  vi.stubGlobal("location", {
    hostname: "localhost",
    pathname: `/engines/${version}/`,
    href: `http://localhost/engines/${version}/?pvpBattle=${account.version}`,
    search: `?pvpBattle=${account.version}`,
    reload: leave,
    replace: leave,
  });
  enabled.mockReturnValue(true);
  scene.phaseManager.clearPhaseQueue();
  scene.phaseManager.pushNew("TitlePhase");
  scene.phaseManager.getCurrentPhase().end();
  await game.phaseInterceptor.to("CommandPhase");
  const transcript: { turn: number; playerHP: number[]; enemyHP: number[] }[] = [];
  for (let turn = 0; turn < 150 && !ended; turn++) {
    const phase = scene.phaseManager.getCurrentPhase();
    expect(["CommandPhase", "EnemyCommandPhase"]).toContain(phase.phaseName);
    const p = scene.getPlayerParty()[0],
      enemy = scene.getEnemyField()[0];
    const choices = p
      .getMoveset()
      .map((pm, i) => {
        const move = allMoves[pm.moveId];
        const eff = enemy?.getAttackTypeEffectiveness(move.type, { source: p, move, simulated: true }) ?? 1;
        return {
          i,
          score: pm.isUsable(p, false, true)[0]
            ? (move.power || 1)
              * eff
              * (p.isOfType(move.type) ? 1.5 : 1)
              * (pm.moveId === 613 && p.getHpRatio() < 0.6 ? 2 : 1)
            : -1,
        };
      })
      .sort((a, b) => b.score - a.score);
    if (phase.phaseName === "CommandPhase")
      expect(Reflect.get(phase, "handleCommand").call(phase, Command.FIGHT, choices[0]?.i ?? -1)).toBe(true);
    await game.toEndOfTurn(false);
    transcript.push({
      turn: scene.currentBattle.turn,
      playerHP: scene.getPlayerParty().map(p => p.hp),
      enemyHP: scene.getEnemyParty().map(p => p.hp),
    });
    if (!ended) await game.toNextTurn();
  }
  expect(ended, "native battle must finish").toBe(true);
  expect(["won", "lost"]).toContain(final?.status);
  const status = await request("status");
  expect(status.match.id).toBe(match.id);
  expect(status.match.status).toBe(final.status);
  writeFileSync(
    process.env.PVP_BATTLE_RESULT!,
    JSON.stringify(
      {
        username: account.username,
        sourceVersion: account.version,
        opponent: match.opponent,
        opponentVersion: match.opponentVersion,
        engine: version,
        matchId: match.id,
        result: final.status,
        decisions: status.match.decisions.length,
        streak: status.streak,
        best: status.best,
        transcript,
      },
      null,
      2,
    ),
  );
}, 600000);
