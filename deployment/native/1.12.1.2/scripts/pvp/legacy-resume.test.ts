// SPDX-License-Identifier: AGPL-3.0-only
import { Command } from "#enums/command";
import { SpeciesId } from "#enums/species-id";
import { BattleStyle } from "#enums/battle-style";
import { settings } from "#app/global-settings-manager";
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { loadAuditLocale } from "./audit-locale";
it("resumes a stored old-version run and executes its next actual native turn", async () => {
  const input = JSON.parse(readFileSync(process.env.PVP_PROGRESS_INPUT!, "utf8"));
  const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
  await game.classicMode.startBattle(SpeciesId.BULBASAUR);
  await loadAuditLocale("ko");
  game.scene.gameData = GameData.fromRawSystem(JSON.stringify(input.system));
  settings.general.battleStyle = BattleStyle.SET;
  Reflect.set(game.reload, "sessionData", game.scene.gameData.parseSessionData(JSON.stringify(input.session)));
  await game.reload.reloadSession();
  const scene = game.scene;
  vi.spyOn(scene.gameData, "saveAll").mockResolvedValue(true);
  const phase = scene.phaseManager.getCurrentPhase();
  expect(Reflect.get(phase, "handleCommand").call(phase, Command.FIGHT, 0)).toBe(true);
  await game.toEndOfTurn(false);
  const system = game.scene.gameData.getSystemSaveData(),
    session = game.scene.gameData.getSessionSaveData();
  expect(session.gameVersion).toBe(input.session.gameVersion);
  expect(session.seed).toBe(input.session.seed);
  expect(system.eggs.map(e => e.id)).toEqual(input.system.eggs.map((e: any) => e.id));
  writeFileSync(
    process.env.PVP_PROGRESS_OUTPUT!,
    JSON.stringify({ system, session }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
});
