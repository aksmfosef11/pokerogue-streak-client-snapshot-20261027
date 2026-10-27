// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { BerryType } from "#enums/berry-type";
import { BiomeId } from "#enums/biome-id";
import { FormChangeItem } from "#enums/form-change-item";
import { MysteryEncounterTier } from "#enums/mystery-encounter-tier";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { PersistentModifier, PokemonFormChangeItemModifier } from "#modifiers/modifier";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
// biome-ignore lint/performance/noNamespaceImport: Force the test biome to the original GTS encounter.
import * as mysteryBiomes from "#mystery-encounters/mystery-encounter-biomes";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { auditItemLedger } from "../../../src/pvp/audit-item-ledger";
import { tradeItemGrants } from "../../../src/pvp/audit-item-sources";
import { replayGtsTradeGifts } from "../../../src/pvp/audit-me-gifts";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { serialCopy } from "../../../src/pvp/generation";
import { type ItemRecord, inventoryDelta } from "../../../src/pvp/inventory-ledger";

describe("Native GTS trade provenance and paid held-item relocation", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let inventory: InventoryAudit;
  let audit: PartyAudit;
  let initial: ModifierData[];
  let before: PokemonData[];
  let proof: ReturnType<typeof replayGtsTradeGifts>[number];
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  const stock = () => game.scene.modifiers.map(m => serialCopy(new ModifierData(m, true)));
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    game.override.normalizeNatures = false;
    game.override.normalizeIVs = false;
    game.override
      .mysteryEncounterChance(100)
      .mysteryEncounterTier(MysteryEncounterTier.COMMON)
      .startingWave(45)
      .startingBiome(BiomeId.CAVE)
      .disableTrainerWaves();
    vi.spyOn(mysteryBiomes, "mysteryEncountersByBiome", "get").mockReturnValue(
      new Map([[BiomeId.CAVE, [ME.GLOBAL_TRADE_SYSTEM]]]),
    );
    await game.runToMysteryEncounter(ME.GLOBAL_TRADE_SYSTEM, [SpeciesId.PIKACHU, SpeciesId.GENGAR, SpeciesId.ABRA]);
    const owner = game.scene.getPlayerParty()[0];
    owner.passive = true;
    owner.ivs.fill(31);
    proof = replayGtsTradeGifts(game.scene).find(gift => gift.outgoing === owner.id)!;
    const vitamin = proof.pokemon.ivs.findIndex(iv => iv > 0);
    inventory = new InventoryAudit();
    for (const [id, args, count] of [
      ["BERRY", [BerryType.SITRUS], 2],
      ["BASE_STAT_BOOSTER", [vitamin], 1],
      ["MYSTERY_ENCOUNTER_MACHO_BRACE", undefined, 3],
      ["SPECIES_STAT_BOOSTER", ["LIGHT_BALL"], 1],
      ["FORM_CHANGE_ITEM", [FormChangeItem.MAX_MUSHROOMS], 1],
    ] as const) {
      const modifier = generateModifierType(modifierTypes[id], args && [...args])!.newModifier(
        owner,
      ) as PersistentModifier;
      modifier.stackCount = count;
      if (modifier instanceof PokemonFormChangeItemModifier) {
        modifier.active = false;
      }
      const data = serialCopy(new ModifierData(modifier, true));
      inventory.grant({ base: canonicalItem(data).base, count, source: "SelectModifierPhase" });
      inventory.acquire(data, "SelectModifierPhase", new Set(party().map(p => p.id)));
      game.scene.addModifier(modifier, true);
    }
    initial = stock();
    before = party();
    inventory.observe(before, initial);
    inventory.begin([]);
    audit = new PartyAudit({ inventory: id => inventory.provedItems(id), deferResources: true });
    audit.start(before);
    audit.beginEncounter(ME.GLOBAL_TRADE_SYSTEM, game.scene.getMaxExpLevel());
  });
  async function trade() {
    let previous = initial;
    const events: ItemRecord[] = [];
    const state = (force = false) => {
      const next = stock();
      const changes = inventoryDelta(previous, next);
      if (changes.length > 0 || force) {
        events.push({ kind: "state", changes, source: game.scene.phaseManager.getCurrentPhase().phaseName });
      }
      previous = next;
    };
    const original = game.scene.addModifier;
    const spy = vi.spyOn(game.scene, "addModifier").mockImplementation((...args) => {
      if (args[0] instanceof PersistentModifier && !args[3]) {
        state();
        events.push({
          kind: "acquire",
          data: serialCopy(new ModifierData(args[0], true)),
          source: game.scene.phaseManager.getCurrentPhase().phaseName,
        });
      }
      const result = original.apply(game.scene, args);
      state(true);
      return result;
    });
    await runMysteryEncounterToEnd(game, 1, { pokemonNo: 1, optionNo: 1 });
    state();
    spy.mockRestore();
    const caught = party().find(p => p.id === proof.pokemon.id)!;
    expect(caught).toBeDefined();
    return { caught, events };
  }
  function register(caught: PokemonData) {
    audit.capture(caught, proof.pokemon, "MysteryEncounterOptionSelectedPhase", true, proof.outgoing);
    for (const grant of tradeItemGrants(proof.outgoing, caught.id, initial)) {
      inventory.grant(grant);
    }
  }
  it("matches the actual offered gift, consumes its owner, and keeps native vitamins and Macho Brace", async () => {
    const { caught, events } = await trade();
    register(caught);
    audit.observe(party());
    auditItemLedger(inventory, initial, events, audit.knownIds(), ME.GLOBAL_TRADE_SYSTEM);
    inventory.observe(party(), stock());
    audit.finishWave();
    expect(caught.passive).toBe(true);
    const held = stock()
      .filter(m => m.args[0] === caught.id)
      .map(m => m.className);
    expect(held).toContain("BaseStatModifier");
    expect(held).toContain("PokemonIncrementingStatModifier");
    expect(held).not.toContain("SpeciesStatBoosterModifier");
    expect(held).not.toContain("PokemonFormChangeItemModifier");
    expect(audit.itemTrades.get(proof.outgoing)).toBe(caught.id);
  });
  it("rejects a gift without a certified outgoing owner", async () => {
    const { caught } = await trade();
    expect(() => audit.capture(caught, proof.pokemon, "MysteryEncounterOptionSelectedPhase", true)).toThrow(
      /outgoing individual/,
    );
    const alone = new PartyAudit();
    alone.start([before[0]]);
    alone.beginEncounter(ME.GLOBAL_TRADE_SYSTEM);
    expect(() =>
      alone.capture(caught, proof.pokemon, "MysteryEncounterOptionSelectedPhase", true, proof.outgoing),
    ).toThrow(/outgoing individual/);
  });
  it("does not let the consumed outgoing owner remain in the party", async () => {
    const { caught } = await trade();
    register(caught);
    expect(() => audit.observe([...party(), before[0]])).toThrow(/unknown or retired/);
  });
  it("does not credit relocated nontransferable items before their old physical stock is removed", async () => {
    const { caught } = await trade();
    register(caught);
    const macho = stock().find(m => m.className === "PokemonIncrementingStatModifier" && m.args[0] === caught.id)!;
    expect(() => inventory.acquire(macho, "MysteryEncounterOptionSelectedPhase", audit.knownIds())).toThrow(
      /discarded source items/,
    );
  });
  it("cannot restore the discarded species booster or form item onto the new owner", async () => {
    const { caught, events } = await trade();
    register(caught);
    audit.observe(party());
    auditItemLedger(inventory, initial, events, audit.knownIds(), ME.GLOBAL_TRADE_SYSTEM);
    for (const original of initial.filter(m =>
      ["SpeciesStatBoosterModifier", "PokemonFormChangeItemModifier"].includes(m.className),
    )) {
      const forged = serialCopy(original);
      forged.args[0] = caught.id;
      expect(() => inventory.acquire(forged, "MysteryEncounterOptionSelectedPhase", audit.knownIds())).toThrow(
        /certified source/,
      );
    }
  });
  it("does not combine the Pokemon trade with the GTS item-reward branch", async () => {
    const { caught } = await trade();
    register(caught);
    expect(() =>
      audit.offer({
        kind: "offer",
        session: game.scene.gameData.getSessionSaveData(),
        options: [],
        rerolls: 0,
        special: true,
        copy: false,
        locked: false,
      }),
    ).toThrow(/also claim/);
  });
});
