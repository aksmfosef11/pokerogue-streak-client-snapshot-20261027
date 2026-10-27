// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { getLevelTotalExp } from "#data/exp";
import { Nature } from "#enums/nature";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import type { PersistentModifier } from "#modifiers/modifier";
import { ModifierTypeOption } from "#modifiers/modifier-type";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { selectedItemGrant } from "../../../src/pvp/audit-item-sources";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { serialCopy } from "../../../src/pvp/generation";
import { optionData, type ShopOffer } from "../../../src/pvp/shop";

describe("Native experience caps and certified candy growth", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BLISSEY, SpeciesId.CHARMANDER);
  });
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  function setup(level = 250, jars = 0, physical = true) {
    game.scene.currentBattle.waveIndex = 200;
    for (const pokemon of game.scene.getPlayerParty()) {
      pokemon.level = level;
      pokemon.exp = getLevelTotalExp(level, pokemon.species.growthRate);
      pokemon.calculateStats();
    }
    const inventory = new InventoryAudit();
    inventory.begin([]);
    if (jars) {
      const item = generateModifierType(modifierTypes.CANDY_JAR)!.newModifier() as PersistentModifier;
      item.stackCount = jars;
      const data = serialCopy(new ModifierData(item, true));
      inventory.grant({ base: canonicalItem(data).base, count: jars, source: "ModifierRewardPhase" });
      inventory.acquire(data, "ModifierRewardPhase", new Set(party().map(p => p.id)));
      game.scene.addModifier(item, true);
      if (physical) {
        inventory.observe(
          party(),
          game.scene.modifiers.map(m => new ModifierData(m, true)),
        );
      }
    }
    const audit = new PartyAudit({
      inventory: id => inventory.provedItems(id),
      claimReward: (group, choice) => inventory.claimChoice(group, choice),
      deferResources: true,
    });
    audit.start(party());
    audit.beginEncounter(-1, game.scene.getMaxExpLevel());
    return { audit, inventory };
  }
  function offer(audit: PartyAudit, choices: readonly (readonly [string, unknown[]?])[]) {
    const types = choices.map(([id, args]) => generateModifierType(modifierTypes[id], args)!);
    const data: ShopOffer = {
      kind: "offer",
      session: serialCopy(game.scene.gameData.getSessionSaveData()),
      options: types.map(type => optionData(new ModifierTypeOption(type, 0))),
      rerolls: 0,
      special: false,
      copy: false,
      locked: false,
    };
    audit.offer(data);
    return { data, types };
  }
  it.each([1, 10, 100, 200])("matches native EXP saturation at wave %i and refuses an extra level", wave => {
    const { audit } = setup(5);
    game.scene.currentBattle.waveIndex = wave;
    const cap = game.scene.getMaxExpLevel();
    audit.beginEncounter(-1, cap);
    for (const pokemon of game.scene.getPlayerParty()) {
      pokemon.addExp(1e12);
      expect(pokemon.level).toBe(cap);
    }
    audit.observe(party());
    expect(() => audit.finishWave()).not.toThrow();
    const forged = party();
    forged[0].level++;
    expect(() => audit.observe(forged)).toThrow(/level increase has no certified candy source/);
  });
  it.each([250, 10000])("accepts native candy growth past the former fixed limit from %i", level => {
    const { audit } = setup(level, 99);
    const { types } = offer(audit, [["RARE_CANDY"]]);
    audit.selection(1, 0);
    game.scene.addModifier(types[0].newModifier(game.scene.getPlayerParty()[0]), true);
    expect(game.scene.getPlayerParty()[0].level).toBe(level + 100);
    audit.observe(party());
    expect(() => audit.finishWave()).not.toThrow();
  });
  it("does not invent a Candy Jar boost from an acquisition receipt without a physical checkpoint", () => {
    const { audit } = setup(250, 99, false);
    const { types } = offer(audit, [["RARE_CANDY"]]);
    audit.selection(1, 0);
    game.scene.addModifier(types[0].newModifier(game.scene.getPlayerParty()[0]), true);
    audit.observe(party());
    expect(() => audit.finishWave()).toThrow(/Candy Jar budget/);
  });
  it("preserves native high-level HP above the old result guard with real held HP vitamins", () => {
    const pokemon = game.scene.getPlayerParty()[0];
    pokemon.ivs.fill(31);
    const { audit, inventory } = setup(10000, 99);
    const vitamin = generateModifierType(modifierTypes.BASE_STAT_BOOSTER, [Stat.HP])!.newModifier(
      pokemon,
    ) as PersistentModifier;
    vitamin.stackCount = 31;
    const data = new ModifierData(vitamin, true);
    inventory.grant({ base: canonicalItem(data).base, count: 31, source: "ModifierRewardPhase" });
    inventory.acquire(data, "ModifierRewardPhase", new Set([pokemon.id]));
    game.scene.addModifier(vitamin, true);
    inventory.observe(
      party(),
      game.scene.modifiers.map(m => new ModifierData(m, true)),
    );
    const { types } = offer(audit, [["RARE_CANDY"]]);
    audit.selection(1, 0);
    game.scene.addModifier(types[0].newModifier(pokemon), true);
    pokemon.calculateStats();
    expect(pokemon.level).toBe(10100);
    expect(pokemon.getMaxHp()).toBeGreaterThan(100000);
    audit.observe(party());
    expect(() => audit.finishWave()).not.toThrow();
    console.info(JSON.stringify({ species: SpeciesId.BLISSEY, level: pokemon.level, maxHP: pokemon.getMaxHp() }));
  });
  it("limits an ordinary candy to one increment and one owner", () => {
    const { audit } = setup();
    const { types } = offer(audit, [["RARE_CANDY"]]);
    audit.selection(1, 0);
    game.scene.addModifier(types[0].newModifier(game.scene.getPlayerParty()[0]), true);
    const forged = party();
    forged[1].level++;
    audit.observe(forged);
    expect(() => audit.finishWave()).toThrow(/Candy Jar budget/);
  });
  it("accepts the native all-party candy with the same proved Jar boost for each current member", () => {
    const { audit } = setup(250, 99);
    const { types } = offer(audit, [["RARER_CANDY"]]);
    audit.selection(1, 0);
    game.scene.addModifier(types[0].newModifier(), true);
    expect(game.scene.getPlayerParty().map(p => p.level)).toEqual([350, 350]);
    audit.observe(party());
    expect(() => audit.finishWave()).not.toThrow();
  });
  it("does not borrow a future choice to explain an earlier shop checkpoint", () => {
    const { audit } = setup();
    offer(audit, [["RARE_CANDY"]]);
    const forged = party();
    forged[0].level++;
    expect(() => audit.observe(forged)).toThrow(/no certified candy source/);
  });
  it("cannot bank an unused immediate-use candy into a later wave", () => {
    const { audit } = setup();
    offer(audit, [["RARE_CANDY"]]);
    audit.selection(1, 0);
    audit.beginEncounter(-1, game.scene.getMaxExpLevel());
    const forged = party();
    forged[0].level++;
    expect(() => audit.observe(forged)).toThrow(/no certified candy source/);
  });
  it("accepts cancelling a candy then applying a native mint, but cannot claim both rewards", () => {
    const { audit } = setup();
    const { types } = offer(audit, [["RARE_CANDY"], ["MINT", [Nature.ADAMANT]]]);
    audit.selection(1, 0);
    audit.selection(1, 1);
    game.scene.addModifier(types[1].newModifier(game.scene.getPlayerParty()[0]), true);
    audit.observe(party());
    expect(() => audit.finishWave()).not.toThrow();
    const forged = party();
    forged[0].level++;
    audit.observe(forged);
    expect(() => audit.finishWave()).toThrow(/Candy Jar budget/);
  });
  it("shares a reward choice with the physical-item ledger after cancelling a candy", () => {
    const { audit, inventory } = setup();
    const { data, types } = offer(audit, [["RARE_CANDY"], ["MAP"]]);
    audit.selection(1, 0);
    audit.selection(1, 1);
    const grant = selectedItemGrant(data, 1, 1, "reward:1")!;
    inventory.grant(grant);
    const map = types[1].newModifier() as PersistentModifier;
    inventory.acquire(new ModifierData(map, true), "SelectModifierPhase", new Set(party().map(p => p.id)));
    game.scene.addModifier(map, true);
    inventory.observe(
      party(),
      game.scene.modifiers.map(m => new ModifierData(m, true)),
    );
    audit.observe(party());
    expect(() => audit.finishWave()).not.toThrow();
    const forged = party();
    forged[0].level++;
    audit.observe(forged);
    expect(() => audit.finishWave()).toThrow(/Candy Jar budget/);
  });
  it("does not duplicate a candy by reopening the same offer", () => {
    const { audit } = setup();
    const { data } = offer(audit, [["RARE_CANDY"]]);
    audit.selection(1, 0);
    audit.offer({ ...data, copy: true });
    audit.selection(1, 0);
    const forged = party();
    forged[0].level += 2;
    audit.observe(forged);
    expect(() => audit.finishWave()).toThrow(/Candy Jar budget/);
  });
});
