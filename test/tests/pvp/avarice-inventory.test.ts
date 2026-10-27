// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { BerryType } from "#enums/berry-type";
import { SpeciesId } from "#enums/species-id";
import { BerryModifier, type PersistentModifier } from "#modifiers/modifier";
import { AbsoluteAvariceEncounter } from "#mystery-encounters/absolute-avarice-encounter";
// biome-ignore lint/performance/noNamespaceImport: Stub only transition animations while executing the native reward option.
import * as encounterPhases from "#mystery-encounters/encounter-phase-utils";
import { ModifierData } from "#system/modifier-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { encounterItemGrants } from "../../../src/pvp/audit-item-sources";

describe("Absolute Avarice inventory escrow", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let audit: InventoryAudit;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
    game.scene.currentBattle.waveIndex = 80;
    audit = new InventoryAudit();
    for (const berryType of [BerryType.SITRUS, BerryType.LEPPA, BerryType.LUM]) {
      const berry = item("BERRY", [berryType]);
      berry.stackCount = 2;
      const data = new ModifierData(berry, true);
      audit.grant({ base: canonicalItem(data).base, count: 2, source: "SelectModifierPhase" });
      audit.acquire(data, "SelectModifierPhase", ids());
      game.scene.addModifier(berry, true);
    }
    audit.observe(game.scene.getPlayerParty(), stock());
    game.scene.currentBattle.mysteryEncounter = AbsoluteAvariceEncounter;
    expect(AbsoluteAvariceEncounter.onInit!()).toBe(true);
    audit.begin(encounterItemGrants(game.scene));
  });
  const ids = () => new Set(game.scene.getPlayerParty().map(p => p.id));
  const stock = () => game.scene.modifiers.map(m => new ModifierData(m, true));
  function item(id: string, args?: unknown[]) {
    return encounterPhases
      .generateModifierType(modifierTypes[id], args)!
      .newModifier(game.scene.getPlayerParty()[0]) as PersistentModifier;
  }
  function stolen() {
    for (const berry of game.scene.modifiers.filter(m => m instanceof BerryModifier)) {
      game.scene.removeModifier(berry);
    }
    audit.observe(game.scene.getPlayerParty(), stock());
  }
  it("accepts the native two-fifths refund after all original berries were removed", async () => {
    stolen();
    const add = game.scene.addModifier;
    let receipts = 0;
    vi.spyOn(game.scene, "addModifier").mockImplementation((...args) => {
      audit.acquire(new ModifierData(args[0], true), "MysteryEncounterOptionSelectedPhase", ids());
      const result = add.apply(game.scene, args);
      audit.observe(game.scene.getPlayerParty(), stock());
      receipts++;
      return result;
    });
    vi.spyOn(encounterPhases, "transitionMysteryEncounterIntroVisuals").mockResolvedValue(true);
    await AbsoluteAvariceEncounter.options[1].onOptionPhase();
    expect(receipts).toBe(2);
    expect(game.scene.modifiers.reduce((sum, m) => sum + m.stackCount, 0)).toBe(2);
  });
  it("rejects a refund without the original theft and refuses a different berry variant", () => {
    const receipt = new ModifierData(item("BERRY", [BerryType.SITRUS]), true);
    expect(() => audit.acquire(receipt, "MysteryEncounterOptionSelectedPhase", ids())).toThrow(/stolen inventory/);
    stolen();
    const invented = new ModifierData(item("BERRY", [BerryType.STARF]), true);
    expect(() => audit.acquire(invented, "MysteryEncounterOptionSelectedPhase", ids())).toThrow(/certified source/);
  });
  it("cannot combine the refund option with a battle-only Reviver Seed reward", () => {
    stolen();
    const berry = item("BERRY", [BerryType.SITRUS]);
    audit.acquire(new ModifierData(berry, true), "MysteryEncounterOptionSelectedPhase", ids());
    game.scene.addModifier(berry, true);
    audit.observe(game.scene.getPlayerParty(), stock());
    const seed = new ModifierData(item("REVIVER_SEED"), true);
    expect(() => audit.acquire(seed, "MysteryEncounterRewardsPhase", ids())).toThrow(/certified source/);
  });
  it("cannot collect a refund by transferring the original berries to another party member", () => {
    for (const berry of [...game.scene.getPlayerParty()[0].getHeldItems()]) {
      game.scene.tryTransferHeldItemModifier(berry, game.scene.getPlayerParty()[1], true);
    }
    audit.observe(game.scene.getPlayerParty(), stock());
    expect(() =>
      audit.acquire(
        new ModifierData(item("BERRY", [BerryType.SITRUS]), true),
        "MysteryEncounterOptionSelectedPhase",
        ids(),
      ),
    ).toThrow(/stolen inventory/);
  });
  it("does not turn the copied boss berries into a second free inventory before the theft", () => {
    const receipt = new ModifierData(item("BERRY", [BerryType.SITRUS]), true);
    expect(() => audit.acquire(receipt, "MoveEffectPhase", ids())).toThrow(/stolen inventory/);
    stolen();
    expect(() => audit.acquire(receipt, "MoveEffectPhase", ids())).not.toThrow();
    expect(() =>
      audit.acquire(
        new ModifierData(item("BERRY", [BerryType.LEPPA]), true),
        "MysteryEncounterOptionSelectedPhase",
        ids(),
      ),
    ).toThrow(/certified source/);
  });
  it("shares the two-fifths refund budget across all original berry variants", () => {
    stolen();
    const berry = item("BERRY", [BerryType.SITRUS]);
    berry.stackCount = 2;
    audit.acquire(new ModifierData(berry, true), "MysteryEncounterOptionSelectedPhase", ids());
    game.scene.addModifier(berry, true);
    audit.observe(game.scene.getPlayerParty(), stock());
    expect(() =>
      audit.acquire(
        new ModifierData(item("BERRY", [BerryType.LUM]), true),
        "MysteryEncounterOptionSelectedPhase",
        ids(),
      ),
    ).toThrow(/certified source/);
  });
});
