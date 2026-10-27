// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { BerryType } from "#enums/berry-type";
import { FormChangeItem } from "#enums/form-change-item";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import type { LapsingPersistentModifier, PersistentModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { serialCopy } from "../../../src/pvp/generation";
import { applyInventoryDelta, inventoryDelta } from "../../../src/pvp/inventory-ledger";

describe("Certified persistent item inventory", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let audit: InventoryAudit;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
    audit = new InventoryAudit();
  });
  const ids = () => new Set(game.scene.getPlayerParty().map(p => p.id));
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  const stock = () => game.scene.modifiers.map(m => serialCopy(new ModifierData(m, true)));
  function item(id: string, args?: unknown[], index = 0): PersistentModifier {
    const type = generateModifierType(modifierTypes[id], args)!;
    expect(type).not.toBeNull();
    return type.newModifier(game.scene.getPlayerParty()[index]) as PersistentModifier;
  }
  const receipt = (m: PersistentModifier) => serialCopy(new ModifierData(m, true));
  function allow(m: PersistentModifier, count = m.stackCount) {
    const entry = canonicalItem(receipt(m));
    audit.grant({ base: entry.base, count, source: "SelectModifierPhase", lifetime: entry.lifetime?.maximum });
  }
  it.each([
    ["MAP", undefined],
    ["SHINY_CHARM", undefined],
    ["EXP_CHARM", undefined],
    ["BERRY", [BerryType.SITRUS]],
    ["ATTACK_TYPE_BOOSTER", [PokemonType.FIRE]],
    ["BASE_STAT_BOOSTER", [Stat.ATK]],
    ["TEMP_STAT_STAGE_BOOSTER", [Stat.ATK]],
    ["FORM_CHANGE_ITEM", [FormChangeItem.CHARIZARDITE_X]],
    ["SILVER_POKEBALL", undefined],
    ["SOOTHE_BELL", undefined],
    ["LUCKY_EGG", undefined],
    ["EVOLUTION_TRACKER_GIMMIGHOUL", undefined],
  ] as const)("round-trips the actual %s factory and preserves RNG", (id, args) => {
    const data = receipt(item(id, args && [...args]));
    const before = Phaser.Math.RND.state();
    expect(canonicalItem(data).count).toBe(1);
    expect(Phaser.Math.RND.state()).toBe(before);
  });
  it("rejects a constructor substituted for a legitimate item ID", () => {
    const data = receipt(item("MAP"));
    data.className = "TurnHealModifier";
    expect(() => canonicalItem(data)).toThrow(/constructor/);
  });
  it("rejects an inflated effect argument despite a valid ID and class", () => {
    const data = receipt(item("ATTACK_TYPE_BOOSTER", [PokemonType.FIRE]));
    data.args[2] = 9999;
    expect(() => canonicalItem(data)).toThrow(/effect arguments/);
  });
  it("rejects invalid generated arguments and oversized native stacks", () => {
    const data = receipt(item("BERRY", [BerryType.SITRUS]));
    data.typePregenArgs = [-1];
    expect(() => canonicalItem(data)).toThrow(/generation arguments|construction|generated item/);
    const map = receipt(item("MAP"));
    map.stackCount = 2;
    expect(() => canonicalItem(map)).toThrow(/native item limit/);
  });
  it("requires a certified source and refuses item injection in a checkpoint", () => {
    const data = receipt(item("MAP"));
    expect(() => audit.observe(party(), [data])).toThrow(/certified acquisition/);
    expect(() => audit.acquire(data, "SelectModifierPhase", ids())).toThrow(/certified source/);
  });
  it("debits discarded stock and prevents resurrection at a later checkpoint", () => {
    const berry = item("BERRY", [BerryType.SITRUS]) as PokemonHeldItemModifier;
    berry.stackCount = 2;
    allow(berry);
    audit.acquire(receipt(berry), "SelectModifierPhase", ids());
    game.scene.addModifier(berry, true);
    audit.observe(party(), stock());
    expect(game.scene.tryDiscardHeldItemModifier(berry, 1)).toBe(true);
    audit.observe(party(), stock());
    const resurrected = stock();
    resurrected[0].stackCount = 2;
    expect(() => audit.observe(party(), resurrected)).toThrow(/certified acquisition/);
  });
  it("preserves totals during native item transfers instead of crediting a second acquisition", () => {
    const berry = item("BERRY", [BerryType.SITRUS]) as PokemonHeldItemModifier;
    berry.stackCount = 2;
    allow(berry);
    audit.acquire(receipt(berry), "SelectModifierPhase", ids());
    game.scene.addModifier(berry, true);
    audit.observe(party(), stock());
    expect(game.scene.tryTransferHeldItemModifier(berry, game.scene.getPlayerParty()[1], false)).toBe(true);
    const moved = stock();
    audit.acquire(moved.find(m => m.args[0] === game.scene.getPlayerParty()[1].id)!, "SelectModifierPhase", ids());
    expect(() => audit.observe(party(), moved)).not.toThrow();
    moved[0].stackCount++;
    expect(() => audit.observe(party(), moved)).toThrow(/certified acquisition|native limit/);
  });
  it("keeps nontransferable vitamins with their owner until a certified fusion retargets them", () => {
    const vitamin = item("BASE_STAT_BOOSTER", [Stat.ATK]);
    allow(vitamin);
    audit.acquire(receipt(vitamin), "SelectModifierPhase", ids());
    const moved = receipt(vitamin);
    const [first, second] = game.scene.getPlayerParty();
    moved.args[0] = second.id;
    expect(() => audit.observe(party(), [moved])).toThrow(/certified acquisition/);
    audit.bindTransfers(new Map([[first.id, second.id]]));
    expect(() => audit.observe(party(), [moved])).not.toThrow();
  });
  it("rejects duplicate stacks whose aggregate exceeds the global native cap", () => {
    const map = item("MAP");
    allow(map, 2);
    audit.acquire(receipt(map), "SelectModifierPhase", ids());
    audit.acquire(receipt(map), "SelectModifierPhase", ids());
    expect(() => audit.observe(party(), [receipt(map), receipt(map)])).toThrow(/split stacks/);
  });
  it("allows the native Silver Pokeball duration extension but refuses free duration", () => {
    const first = item("SILVER_POKEBALL") as LapsingPersistentModifier;
    allow(first, 2);
    audit.acquire(receipt(first), "SelectModifierPhase", ids());
    game.scene.addModifier(first, true);
    audit.observe(party(), stock());
    const second = item("SILVER_POKEBALL");
    audit.acquire(receipt(second), "SelectModifierPhase", ids());
    game.scene.addModifier(second, true);
    expect(first.getBattleCount()).toBe(2 * second.getArgs()[0]);
    audit.observe(party(), stock());
    first.lapse();
    audit.observe(party(), stock());
    const forged = stock();
    forged[0].args[1]++;
    expect(() => audit.observe(party(), forged)).toThrow(/lifetime increased/);
  });
  it("does not certify two different items from the same selected reward", () => {
    const berry = item("BERRY", [BerryType.SITRUS]);
    const map = item("MAP");
    for (const modifier of [berry, map]) {
      audit.grant({
        base: canonicalItem(receipt(modifier)).base,
        count: 1,
        source: "SelectModifierPhase",
        group: "reward:1",
      });
    }
    audit.acquire(receipt(berry), "SelectModifierPhase", ids());
    expect(() => audit.acquire(receipt(map), "SelectModifierPhase", ids())).toThrow(/certified source/);
  });
  it("shares a bounded ME item budget across generated berry variants", () => {
    audit.begin([{ typeId: "BERRY", count: 1, source: "MysteryEncounterRewardsPhase" }]);
    audit.acquire(receipt(item("BERRY", [BerryType.SITRUS])), "MysteryEncounterRewardsPhase", ids());
    expect(() =>
      audit.acquire(receipt(item("BERRY", [BerryType.LEPPA])), "MysteryEncounterRewardsPhase", ids()),
    ).toThrow(/certified source/);
  });
  it("debits a completed battle's lifetime and accepts the native lapse", () => {
    const silver = item("SILVER_POKEBALL") as LapsingPersistentModifier;
    allow(silver);
    audit.acquire(receipt(silver), "SelectModifierPhase", ids());
    game.scene.addModifier(silver, true);
    audit.observe(party(), stock());
    audit.begin([]);
    audit.battleEnd();
    expect(() => audit.observe(party(), stock())).toThrow(/lifetime increased/);
    silver.lapse();
    expect(() => audit.observe(party(), stock())).not.toThrow();
  });
  it("reconstructs native transfer and discard snapshots from compact deltas", () => {
    const berry = item("BERRY", [BerryType.SITRUS]) as PokemonHeldItemModifier;
    berry.stackCount = 2;
    game.scene.addModifier(berry, true);
    const before = stock();
    game.scene.tryTransferHeldItemModifier(berry, game.scene.getPlayerParty()[1], false);
    const transferred = stock();
    expect(applyInventoryDelta(before, inventoryDelta(before, transferred))).toEqual(transferred);
    game.scene.tryDiscardHeldItemModifier(berry);
    const discarded = stock();
    expect(applyInventoryDelta(transferred, inventoryDelta(transferred, discarded))).toEqual(discarded);
  });
  it("represents a native lifetime tick as a raw saved-item replacement", () => {
    const silver = item("SILVER_POKEBALL") as LapsingPersistentModifier;
    game.scene.addModifier(silver, true);
    const before = stock();
    silver.lapse();
    const changes = inventoryDelta(before, stock());
    expect(changes.map(c => c.delta).sort()).toEqual([-1, 1]);
    expect(applyInventoryDelta(before, changes)).toEqual(stock());
  });
  it("rejects deltas that remove nonexistent stock or carry noninteger counts", () => {
    const data = receipt(item("MAP"));
    expect(() => applyInventoryDelta([], [{ data, delta: -1 }])).toThrow(/nonexistent/);
    expect(() => applyInventoryDelta([], [{ data, delta: 1.5 }])).toThrow(/invalid inventory delta/);
  });
});
