// SPDX-License-Identifier: AGPL-3.0-only
import { version } from "#package.json";
import { EggData } from "#system/egg-data";
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSession } from "../../../src/pvp/loader";
import native from "../../fixtures/pvp/native-save-1.12.1.2.json";

describe.runIf(version === "1.12.2.0")("Native 1.12.2 save compatibility", () => {
  let game: GameManager;
  beforeAll(async () => {
    game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
    await game.runToTitle();
  });
  const samples = [{ name: "1.12.1.2 native serializer", system: native.system, session: native.session }];
  if (process.env.PVP_UPGRADE_SYSTEM && process.env.PVP_UPGRADE_SESSION) {
    samples.push({
      name: "1.12.1.3 actual server save",
      system: JSON.parse(readFileSync(process.env.PVP_UPGRADE_SYSTEM, "utf8")),
      session: JSON.parse(readFileSync(process.env.PVP_UPGRADE_SESSION, "utf8")),
    });
  }
  it.each(samples)("preserves existing eggs and progress from $name", ({ system }) => {
    const data = GameData.fromRawSystem(JSON.stringify(system));
    const out = data.getSystemSaveData();
    expect(out.gameVersion).toBe(version);
    expect(out.trainerId).toBe(system.trainerId);
    expect(out.secretId).toBe(system.secretId);
    expect(out.gameStats).toMatchObject(system.gameStats);
    expect(out.unlocks).toEqual(system.unlocks);
    expect(out.achvUnlocks).toEqual(system.achvUnlocks);
    expect(out.eggs).toEqual((system.eggs ?? []).map(egg=>new EggData(egg)));
    for (const egg of out.eggs) {
      expect(new EggData(egg.toEgg())).toEqual(egg);
    }
    for (const [id, entry] of Object.entries(system.starterData)) {
      const { pity: _pity, ...before } = entry as typeof entry & { pity?: unknown };
      expect(out.starterData[Number(id)]).toMatchObject(before);
    }
    expect(out.voucherCounts).toEqual(system.voucherCounts);
    expect(out.eggPity).toEqual(system.eggPity);
    expect(out.unlockPity).toEqual(system.unlockPity);
    for(const [id,entry] of Object.entries(system.dexData)){
      const saved=out.dexData[Number(id)];
      expect(saved.caughtCount).toBe(entry.caughtCount);
      expect(saved.hatchedCount).toBe(entry.hatchedCount);
      expect(saved.caughtAttr).toBe(BigInt(entry.caughtAttr ?? 0));
      if(entry.ivs?.length){expect(saved.ivs).toEqual(entry.ivs);}
    }
    const second = GameData.fromRawSystem(
      JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).getSystemSaveData();
    expect(second.starterData).toEqual(out.starterData);
    expect(second.eggs).toEqual(out.eggs);
  });
  it.each(samples)("loads the party and held items from $name without overwriting them", async ({ session }) => {
    await loadSession(game.scene.gameData, game.scene.gameData.parseSessionData(JSON.stringify(session)));
    const out = game.scene.gameData.getSessionSaveData();
    expect(out.seed).toBe(session.seed);
    expect(out.waveIndex).toBe(session.waveIndex);
    for (const [i, p] of session.party.entries()) {
      for (const field of [
        "id",
        "species",
        "formIndex",
        "level",
        "ivs",
        "nature",
        "moveset",
        "fusionSpecies",
        "fusionFormIndex",
      ] as const) {
        expect(out.party[i][field] ?? null).toEqual(p[field] ?? null);
      }
    }
    const items = (mods: typeof out.modifiers) =>
      mods.map(m => ({
        className: m.className,
        typeId: m.typeId,
        player: m.player,
        stackCount: m.stackCount,
        args: m.args ?? [],
        typePregenArgs: m.typePregenArgs ?? [],
      }));
    expect(items(out.modifiers)).toEqual(items(session.modifiers as unknown as typeof out.modifiers));
  });
});
