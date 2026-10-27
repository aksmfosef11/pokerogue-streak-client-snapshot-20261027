// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { BerryType } from "#enums/berry-type";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import type { PersistentModifier } from "#modifiers/modifier";
import type { ModifierTypeOption } from "#modifiers/modifier-type";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { GameManager } from "#test/framework/game-manager";
import { gunzipSync, gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAuditSession, validateAuditModifiers } from "../../../src/pvp/audit-input";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { MAX_AUDIT_ITEMS, MAX_AUDIT_WAVE_BYTES } from "../../../src/pvp/audit-limits";
import { replayShop } from "../../../src/pvp/audit-shop";
import { serialCopy } from "../../../src/pvp/generation";
import { optionData, type ShopOffer, shopSettings } from "../../../src/pvp/shop";

describe("Native large-inventory registration capacity", () => {
  let game: GameManager;
  beforeAll(async () => {
    game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
    await game.classicMode.startBattle(
      SpeciesId.BULBASAUR,
      SpeciesId.CHARMANDER,
      SpeciesId.SQUIRTLE,
      SpeciesId.PIKACHU,
      SpeciesId.EEVEE,
      SpeciesId.ABRA,
    );
    const party = game.scene.getPlayerParty();
    for (const pokemon of party) {
      pokemon.ivs.fill(31);
      const types = [
        ...Array.from({ length: PokemonType.FAIRY + 1 }, (_, type) => ["ATTACK_TYPE_BOOSTER", type] as const),
        ...Array.from({ length: BerryType.LEPPA + 1 }, (_, berry) => ["BERRY", berry] as const),
        ...Array.from({ length: Stat.SPD + 1 }, (_, stat) => ["BASE_STAT_BOOSTER", stat] as const),
      ];
      for (const [id, arg] of types) {
        const type = generateModifierType(modifierTypes[id], [arg])!;
        const item = type.newModifier(pokemon) as PersistentModifier;
        game.scene.addModifier(item, true);
        expect(game.scene.modifiers, `${pokemon.id}:${id}:${arg}`).toContain(item);
      }
    }
    expect(game.scene.modifiers).toHaveLength(210);
  });
  it("loads and verifies 210 distinct native held-item stacks on six owners", () => {
    const data = serialCopy(game.scene.gameData.getSessionSaveData());
    const audit = new InventoryAudit();
    const ids = new Set(data.party.map(p => p.id));
    for (const item of data.modifiers) {
      audit.grant({ base: canonicalItem(item).base, count: 1, source: "SelectModifierPhase" });
      audit.acquire(item, "SelectModifierPhase", ids);
    }
    expect(() => audit.observe(data.party, data.modifiers)).not.toThrow();
    expect(parseAuditSession(game.scene.gameData, data, data.seed).modifiers).toHaveLength(210);
  });
  it("replays native affordable rerolls whose wave exceeds the old 256 KiB expansion limit", async () => {
    game.scene.currentBattle.waveIndex = 100;
    game.scene.money = 9999999;
    const offers: ShopOffer[] = [];
    let phase = new SelectModifierPhase();
    let priorRng: string | undefined;
    const seed = game.scene.seed;
    for (let index = 0; index < 32; index++) {
      phase.start();
      const options = Reflect.get(phase, "typeOptions") as ModifierTypeOption[];
      offers.push(
        serialCopy({
          kind: "offer",
          ...shopSettings(phase),
          session: game.scene.gameData.getSessionSaveData(),
          locked: false,
          options: options.map(optionData),
        }),
      );
      const cost = phase.getRerollCost(false);
      if (cost < 0 || game.scene.money < cost) {
        break;
      }
      // The same native cost and tier continuation used by rerollModifiers().
      game.scene.money -= cost;
      phase = new SelectModifierPhase(
        index + 1,
        options.map(option => option.type.tier!),
      );
    }
    expect(offers.length).toBeGreaterThan(5);
    const raw = JSON.stringify({ shops: offers });
    const compressedBytes = Buffer.byteLength(`gz:${gzipSync(raw).toString("base64")}`);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(256 * 1024);
    expect(Buffer.byteLength(raw)).toBeLessThan(MAX_AUDIT_WAVE_BYTES);
    expect(compressedBytes).toBeLessThan(65536);
    expect(gunzipSync(gzipSync(raw), { maxOutputLength: MAX_AUDIT_WAVE_BYTES }).toString()).toBe(raw);
    for (const offer of offers) {
      const replay = await replayShop(game.scene, offer, seed, priorRng);
      expect(replay.options).toEqual(offer.options);
      priorRng = replay.rng;
    }
    console.info(
      JSON.stringify({ stacks: 210, offers: offers.length, rawBytes: Buffer.byteLength(raw), compressedBytes }),
    );
  });
  it("retains a finite stack-array limit before loading the native scene", () => {
    const data = game.scene.gameData.getSessionSaveData();
    const oversized = Array.from({ length: MAX_AUDIT_ITEMS + 1 }, () => data.modifiers[0]);
    expect(() => validateAuditModifiers(oversized, "oversized native inventory")).toThrow(/invalid audit input/);
  });
});
