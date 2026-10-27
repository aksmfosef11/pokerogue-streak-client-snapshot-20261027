// SPDX-License-Identifier: AGPL-3.0-only
import { timedEventManager } from "#app/global-event-manager";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { modifierTypes } from "#data/data-lists";
import { BerryType } from "#enums/berry-type";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { PersistentModifier } from "#modifiers/modifier";
import { BaseStatBoosterModifierType } from "#modifiers/modifier-type";
import { ClowningAroundEncounter } from "#mystery-encounters/clowning-around-encounter";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { VictoryPhase } from "#phases/victory-phase";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { getModifierType } from "#utils/modifier-utils";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { encounterItemGrants, selectedTreasureGrants } from "../../../src/pvp/audit-item-sources";
import { serialCopy } from "../../../src/pvp/generation";
import { optionData, type ShopOffer } from "../../../src/pvp/shop";

describe("Native encounter item source budgets", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
    game.scene.phaseManager.clearPhaseQueue();
  });
  it.each([10, 20, 30, 50, 100, 150, 165, 190, 200])(
    "matches native VictoryPhase's persistent rewards at wave %i",
    wave => {
      const scene = game.scene;
      scene.currentBattle.waveIndex = wave;
      vi.spyOn(scene, "applyPartyExp").mockImplementation(() => {});
      const enemy = scene.getEnemyParty()[0];
      vi.spyOn(enemy, "isOnField").mockReturnValue(false);
      enemy.hp = 0;
      const queued = vi.spyOn(scene.phaseManager, "pushNew");
      const phase = new VictoryPhase(2);
      vi.spyOn(phase, "getPokemon").mockReturnValue(enemy);
      vi.spyOn(phase, "end").mockImplementation(() => {});
      phase.start();
      const actual = queued.mock.calls
        .flatMap(call => {
          if (call[0] !== "ModifierRewardPhase") {
            return [];
          }
          const modifier = getModifierType(call[1] as typeof modifierTypes.MAP).newModifier();
          return modifier instanceof PersistentModifier ? [canonicalItem(new ModifierData(modifier, true)).base] : [];
        })
        .sort();
      const grants = encounterItemGrants(scene).filter(g => g.source === "ModifierRewardPhase");
      expect(grants.flatMap(g => new Array(g.count).fill(g.base)).sort()).toEqual(actual);
    },
  );
  it("derives time-dependent event rewards through the native manager", () => {
    game.scene.currentBattle.waveIndex = 41;
    vi.spyOn(timedEventManager, "getFixedBattleEventRewards").mockReturnValue(["SHINY_CHARM"]);
    const actual = encounterItemGrants(game.scene).filter(g => g.source === "ModifierRewardPhase");
    const charm = generateModifierType(modifierTypes.SHINY_CHARM)!.newModifier() as PersistentModifier;
    expect(actual.map(g => g.base)).toContain(canonicalItem(new ModifierData(charm, true)).base);
  });
  function prepareExchange() {
    const scene = game.scene;
    const audit = new InventoryAudit();
    const party = scene.getPlayerParty();
    const ids = new Set(party.map(p => p.id));
    for (const [id, args, count] of [
      ["LEFTOVERS", undefined, 2],
      ["SOOTHE_BELL", undefined, 2],
      ["BERRY", [BerryType.SITRUS], 2],
    ] as const) {
      const modifier = generateModifierType(modifierTypes[id], args && [...args])!.newModifier(
        party[0],
      ) as PersistentModifier;
      modifier.stackCount = count;
      const data = new ModifierData(modifier, true);
      audit.grant({ base: canonicalItem(data).base, count, source: "SelectModifierPhase" });
      audit.acquire(data, "SelectModifierPhase", ids);
      scene.addModifier(modifier, true);
    }
    const stock = () => scene.modifiers.filter(m => m.stackCount > 0).map(m => serialCopy(new ModifierData(m, true)));
    audit.observe(party, stock());
    scene.currentBattle.mysteryEncounter = ClowningAroundEncounter;
    audit.begin(encounterItemGrants(scene));
    return { scene, audit, party, ids, stock };
  }
  it("accepts the actual Clowning Around shuffle only after the old items disappear", async () => {
    const { scene, audit, party, ids, stock } = prepareExchange();
    const add = scene.addModifier;
    const receipts: ModifierData[] = [];
    vi.spyOn(scene, "addModifier").mockImplementation((...args) => {
      audit.observe(party, stock());
      const data = new ModifierData(args[0], true);
      audit.acquire(data, "MysteryEncounterOptionSelectedPhase", ids);
      receipts.push(data);
      const result = add.apply(scene, args);
      audit.observe(party, stock());
      return result;
    });
    await ClowningAroundEncounter.options[1].onPreOptionPhase!();
    expect(receipts).toHaveLength(6);
    expect(receipts.every(r => r.args[0] === party[0].id)).toBe(true);
    expect(() => audit.observe(party, stock())).not.toThrow();
  });
  it("rejects exchange rewards while keeping the original inventory", () => {
    const { audit, ids, party } = prepareExchange();
    const reward = generateModifierType(modifierTypes.QUICK_CLAW)!.newModifier(party[0]) as PersistentModifier;
    expect(() => audit.acquire(new ModifierData(reward, true), "MysteryEncounterOptionSelectedPhase", ids)).toThrow(
      /discarded source/,
    );
  });
  it("does not treat a held-item transfer as payment for an exchange", () => {
    const { scene, audit, ids, party, stock } = prepareExchange();
    const bell = party[0].getHeldItems().find(m => m.type.id === "SOOTHE_BELL")!;
    expect(scene.tryTransferHeldItemModifier(bell, party[1], true)).toBe(true);
    audit.observe(party, stock());
    const reward = generateModifierType(modifierTypes.QUICK_CLAW)!.newModifier(party[0]) as PersistentModifier;
    expect(() => audit.acquire(new ModifierData(reward, true), "MysteryEncounterOptionSelectedPhase", ids)).toThrow(
      /discarded source/,
    );
  });
  it("certifies one native treasure reward for every Gimmighoul without mixing menu choices", () => {
    const scene = game.scene;
    const party = scene.getPlayerParty();
    for (const pokemon of party) {
      pokemon.species = speciesDataRegistry.getSpecies(SpeciesId.GIMMIGHOUL);
    }
    const types = [modifierTypes.NUGGET, modifierTypes.RELIC_GOLD].map(factory => getModifierType(factory));
    const offer = {
      session: scene.gameData.getSessionSaveData(),
      options: types.map(type => optionData({ type, cost: 0, upgradeCount: 0 })),
    } as ShopOffer;
    const audit = new InventoryAudit();
    const ids = new Set(party.map(p => p.id));
    audit.begin(types.flatMap((_type, cursor) => selectedTreasureGrants(offer, 1, cursor, "same-menu")));
    const add = scene.addModifier;
    vi.spyOn(scene, "addModifier").mockImplementation((...args) => {
      audit.acquire(new ModifierData(args[0], true), "SelectModifierPhase", ids);
      const result = add.apply(scene, args);
      audit.observe(
        party,
        scene.modifiers.map(m => new ModifierData(m, true)),
      );
      return result;
    });
    types[0].newModifier()!.apply();
    expect(scene.modifiers).toHaveLength(2);
    expect(scene.modifiers.map(m => m.stackCount)).toEqual([1, 1]);
    expect(() => types[1].newModifier()!.apply()).toThrow(/certified acquisition/);
  });
  it("allows native Macho Brace growth only for the reproduced number of defeats", () => {
    const scene = game.scene;
    const party = scene.getPlayerParty();
    const ids = new Set(party.map(p => p.id));
    const audit = new InventoryAudit();
    const brace = generateModifierType(modifierTypes.MYSTERY_ENCOUNTER_MACHO_BRACE)!.newModifier(
      party[0],
    ) as PersistentModifier;
    const data = new ModifierData(brace, true);
    audit.grant({ base: canonicalItem(data).base, count: 1, source: "SelectModifierPhase" });
    audit.acquire(data, "SelectModifierPhase", ids);
    scene.addModifier(brace, true);
    const stock = () => scene.modifiers.map(m => new ModifierData(m, true));
    audit.observe(
      party.map(p => new PokemonData(p)),
      stock(),
    );
    audit.begin(encounterItemGrants(scene));
    scene.applyPartyExp(0, true, false, new Set([party[0].id]));
    expect(brace.stackCount).toBe(2);
    audit.observe(party, stock());
    scene.applyPartyExp(0, true, false, new Set([party[0].id]));
    expect(() => audit.observe(party, stock())).toThrow(/certified acquisition/);
  });
  it("enforces item source bounds and mutual exclusion for Shady Dealer, Delibirdy, Offer You Cant Refuse, and Shuckle Juice", () => {
    const scene = game.scene;
    const party = scene.getPlayerParty();
    const ids = new Set(party.map(p => p.id));

    // 1. SHADY_VITAMIN_DEALER: maximum 2 vitamins
    const auditDealer = new InventoryAudit();
    scene.currentBattle.mysteryEncounter = { encounterType: ME.SHADY_VITAMIN_DEALER } as any;
    auditDealer.begin(encounterItemGrants(scene));
    const vitType1 = new BaseStatBoosterModifierType(Stat.HP);
    vitType1.id = "BASE_STAT_BOOSTER";
    const vitType2 = new BaseStatBoosterModifierType(Stat.ATK);
    vitType2.id = "BASE_STAT_BOOSTER";
    const vitType3 = new BaseStatBoosterModifierType(Stat.SPD);
    vitType3.id = "BASE_STAT_BOOSTER";
    const vit1 = vitType1.newModifier(party[0]) as PersistentModifier;
    const vit2 = vitType2.newModifier(party[0]) as PersistentModifier;
    const vit3 = vitType3.newModifier(party[0]) as PersistentModifier;
    expect(() => auditDealer.acquire(new ModifierData(vit1, true), "MysteryEncounterOptionSelectedPhase", ids)).not.toThrow();
    expect(() => auditDealer.acquire(new ModifierData(vit2, true), "MysteryEncounterOptionSelectedPhase", ids)).not.toThrow();
    expect(() => auditDealer.acquire(new ModifierData(vit3, true), "MysteryEncounterOptionSelectedPhase", ids)).toThrow(
      /certified source/,
    );

    // 2. AN_OFFER_YOU_CANT_REFUSE: maximum 1 Shiny Charm
    const auditOffer = new InventoryAudit();
    scene.currentBattle.mysteryEncounter = { encounterType: ME.AN_OFFER_YOU_CANT_REFUSE } as any;
    auditOffer.begin(encounterItemGrants(scene));
    const charm1 = generateModifierType(modifierTypes.SHINY_CHARM)!.newModifier() as PersistentModifier;
    const fakeItem = generateModifierType(modifierTypes.AMULET_COIN)!.newModifier() as PersistentModifier;
    expect(() => auditOffer.acquire(new ModifierData(charm1, true), "MysteryEncounterOptionSelectedPhase", ids)).not.toThrow();
    // Claiming an item outside the encounter's granted bounds is rejected
    expect(() => auditOffer.acquire(new ModifierData(fakeItem, true), "MysteryEncounterOptionSelectedPhase", ids)).toThrow(
      /certified source/,
    );
    // Stack count > 1 is rejected in observe
    const overCharm = new ModifierData(charm1, true);
    overCharm.stackCount = 2;
    expect(() => auditOffer.observe(party, [overCharm])).toThrow(/certified acquisition/);

    // 3. DELIBIRDY: at most 1 choice from the main buff group
    const auditBird = new InventoryAudit();
    scene.currentBattle.mysteryEncounter = { encounterType: ME.DELIBIRDY } as any;
    auditBird.begin(encounterItemGrants(scene));
    const coin = generateModifierType(modifierTypes.AMULET_COIN)!.newModifier() as PersistentModifier;
    const bell = generateModifierType(modifierTypes.SHELL_BELL)!.newModifier(party[0]) as PersistentModifier;
    expect(() => auditBird.acquire(new ModifierData(coin, true), "MysteryEncounterOptionSelectedPhase", ids)).not.toThrow();
    expect(() => auditBird.acquire(new ModifierData(bell, true), "MysteryEncounterOptionSelectedPhase", ids)).toThrow(
      /certified source/,
    );

    // 4. THE_STRONG_STUFF: top BST pokemon cannot receive positive (+10) Shuckle Juice
    const auditJuice = new InventoryAudit();
    scene.currentBattle.mysteryEncounter = { encounterType: ME.THE_STRONG_STUFF } as any;
    auditJuice.begin(encounterItemGrants(scene));
    const forgedJuice = modifierTypes
      .MYSTERY_ENCOUNTER_SHUCKLE_JUICE()
      .generateType(party, [10])!
      .withIdFromFunc(modifierTypes.MYSTERY_ENCOUNTER_SHUCKLE_JUICE)
      .newModifier(party[0]) as PersistentModifier;
    expect(() => auditJuice.acquire(new ModifierData(forgedJuice, true), "MysteryEncounterOptionSelectedPhase", ids)).toThrow(
      /certified source/,
    );
  });
});
