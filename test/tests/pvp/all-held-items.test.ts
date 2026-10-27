// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { modifierTypes } from "#data/data-lists";
import { SpeciesFormChangeItemTrigger } from "#data/form-change-triggers";
import { BerryType } from "#enums/berry-type";
import { FormChangeItem } from "#enums/form-change-item";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { PersistentModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import { ModifierTypeGenerator, type ModifierTypeKeys } from "#modifiers/modifier-type";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import heldClasses from "../../../src/pvp/held-modifiers.json";
import { loadSession } from "../../../src/pvp/loader";
import fixture from "../../fixtures/pvp/streak-item-session.json";
import { checkHeldEffect } from "./held-item-effects";

type ItemCase = {
  key: string;
  held: boolean;
  temporary: boolean;
  owner: number;
  source: { party: PokemonData[]; modifiers: ModifierData[] };
};
const temporaryClasses = new Set([
  "TempStatStageBoosterModifier",
  "TempCritBoosterModifier",
  "DoubleBattleChanceBoosterModifier",
  "TempExtraModifierModifier",
]);

/** Enumerates real factories, including every generator parameter, instead of treating base classes as items. */
async function catalog(game: GameManager) {
  await loadSession(game.scene.gameData, game.scene.gameData.parseSessionData(JSON.stringify(fixture)));
  game.scene.modifiers = [];
  Reflect.set(game.scene, "enemyModifiers", []);
  const party = game.scene.getPlayerParty();
  for (const [i, p] of party.entries()) {
    p.id = 1001 + i;
    p.ivs = [31, 31, 31, 31, 31, 31];
  }
  const speciesItems = Reflect.get(modifierTypes.SPECIES_STAT_BOOSTER().constructor, "items") as Record<
    string,
    { species: SpeciesId[]; rare: boolean }
  >;
  const forms = new Map<FormChangeItem, { species: SpeciesId; formIndex: number; preFormIndex: number }>();
  for (const id of Object.keys(speciesDataRegistry.data).map(Number) as SpeciesId[]) {
    for (const change of speciesDataRegistry.getFormChanges(id)) {
      const trigger = change.findTrigger(SpeciesFormChangeItemTrigger) as SpeciesFormChangeItemTrigger | undefined;
      if (!trigger?.active || forms.has(trigger.item)) {
        continue;
      }
      const species = speciesDataRegistry.getSpecies(id);
      forms.set(trigger.item, {
        species: id,
        formIndex: Math.max(
          0,
          species.forms.findIndex(f => f.formKey === change.formKey),
        ),
        preFormIndex: Math.max(
          0,
          species.forms.findIndex(f => f.formKey === change.preFormKey),
        ),
      });
    }
  }
  const cases: ItemCase[] = [];
  const excluded: Record<string, string> = {};
  const add = (id: ModifierTypeKeys, params?: unknown[], species = SpeciesId.EEVEE, formIndex = 0) => {
    const p = party[cases.length % party.length];
    p.species = speciesDataRegistry.getSpecies(species);
    p.formIndex = formIndex;
    p.abilityIndex = 0;
    const type = generateModifierType(modifierTypes[id], params);
    expect(type, `${id}: generator failed`).toBeTruthy();
    const modifier = type!.newModifier(p, party[(party.indexOf(p) + 1) % party.length]);
    if (!(modifier instanceof PersistentModifier)) {
      excluded[id] = "consumable";
      return;
    }
    const held = modifier instanceof PokemonHeldItemModifier;
    if (held) {
      expect(heldClasses).toContain(modifier.constructor.name);
    }
    const maximum = modifier.getMaxStackCount();
    expect(maximum, id).toBeGreaterThan(0);
    for (const count of [...new Set([1, maximum])]) {
      modifier.stackCount = count;
      const data = new ModifierData(modifier, true);
      // Native serialization must preserve the full constructor payload, including form activation.
      const restored = data.toModifier(modifier.constructor);
      expect(restored, `${id}: native restore`).toBeTruthy();
      expect(new ModifierData(restored!, true)).toEqual(data);
      cases.push({
        key: `${id}:${JSON.stringify(params ?? [])}:${count}`,
        held,
        temporary: temporaryClasses.has(modifier.constructor.name),
        owner: party.indexOf(p),
        source: JSON.parse(JSON.stringify({ party: party.map(p => new PokemonData(p)), modifiers: [data] })),
      });
      if (id.includes("FORM_CHANGE_ITEM")) {
        const inactive = JSON.parse(JSON.stringify(cases.at(-1))) as ItemCase;
        inactive.key += ":inactive";
        inactive.source.modifiers[0].args[2] = false;
        inactive.source.party[inactive.owner].formIndex = forms.get(params![0] as FormChangeItem)!.preFormIndex;
        cases.push(inactive);
      }
    }
  };
  for (const id of Object.keys(modifierTypes) as ModifierTypeKeys[]) {
    if (id.startsWith("ENEMY_")) {
      excluded[id] = "enemy-only token";
      continue;
    }
    if (!(modifierTypes[id]() instanceof ModifierTypeGenerator)) {
      add(
        id,
        undefined,
        id === "LEEK"
          ? SpeciesId.FARFETCHD
          : id === "EVOLUTION_TRACKER_GIMMIGHOUL"
            ? SpeciesId.GIMMIGHOUL
            : SpeciesId.EEVEE,
      );
      continue;
    }
    switch (id) {
      case "BASE_STAT_BOOSTER":
        for (let stat = Stat.HP; stat <= Stat.SPD; stat++) {
          add(id, [stat]);
        }
        break;
      case "TEMP_STAT_STAGE_BOOSTER":
        for (const stat of [Stat.ATK, Stat.DEF, Stat.SPATK, Stat.SPDEF, Stat.SPD, Stat.ACC]) {
          add(id, [stat]);
        }
        break;
      case "ATTACK_TYPE_BOOSTER":
        for (let type = 0; type < 18; type++) {
          add(id, [type]);
        }
        break;
      case "BERRY":
        for (const type of Object.values(BerryType).filter(v => typeof v === "number")) {
          add(id, [type]);
        }
        break;
      case "SPECIES_STAT_BOOSTER":
      case "RARE_SPECIES_STAT_BOOSTER":
        for (const [name, item] of Object.entries(speciesItems)) {
          if (item.rare === id.startsWith("RARE_")) {
            add(id, [name], item.species[0]);
          }
        }
        break;
      case "FORM_CHANGE_ITEM":
      case "RARE_FORM_CHANGE_ITEM":
        for (const [item, target] of forms) {
          if (item < 150 === id.startsWith("RARE_")) {
            add(id, [item], target.species, target.formIndex);
          }
        }
        break;
      case "MYSTERY_ENCOUNTER_SHUCKLE_JUICE":
        add(id, [10]);
        add(id, [-15]);
        break;
      case "MYSTERY_ENCOUNTER_BLACK_SLUDGE":
        add(id, [2.5]);
        break;
      case "EVOLUTION_ITEM":
      case "RARE_EVOLUTION_ITEM":
      case "MINT":
      case "TERA_SHARD":
      case "TM_COMMON":
      case "TM_GREAT":
      case "TM_ULTRA":
        excluded[id] = "consumable generator";
        break;
      default:
        throw new Error(`Uncovered item generator: ${id}`);
    }
  }
  return {
    cases,
    excluded,
    formItems: [...forms.keys()].map(id => FormChangeItem[id]),
    unusedFormEnums: Object.values(FormChangeItem)
      .filter((v): v is number => typeof v === "number" && !forms.has(v))
      .map(id => FormChangeItem[id]),
  };
}

describe("Complete native held-item catalog for registered teams", () => {
  let game: GameManager;
  let phaser: Phaser.Game;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.runToTitle();
  });
  it("round-trips every persistent factory and held variant at one and maximum stacks", async () => {
    const result = await catalog(game);
    expect(result.cases.filter(c => c.held).length).toBeGreaterThan(200);
    expect(result.cases.filter(c => c.temporary).length).toBeGreaterThan(8);
    if (process.env.PVP_ALL_ITEM_CATALOG) {
      fs.writeFileSync(process.env.PVP_ALL_ITEM_CATALOG, JSON.stringify(result, null, 2));
    }
  });
  it.skipIf(!process.env.PVP_ALL_ITEM_ROUNDTRIP)(
    "loads every real Go-generated match with exact items on both teams",
    async () => {
      const rows = JSON.parse(fs.readFileSync(process.env.PVP_ALL_ITEM_ROUNDTRIP!, "utf8")) as {
        item: ItemCase;
        session: typeof fixture;
      }[];
      expect(rows.length).toBeGreaterThan(200);
      for (const { item, session } of rows) {
        game.scene.reset(false, true);

        await loadSession(game.scene.gameData, game.scene.gameData.parseSessionData(JSON.stringify(session)));
        game.scene.phaseManager.clearPhaseQueue();
        for (const player of [true, false]) {
          const mods = game.scene.findModifiers(() => true, player);
          expect(mods.length, item.key).toBe(item.temporary ? 0 : 1);
          if (item.temporary) {
            continue;
          }
          const expected = JSON.parse(JSON.stringify(item.source.modifiers[0])) as ModifierData;
          expected.player = player;
          if (item.held) {
            expected.args[0] = (player ? 1 : 101) + item.owner;
          }
          expect(new ModifierData(mods[0], player), `${item.key}, player=${player}`).toEqual(expected);
          if (mods[0] instanceof PokemonHeldItemModifier) {
            const party = player ? game.scene.getPlayerParty() : game.scene.getEnemyParty();
            expect(mods[0].getPokemon(), item.key).toBe(party[item.owner]);
            expect(party[item.owner].formIndex, item.key).toBe(item.source.party[item.owner].formIndex);
            try {
              await checkHeldEffect(mods[0], party[item.owner], game.scene);
            } catch (error) {
              throw new Error(`${item.key}, player=${player}: ${error}`, { cause: error });
            }
          }
        }
      }
    },
    180_000,
  );
});
