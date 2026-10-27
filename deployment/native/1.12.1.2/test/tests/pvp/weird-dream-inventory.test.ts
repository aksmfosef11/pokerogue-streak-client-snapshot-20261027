// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { BerryType } from "#enums/berry-type";
import { BiomeId } from "#enums/biome-id";
import { FormChangeItem } from "#enums/form-change-item";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { PersistentModifier, PokemonFormChangeItemModifier } from "#modifiers/modifier";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
// biome-ignore lint/performance/noNamespaceImport: Skip only the transformation animation.
import * as encounterAnimation from "#mystery-encounters/encounter-transformation-sequence";
// biome-ignore lint/performance/noNamespaceImport: Force the real encounter for the native UI control.
import * as mysteryBiomes from "#mystery-encounters/mystery-encounter-biomes";
import { WeirdDreamEncounter } from "#mystery-encounters/weird-dream-encounter";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { auditItemLedger } from "../../../src/pvp/audit-item-ledger";
import { tradeItemGrants } from "../../../src/pvp/audit-item-sources";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { generatedPokemon, serialCopy } from "../../../src/pvp/generation";
import { type ItemRecord, inventoryDelta } from "../../../src/pvp/inventory-ledger";

describe("Native Weird Dream paid inventory relocation", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let inventory: InventoryAudit;
  let audit: PartyAudit;
  let initial: ModifierData[];
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  const stock = () => game.scene.modifiers.map(m => serialCopy(new ModifierData(m, true)));
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    game.override.normalizeNatures = false;
    game.override.normalizeIVs = false;
    game.override.mysteryEncounterChance(100).startingWave(45).startingBiome(BiomeId.CAVE).disableTrainerWaves();
    vi.spyOn(mysteryBiomes, "mysteryEncountersByBiome", "get").mockReturnValue(
      new Map([[BiomeId.CAVE, [ME.WEIRD_DREAM]]]),
    );
    vi.spyOn(encounterAnimation, "doPokemonTransformationSequence").mockResolvedValue();
    const onInit = WeirdDreamEncounter.onInit!;
    vi.spyOn(WeirdDreamEncounter, "onInit", "get").mockReturnValue(() => {
      const owner = game.scene.getPlayerParty()[0];
      owner.ivs.fill(31);
      for (const [id, args, count] of [
        ["BERRY", [BerryType.SITRUS], 2],
        ["BASE_STAT_BOOSTER", [0], 1],
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
        game.scene.addModifier(modifier, true);
      }
      return onInit();
    });
    await game.runToMysteryEncounter(ME.WEIRD_DREAM, [SpeciesId.PIKACHU, SpeciesId.GENGAR, SpeciesId.ABRA]);
    initial = stock();
    inventory = new InventoryAudit();
    for (const data of initial) {
      const item = canonicalItem(data);
      inventory.grant({ base: item.base, count: item.count, source: "SelectModifierPhase" });
      inventory.acquire(data, "SelectModifierPhase", new Set(party().map(p => p.id)));
    }
    inventory.observe(party(), initial);
    inventory.begin([]);
    audit = new PartyAudit({ deferResources: true, inventory: id => inventory.provedItems(id) });
    audit.start(party());
    audit.beginEncounter(ME.WEIRD_DREAM, game.scene.getMaxExpLevel());
  });
  async function transform() {
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
    const add = game.scene.addModifier;
    const spy = vi.spyOn(game.scene, "addModifier").mockImplementation((...args) => {
      if (args[0] instanceof PersistentModifier && !args[3]) {
        state();
        events.push({
          kind: "acquire",
          data: serialCopy(new ModifierData(args[0], true)),
          source: game.scene.phaseManager.getCurrentPhase().phaseName,
        });
      }
      const result = add.apply(game.scene, args);
      state(true);
      return result;
    });
    await runMysteryEncounterToEnd(game, 1);
    state();
    spy.mockRestore();
    for (const transformation of game.scene.currentBattle.mysteryEncounter!.misc.teamTransformations) {
      const pokemon = serialCopy(new PokemonData(transformation.newPokemon));
      audit.capture(
        pokemon,
        generatedPokemon(pokemon),
        "MysteryEncounterOptionSelectedPhase",
        true,
        transformation.previousPokemon.id,
      );
      for (const grant of tradeItemGrants(transformation.previousPokemon.id, pokemon.id, initial, true)) {
        inventory.grant(grant);
      }
    }
    for (const event of events) {
      if (event.kind === "acquire" && event.data.typeId === "MYSTERY_ENCOUNTER_OLD_GATEAU") {
        const item = canonicalItem(event.data);
        inventory.grant({
          base: item.base,
          count: item.count,
          source: "MysteryEncounterOptionSelectedPhase",
          owners: new Set([item.owner!]),
        });
      }
    }
    return events;
  }
  it("keeps native vitamins, species boosters and Macho Brace, discards form items, and grants native Old Gateau", async () => {
    const events = await transform();
    audit.observe(party());
    auditItemLedger(inventory, initial, events, audit.knownIds(), ME.WEIRD_DREAM);
    inventory.observe(party(), stock());
    audit.finishWave();
    const moved = stock()
      .filter(item => item.args[0] === game.scene.getPlayerParty()[0].id)
      .map(item => item.className);
    expect(moved).toContain("BaseStatModifier");
    expect(moved).toContain("SpeciesStatBoosterModifier");
    expect(moved).toContain("PokemonIncrementingStatModifier");
    expect(moved).not.toContain("PokemonFormChangeItemModifier");
    expect(events.some(e => e.kind === "acquire" && e.data.typeId === "MYSTERY_ENCOUNTER_OLD_GATEAU")).toBe(true);
  });
  it("cannot credit a relocated nontransferable item before removing the old owner's stock", async () => {
    await transform();
    const vitamin = stock().find(item => item.className === "BaseStatModifier")!;
    expect(() => inventory.acquire(vitamin, "MysteryEncounterOptionSelectedPhase", audit.knownIds())).toThrow(
      /discarded source items/,
    );
  });
});
