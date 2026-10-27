// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { modifierTypes } from "#data/data-lists";
import { SpeciesFormChangeItemTrigger } from "#data/form-change-triggers";
import { FormChangeItem } from "#enums/form-change-item";
import { SpeciesId } from "#enums/species-id";
import { TrainerSlot } from "#enums/trainer-slot";
import { EnemyPokemon } from "#field/pokemon";
import type { PersistentModifier } from "#modifiers/modifier";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { generatedPokemon, serialCopy } from "../../../src/pvp/generation";

describe("Form changes require physical, certified item ownership", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let inventory: InventoryAudit;
  let audit: PartyAudit;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.CHARIZARD, SpeciesId.CHARIZARD);
    inventory = new InventoryAudit();
    audit = new PartyAudit({ inventory: owner => inventory.provedItems(owner) });
    audit.start(party());
  });
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  const ids = () => new Set(game.scene.getPlayerParty().map(p => p.id));
  const stock = () => game.scene.modifiers.map(m => new ModifierData(m, true));
  const change = () =>
    speciesDataRegistry
      .getFormChanges(SpeciesId.CHARIZARD)
      .find(
        c =>
          (c.findTrigger(SpeciesFormChangeItemTrigger) as SpeciesFormChangeItemTrigger)?.item
          === FormChangeItem.CHARIZARDITE_X,
      )!;
  const formIndex = () =>
    speciesDataRegistry.getSpecies(SpeciesId.CHARIZARD).forms.findIndex(f => f.formKey === change().formKey);
  function stone(owner = 0, apply = true) {
    const modifier = generateModifierType(modifierTypes.FORM_CHANGE_ITEM, [FormChangeItem.CHARIZARDITE_X])!.newModifier(
      game.scene.getPlayerParty()[owner],
    ) as PersistentModifier;
    const data = new ModifierData(modifier, true);
    inventory.grant({ base: canonicalItem(data).base, count: 1, source: "SelectModifierPhase" });
    inventory.acquire(data, "SelectModifierPhase", ids());
    if (apply) {
      game.scene.addModifier(modifier, true);
      inventory.observe(game.scene.getPlayerParty(), stock());
    }
    return modifier;
  }
  it("accepts an actual native Mega evolution after a validated item acquisition", async () => {
    stone();
    const pokemon = game.scene.getPlayerParty()[0];
    expect(change().canChange(pokemon)).toBe(true);
    await pokemon.changeForm(change());
    expect(pokemon.formIndex).toBe(formIndex());
    expect(() => audit.observe(party())).not.toThrow();
  });
  it("rejects a legal registry form without a certified stone", () => {
    const forged = party();
    forged[0].formIndex = formIndex();
    expect(() => audit.observe(forged)).toThrow(/form item.*ownership/);
  });
  it("does not lend another party member's nontransferable stone", () => {
    stone(1);
    const forged = party();
    forged[0].formIndex = formIndex();
    expect(() => audit.observe(forged)).toThrow(/form item.*ownership/);
  });
  it("does not grant form rights for an acquisition receipt without a physical checkpoint", () => {
    stone(0, false);
    const forged = party();
    forged[0].formIndex = formIndex();
    expect(() => audit.observe(forged)).toThrow(/form item.*ownership/);
    inventory.observe(game.scene.getPlayerParty(), []);
    expect(inventory.provedItems(forged[0].id)).toEqual([]);
  });
  it("forgets a discarded stone's transformation rights at the next wave", () => {
    const modifier = stone();
    game.scene.removeModifier(modifier);
    inventory.observe(game.scene.getPlayerParty(), stock());
    inventory.begin([]);
    const forged = party();
    forged[0].formIndex = formIndex();
    expect(() => audit.observe(forged)).toThrow(/form item.*ownership/);
  });
  it("rejects a forged captured form even when all other generated attributes match", () => {
    const enemy = new EnemyPokemon(speciesDataRegistry.getSpecies(SpeciesId.CHARIZARD), 50, TrainerSlot.NONE, false);
    const data = serialCopy(new PokemonData(enemy));
    const generated = generatedPokemon(data);
    data.formIndex = formIndex();
    expect(() => audit.capture(data, generated, "AttemptCapturePhase")).toThrow(/form item.*ownership/);
    enemy.destroy();
  });
  it("defers form checking until the wave's ordered inventory stream is verified", () => {
    const delayed = new PartyAudit({ inventory: owner => inventory.provedItems(owner), deferResources: true });
    const data = party();
    delayed.start(data);
    data[0].formIndex = formIndex();
    delayed.observe(data);
    expect(() => delayed.finishWave()).toThrow(/form item.*ownership/);
    stone();
    expect(() => delayed.finishWave()).not.toThrow();
  });
});
