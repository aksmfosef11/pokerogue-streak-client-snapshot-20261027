// SPDX-License-Identifier: AGPL-3.0-only
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
it("creates an isolated automation account's native system save", async () => {
  const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
  await game.runToTitle();
  const data = new GameData();
  data.starterData[1].candyCount = 100;
  Object.assign(data.dexData[717], {
    seenAttr: 243n,
    caughtAttr: 243n,
    natureAttr: 67108862,
    seenCount: 1,
    caughtCount: 1,
    ivs: [31, 31, 31, 31, 31, 31],
  });
  Object.assign(data.starterData[717], {
    moveset: [822, 617, 482, 840],
    eggMoves: 15,
    passiveAttr: 3,
    valueReduction: 2,
    abilityAttr: 1,
    candyCount: 100,
  });
  const save = data.getSystemSaveData();
  expect(save.gameVersion).toMatch(/^1\.12\./);
  writeFileSync(
    process.env.PVP_AUTOMATION_SEED_OUTPUT!,
    JSON.stringify(save, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
});
