// SPDX-License-Identifier: AGPL-3.0-only

import { pokerogueApi } from "#api/api";
import { loggedInUser, updateUserInfo } from "#app/account";
import { Egg } from "#data/egg";
import { EggSourceType } from "#enums/egg-source-types";
import { SpeciesId } from "#enums/species-id";
import { version } from "#package.json";
import type { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pvpApi } from "../../../src/pvp/api";
import { installEggProofHooks, refreshEggTickets } from "../../../src/pvp/egg-proof";
import * as pvpState from "../../../src/pvp/state";
import { setPvpMatchActive } from "../../../src/pvp/state";

class SaveTarget {
  success = true;
  sent: any;
  getSystemSaveData() {
    return { ordinary: "retained" };
  }
  async saveSystem() {
    this.sent = this.getSystemSaveData();
    return this.success;
  }
  async saveAll() {
    return this.saveSystem();
  }
}
class GachaTarget {
  pullEggs(count: number) {
    return Array.from({ length: count }, () => new Egg({ sourceType: EggSourceType.GACHA_MOVE, pulled: true }));
  }
}
describe("Egg proof client journal", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let save: SaveTarget;
  let pool: any;
  const stored = () =>
    JSON.parse(
      localStorage.getItem(
        `pvp:eggs:${Number(version.split(".")[2]) >= 2 ? version + ":" : ""}${loggedInUser?.username}`,
      )!,
    );
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    setPvpMatchActive(false);
    localStorage.clear();
    game = new GameManager(phaser);
    await game.runToTitle();
    vi.spyOn(pvpState, "pvpEnabled", "get").mockReturnValue(true);
    vi.spyOn(pokerogueApi.account, "getInfo").mockResolvedValue([
      { username: "egg-client-test", lastSessionSlot: -1, discordId: "", googleId: "", hasAdminRole: false },
      200,
    ]);
    await updateUserInfo();
    expect(loggedInUser).not.toBeNull();
    game.scene.newBattle();
    game.scene.gameData.eggs = [];
    save = new SaveTarget();
    installEggProofHooks(save as unknown as GameData, GachaTarget.prototype, Egg.prototype);
    pool = {
      epoch: 1,
      usedThrough: 0,
      tickets: Array.from({ length: 64 }, (_, i) => ({
        id: `ticket-${i + 1}`,
        sequence: i + 1,
        seed: `server-seed-${i + 1}`,
        issued: Date.now(),
      })),
      certifiedIds: [],
    };
    vi.spyOn(pvpApi, "request").mockImplementation(async () => structuredClone(pool));
    await refreshEggTickets();
  });
  afterAll(() => setPvpMatchActive(false));
  it("consumes FIFO once and does not reinsert locally spent tickets on a stale refresh", async () => {
    const egg = new Egg({
      scene: game.scene,
      sourceType: EggSourceType.SAME_SPECIES_EGG,
      species: SpeciesId.BULBASAUR,
    });
    egg.addEggToGameData();
    expect(stored().receipts[0].sequence).toBe(1);
    expect(stored().receipts[0].options.scene).toBeUndefined();
    expect(stored().tickets[0].sequence).toBe(2);
    await refreshEggTickets();
    expect(stored().tickets[0].sequence).toBe(2);
    expect(JSON.stringify(save.getSystemSaveData())).toContain("pvpEggProofs");
  });
  it("keeps receipts after a failed save and acknowledges only successful saves", async () => {
    new Egg({ sourceType: EggSourceType.GACHA_MOVE, pulled: true });
    save.success = false;
    expect(await save.saveSystem()).toBe(false);
    expect(stored().receipts).toHaveLength(1);
    save.success = true;
    expect(await save.saveSystem()).toBe(true);
    await refreshEggTickets();
    expect(save.sent.pvpEggProofs).toHaveLength(1);
    expect(stored().receipts).toHaveLength(0);
    expect(stored().tickets[0].sequence).toBe(2);
  });
  it("marks depleted-ticket fallback unverified and still records it in the existing save", async () => {
    pool.tickets = [];
    await refreshEggTickets();
    const egg = new Egg({ sourceType: EggSourceType.SAME_SPECIES_EGG, species: SpeciesId.BULBASAUR });
    expect(stored().receipts[0].sequence).toBeUndefined();
    expect(stored().receipts[0].seed).toHaveLength(24);
    expect(egg.getEggTypeDescriptor()).toContain("미인증");
  });
  it("does not consume a ticket while loading an existing egg or inside a synthetic match", () => {
    new Egg({ id: 123, species: SpeciesId.BULBASAUR, sourceType: EggSourceType.SAME_SPECIES_EGG, eggMoveIndex: 0 });
    expect(stored().receipts).toHaveLength(0);
    setPvpMatchActive(true);
    new Egg({ sourceType: EggSourceType.GACHA_MOVE, pulled: true });
    expect(stored().receipts).toHaveLength(0);
    expect(save.getSystemSaveData()).toEqual({ ordinary: "retained" });
  });
  it("records complete gacha batch order for guarantee verification", () => {
    new GachaTarget().pullEggs(10);
    const records = stored().receipts;
    expect(records.map((r: any) => r.batch.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(records.map((r: any) => r.batch.id)).size).toBe(1);
    expect(records.every((r: any) => r.batch.size === 10)).toBe(true);
  });
});
