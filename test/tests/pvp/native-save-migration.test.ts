// SPDX-License-Identifier: AGPL-3.0-only
import { GameModes } from "#enums/game-modes";
import { SpeciesId } from "#enums/species-id";
import { version } from "#package.json";
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSession } from "../../../src/pvp/loader";
import { setPvpMatchActive } from "../../../src/pvp/state";
import native from "../../fixtures/pvp/native-save-1.12.1.2.json";

describe("Saves exported by the pinned native 1.12.1.2 engine", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    setPvpMatchActive(false);
    game = new GameManager(phaser);
    await game.runToTitle();
    expect(native.source.nativeCommit).toBe("b271d3e63f82059da9bb93b01f69ec33ed7a10a0");
    expect(native.system.gameVersion).toBe("1.12.1.2");
    expect(native.session.gameVersion).toBe("1.12.1.2");
  });
  it("preserves real serialized system progress and egg stock through the native upgrade path", () => {
    const loaded = GameData.fromRawSystem(JSON.stringify(native.system));
    const output = loaded.getSystemSaveData();
    expect(output.gameVersion).toBe(version);
    expect(output.starterData[SpeciesId.BULBASAUR]).toMatchObject({
      candyCount: 42,
      friendship: 17,
      eggMoves: 5,
      valueReduction: 1,
      passiveAttr: 1,
    });
    expect(output.trainerId).toBe(native.system.trainerId);
    expect(output.secretId).toBe(native.system.secretId);
    expect(output.eggs).toEqual(native.system.eggs);
    expect(output.voucherCounts).toEqual(native.system.voucherCounts);
    expect(output.eggPity).toEqual(native.system.eggPity);
    expect(output.unlockPity).toEqual(native.system.unlockPity);
    const serialized = JSON.stringify(output, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(GameData.fromRawSystem(serialized).starterData).toEqual(loaded.starterData);
  });
  it("loads the old engine's actual classic session and preserves both parties on round trip", async () => {
    const data = game.scene.gameData;
    await loadSession(data, data.parseSessionData(JSON.stringify(native.session)));
    const output = data.getSessionSaveData();
    expect(output.gameVersion).toBe(version);
    expect(output.gameMode).toBe(GameModes.CLASSIC);
    expect(output.seed).toBe(native.session.seed);
    expect(output.waveIndex).toBe(native.session.waveIndex);
    const identities = (
      party: readonly {
        id: number;
        species: number;
        formIndex: number;
        level: number;
        ivs: readonly number[];
        moveset: unknown;
      }[],
    ) =>
      party.map(p => ({
        id: p.id,
        species: p.species,
        formIndex: p.formIndex,
        level: p.level,
        ivs: p.ivs,
        moveset: p.moveset,
      }));
    expect(identities(output.party)).toEqual(identities(native.session.party));
    expect(identities(output.enemyParty)).toEqual(identities(native.session.enemyParty));
    expect(output.modifiers).toEqual(native.session.modifiers);
  });
});
