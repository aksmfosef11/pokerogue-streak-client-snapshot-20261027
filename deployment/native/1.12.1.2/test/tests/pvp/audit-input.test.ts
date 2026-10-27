// SPDX-License-Identifier: AGPL-3.0-only
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import type { SessionSaveData } from "#types/save-data";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditInputError } from "../../../src/pvp/audit-errors";
import { parseAuditSession } from "../../../src/pvp/audit-input";
import { serialCopy } from "../../../src/pvp/generation";

describe("Audit input validation before the upstream loader", () => {
  let game: GameManager;
  let baseline: SessionSaveData;
  beforeAll(async () => {
    game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    baseline = serialCopy(game.scene.gameData.getSessionSaveData());
  });
  it("loads the actual session without accepting the client seed", () => {
    const data = parseAuditSession(game.scene.gameData, baseline, "server-seed");
    expect(data.seed).toBe("server-seed");
    expect(data.party[0].species).toBe(SpeciesId.BULBASAUR);
  });
  it.each([
    ["unknown species", (s: SessionSaveData) => Reflect.set(s.party[0], "species", 999999)],
    ["unknown move", (s: SessionSaveData) => Reflect.set(s.party[0], "moveset", [{ moveId: 999999 }])],
    ["null move", (s: SessionSaveData) => Reflect.set(s.party[0], "moveset", [null])],
    ["null party member", (s: SessionSaveData) => Reflect.set(s, "party", [null])],
    ["duplicate individual", (s: SessionSaveData) => s.party.push(serialCopy(s.party[0]))],
    ["nonexistent form", (s: SessionSaveData) => Reflect.set(s.party[0], "formIndex", 999)],
    ["unbounded level", (s: SessionSaveData) => Reflect.set(s.party[0], "level", 1000001)],
    [
      "unknown custom ability",
      (s: SessionSaveData) => Reflect.set(s.party[0], "customPokemonData", { ability: 999999 }),
    ],
    [
      "fractional custom passive",
      (s: SessionSaveData) => Reflect.set(s.party[0], "customPokemonData", { passive: 1.5 }),
    ],
    [
      "invalid fusion ability",
      (s: SessionSaveData) => Reflect.set(s.party[0], "fusionCustomPokemonData", { ability: -2 }),
    ],
    [
      "unknown modifier",
      (s: SessionSaveData) =>
        Reflect.set(s, "modifiers", [{ typeId: "TO_STRING", className: "PersistentModifier", stackCount: 1 }]),
    ],
    ["null arena", (s: SessionSaveData) => Reflect.set(s, "arena", null)],
    ["unknown biome", (s: SessionSaveData) => Reflect.set(s.arena, "biome", 999)],
    ["malformed summon data", (s: SessionSaveData) => Reflect.set(s.party[0], "summonData", { types: 99 })],
  ] as const)("permanently rejects %s", (_name, change) => {
    const input = serialCopy(baseline);
    change(input);
    const battle = game.scene.currentBattle;
    expect(() => parseAuditSession(game.scene.gameData, input, "server-seed")).toThrow(AuditInputError);
    expect(game.scene.currentBattle).toBe(battle);
  });
});
