// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { EvolutionItem } from "#balance/pokemon-evolutions";
import { modifierTypes } from "#data/data-lists";
import { Gender } from "#data/gender";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { TrainerSlot } from "#enums/trainer-slot";
import { EnemyPokemon } from "#field/pokemon";
import { ModifierTypeOption } from "#modifiers/modifier-type";
import { PokemonMove } from "#moves/pokemon-move";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { generatedPokemon, serialCopy } from "../../../src/pvp/generation";
import { optionData, type ShopOffer } from "../../../src/pvp/shop";

describe("Persistent party individual provenance", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let audit: PartyAudit;
  let first: PokemonData;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    first = serialCopy(new PokemonData(game.scene.getPlayerParty()[0]));
    first.moveset = [new PokemonMove(MoveId.TACKLE)];
    audit = new PartyAudit();
    audit.start([first]);
    audit.beginEncounter(-1);
  });
  it("accepts real multi-stage evolution rules and level-up moves", () => {
    const evolved = serialCopy(first);
    evolved.species = SpeciesId.VENUSAUR;
    evolved.level = 36;
    evolved.moveset = [new PokemonMove(MoveId.TACKLE), new PokemonMove(MoveId.VINE_WHIP)];
    expect(() => audit.observe([evolved])).not.toThrow();
  });
  it.each([Gender.MALE, Gender.FEMALE])("enforces gender-specific evolution (%s)", gender => {
    const salandit = serialCopy(first);
    salandit.species = SpeciesId.SALANDIT;
    salandit.gender = gender;
    salandit.moveset = [new PokemonMove(MoveId.EMBER)];
    const source = new PartyAudit();
    source.start([salandit]);
    const salazzle = serialCopy(salandit);
    salazzle.species = SpeciesId.SALAZZLE;
    salazzle.level = 40;
    if (gender === Gender.MALE) {
      expect(() => source.observe([salazzle])).toThrow(/evolution path/);
    } else {
      expect(() => source.observe([salazzle])).not.toThrow();
    }
  });
  it.each([
    [
      "unrelated species",
      (p: PokemonData) => {
        p.species = SpeciesId.MEWTWO;
      },
    ],
    [
      "too-early evolution",
      (p: PokemonData) => {
        p.species = SpeciesId.VENUSAUR;
      },
    ],
    [
      "invented move",
      (p: PokemonData) => {
        p.moveset = [new PokemonMove(MoveId.SPORE)];
      },
    ],
    [
      "ability",
      (p: PokemonData) => {
        p.abilityIndex = 2;
      },
    ],
    [
      "passive",
      (p: PokemonData) => {
        p.passive = !p.passive;
      },
    ],
    [
      "shiny",
      (p: PokemonData) => {
        p.shiny = !p.shiny;
      },
    ],
    [
      "variant",
      (p: PokemonData) => {
        p.variant = 2;
      },
    ],
    [
      "nature",
      (p: PokemonData) => {
        p.nature = (p.nature + 1) % 25;
      },
    ],
  ] as const)("rejects a same-ID mutation of %s", (_name, change) => {
    const forged = serialCopy(first);
    change(forged);
    expect(() => audit.observe([forged])).toThrow(/party provenance/);
  });
  function reward(id: string, args: number[] = []) {
    const offer = {
      kind: "offer",
      rerolls: 0,
      copy: false,
      special: false,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [{ id, args, tier: 1, upgradeCount: 0, cost: 0 }],
    } as ShopOffer;
    audit.offer(offer);
    audit.selection(1, 0);
    return offer;
  }
  it("requires a selected verified TM and only grants it once", () => {
    const party = serialCopy(first);
    party.moveset = [new PokemonMove(MoveId.SOLAR_BEAM)];
    const offer = reward("TM_ULTRA", [MoveId.SOLAR_BEAM]);
    expect(() => audit.observe([party])).not.toThrow();
    expect(() => audit.offer(offer)).toThrow(/too many fresh/);
  });
  it("does not authorize an unchosen TM option", () => {
    const offer = {
      kind: "offer",
      rerolls: 0,
      copy: false,
      options: [{ id: "TM_ULTRA", args: [MoveId.SOLAR_BEAM] }],
    } as ShopOffer;
    audit.offer(offer);
    const party = serialCopy(first);
    party.moveset = [new PokemonMove(MoveId.SOLAR_BEAM)];
    expect(() => audit.observe([party])).toThrow(/learning source/);
  });
  it("certifies the actual mint effect and binds its generated nature", () => {
    const pokemon = game.scene.getPlayerParty()[0];
    pokemon.moveset = first.moveset.map(m => new PokemonMove(m.moveId));
    const nature = (first.nature + 1) % 25;
    const type = generateModifierType(modifierTypes.MINT, [nature])!;
    expect(optionData(new ModifierTypeOption(type, 0)).args).toEqual([nature]);
    reward("MINT", [nature]);
    const modifier = type.newModifier(pokemon)!;
    Reflect.get(modifier, "apply").call(modifier, pokemon);
    const changed = serialCopy(new PokemonData(pokemon));
    expect(changed.nature).toBe(first.nature);
    expect(changed.customPokemonData.nature).toBe(nature);
    expect(() => audit.observe([changed])).not.toThrow();
    const unverified = new PartyAudit();
    unverified.start([first]);
    expect(() => unverified.observe([changed])).toThrow(/verified mint/);
  });
  it("ties an item evolution to a verified item reward", () => {
    const vulpix = serialCopy(first);
    vulpix.species = SpeciesId.VULPIX;
    vulpix.moveset = [new PokemonMove(MoveId.EMBER)];
    const ninetales = serialCopy(vulpix);
    ninetales.species = SpeciesId.NINETALES;
    const denied = new PartyAudit();
    denied.start([vulpix]);
    expect(() => denied.observe([ninetales])).toThrow(/evolution item/);
    const allowed = new PartyAudit();
    allowed.start([vulpix]);
    allowed.grant("evolution", EvolutionItem.FIRE_STONE);
    expect(() => allowed.observe([ninetales])).not.toThrow();
  });
  it("requires a real selected PP Max for a permanent PP increase", () => {
    const p = serialCopy(first);
    p.moveset[0].ppUp = 3;
    expect(() => audit.observe([p])).toThrow(/PP increase/);
    const pokemon = game.scene.getPlayerParty()[0];
    pokemon.moveset = first.moveset.map(m => new PokemonMove(m.moveId));
    const type = generateModifierType(modifierTypes.PP_MAX)!;
    const modifier = type.newModifier(pokemon, 0)!;
    Reflect.get(modifier, "apply").call(modifier, pokemon);
    reward("PP_MAX");
    expect(new PokemonData(pokemon).moveset[0].ppUp).toBe(3);
    expect(() => audit.observe([serialCopy(new PokemonData(pokemon))])).not.toThrow();
  });
  it("retains the actual generated TM move in the reward receipt", () => {
    const type = generateModifierType(modifierTypes.TM_ULTRA, [MoveId.SOLAR_BEAM])!;
    expect(optionData(new ModifierTypeOption(type, 0)).args).toEqual([MoveId.SOLAR_BEAM]);
  });
  it.each([ME.TRAINING_SESSION, ME.SHADY_VITAMIN_DEALER])("bounds direct encounter nature changes (%s)", source => {
    const second = captureCharmander();
    audit.beginEncounter(source);
    const changed = serialCopy(first);
    changed.customPokemonData = { ...changed.customPokemonData, nature: (changed.nature + 1) % 25 };
    audit.observe([changed, second]);
    second.customPokemonData = { ...second.customPokemonData, nature: (second.nature + 1) % 25 };
    expect(() => audit.observe([changed, second])).toThrow(/encounter source/);
  });
  it("rejects a captured individual's permanent attribute mutation", () => {
    const p = serialCopy(first);
    p.id++;
    const source = generatedPokemon(p);
    p.gender = p.gender === 0 ? 1 : 0;
    expect(() => audit.capture(p, source, "AttemptCapturePhase")).toThrow(/captured gender/);
  });
  function captureCharmander() {
    const enemy = new EnemyPokemon(speciesDataRegistry.getSpecies(SpeciesId.CHARMANDER), 35, TrainerSlot.NONE, false);
    const data = serialCopy(new PokemonData(enemy));
    data.player = true;
    data.moveset = [new PokemonMove(MoveId.EMBER)];
    const generated = generatedPokemon(data);
    audit.capture(data, generated, "AttemptCapturePhase");
    enemy.destroy();
    return data;
  }
  it.each([
    ["one legal Sketch", [MoveId.SPORE], true],
    ["Struggle", [MoveId.STRUGGLE], false],
    ["two copies from one Sketch", [MoveId.SPORE, MoveId.SOLAR_BEAM], false],
  ] as const)("bounds moves copied before a capture: %s", (_name, copied, accepted) => {
    const enemy = new EnemyPokemon(speciesDataRegistry.getSpecies(SpeciesId.SMEARGLE), 35, TrainerSlot.NONE, false);
    enemy.moveset = [new PokemonMove(MoveId.SKETCH)];
    const data = serialCopy(new PokemonData(enemy));
    const proof = generatedPokemon(data);
    data.moveset = copied.map(move => new PokemonMove(move));
    const check = () => audit.capture(data, proof, "AttemptCapturePhase");
    if (accepted) {
      expect(check).not.toThrow();
    } else {
      expect(check).toThrow(/captured moves/);
    }
    enemy.destroy();
  });
  it("consumes the secondary individual when a verified fusion is observed", () => {
    const second = captureCharmander();
    reward("DNA_SPLICERS");
    const fused = serialCopy(first);
    fused.level = 35;
    fused.fusionSpecies = second.species;
    fused.fusionFormIndex = second.formIndex;
    fused.fusionAbilityIndex = second.abilityIndex;
    fused.fusionShiny = second.shiny;
    fused.fusionVariant = second.variant;
    fused.fusionGender = second.gender;
    fused.moveset.push(new PokemonMove(MoveId.EMBER));
    expect(() => audit.observe([fused])).not.toThrow();
    expect(() => audit.observe([fused, second])).toThrow(/retired/);
  });
  it("accepts the actual upstream DNA Splicers effect", () => {
    const primary = game.scene.getPlayerParty()[0];
    primary.moveset = first.moveset.map(m => new PokemonMove(m.moveId));
    const secondary = game.scene.addPlayerPokemon(
      speciesDataRegistry.getSpecies(SpeciesId.CHARMANDER),
      primary.level,
      0,
    );
    secondary.moveset = [new PokemonMove(MoveId.EMBER)];
    game.scene.getPlayerParty().push(secondary);
    audit = new PartyAudit();
    audit.start(game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p))));
    audit.beginEncounter(-1);
    reward("DNA_SPLICERS");
    const type = generateModifierType(modifierTypes.DNA_SPLICERS)!;
    const modifier = type.newModifier(primary, secondary)!;
    Reflect.get(modifier, "apply").call(modifier, primary, secondary);
    const party = game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    expect(party).toHaveLength(1);
    expect(party[0].fusionSpecies).toBe(SpeciesId.CHARMANDER);
    expect(() => audit.observe(party)).not.toThrow();
  });
  it("rejects a forged fusion component despite a real fusion reward", () => {
    captureCharmander();
    reward("DNA_SPLICERS");
    const fused = serialCopy(first);
    fused.fusionSpecies = SpeciesId.MEWTWO;
    fused.fusionFormIndex = 0;
    fused.fusionAbilityIndex = 0;
    expect(() => audit.observe([fused])).toThrow(/fusion/);
  });
  it("rejects resurrection of a released individual", () => {
    const second = captureCharmander();
    audit.observe([first, second]);
    audit.observe([first]);
    expect(() => audit.observe([first, second])).toThrow(/retired/);
  });
  it("accepts the actual upstream Ninjask and Shedinja evolution with a new individual ID", async () => {
    const pokemon = game.scene.getPlayerParty()[0];
    pokemon.species = speciesDataRegistry.getSpecies(SpeciesId.NINCADA);
    pokemon.level = 20;
    pokemon.moveset = [new PokemonMove(MoveId.SCRATCH)];
    const source = serialCopy(new PokemonData(pokemon));
    const provenance = new PartyAudit();
    provenance.start([source]);
    const evolution = speciesDataRegistry
      .getEvolutions(SpeciesId.NINCADA)
      .find(e => e.speciesId === SpeciesId.NINJASK)!;
    await pokemon.evolve(evolution, pokemon.getSpeciesForm());
    const party = game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    expect(party.map(p => p.species)).toEqual([SpeciesId.NINJASK, SpeciesId.SHEDINJA]);
    expect(party[0].id).not.toBe(party[1].id);
    expect(() => provenance.observe(party)).not.toThrow();
    const forged = serialCopy(party);
    forged[1].level++;
    const checkedBirth = new PartyAudit();
    checkedBirth.start([source]);
    expect(() => checkedBirth.observe(forged)).toThrow(/unknown or retired/);
  });
});
