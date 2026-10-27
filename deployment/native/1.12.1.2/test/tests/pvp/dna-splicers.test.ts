// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { modifierTypes } from "#data/data-lists";
import { CustomPokemonData } from "#data/pokemon-data";
import { AbilityId } from "#enums/ability-id";
import { BerryType } from "#enums/berry-type";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { TrainerSlot } from "#enums/trainer-slot";
import { EnemyPokemon } from "#field/pokemon";
import type { PersistentModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import { PokemonMove } from "#moves/pokemon-move";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { generatedPokemon, serialCopy } from "../../../src/pvp/generation";
import type { ShopOffer } from "../../../src/pvp/shop";

describe("DNA Splicers fusion, held item transfer, and unfuse provenance", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let partyAudit: PartyAudit;
  let inventoryAudit: InventoryAudit;
  let primaryData: PokemonData;
  let secondaryData: PokemonData;

  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
    const party = game.scene.getPlayerParty();
    primaryData = serialCopy(new PokemonData(party[0]));
    primaryData.moveset = [new PokemonMove(MoveId.TACKLE)];
    secondaryData = serialCopy(new PokemonData(party[1]));
    secondaryData.moveset = [new PokemonMove(MoveId.EMBER)];

    partyAudit = new PartyAudit();
    partyAudit.start([primaryData, secondaryData]);
    partyAudit.beginEncounter(-1);

    inventoryAudit = new InventoryAudit();
  });

  function reward(id: string, args: unknown[] = []) {
    const offer = {
      kind: "offer",
      rerolls: 0,
      copy: false,
      special: false,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [{ id, args, tier: 4, upgradeCount: 0, cost: 0 }],
    } as unknown as ShopOffer;
    partyAudit.offer(offer);
    partyAudit.selection(1, 0);
    return offer;
  }

  function giveHeldItem(pokemonIndex: number, berry: BerryType): PersistentModifier {
    const pokemon = game.scene.getPlayerParty()[pokemonIndex];
    const type = generateModifierType(modifierTypes.BERRY, [berry])!;
    const mod = type.newModifier(pokemon) as PersistentModifier;
    game.scene.addModifier(mod, true);
    const data = serialCopy(new ModifierData(mod, true));
    const entry = canonicalItem(data);
    inventoryAudit.grant({ base: entry.base, count: 1, source: "SelectModifierPhase" });
    inventoryAudit.acquire(data, "SelectModifierPhase", new Set(game.scene.getPlayerParty().map(p => p.id)));
    return mod;
  }

  it("accepts native DNA Splicers fusion, move inheritance, and held item transfers", () => {
    // Bulbasaur holds Sitrus Berry, Charmander holds Lum Berry
    giveHeldItem(0, BerryType.SITRUS);
    giveHeldItem(1, BerryType.LUM);

    const initialParty = game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    const initialModifiers = game.scene.modifiers.map(m => serialCopy(new ModifierData(m, true)));
    inventoryAudit.observe(initialParty, initialModifiers);

    const primary = game.scene.getPlayerParty()[0];
    const secondary = game.scene.getPlayerParty()[1];

    reward("DNA_SPLICERS");

    const dnaType = generateModifierType(modifierTypes.DNA_SPLICERS)!;
    const modifier = dnaType.newModifier(primary, secondary)!;
    Reflect.get(modifier, "apply").call(modifier, primary, secondary);

    const party = game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    expect(party).toHaveLength(1);
    expect(party[0].id).toBe(primaryData.id);
    expect(party[0].fusionSpecies).toBe(SpeciesId.CHARMANDER);

    // Verify held items transferred from secondary to primary in game scene
    const heldModifiers = game.scene.findModifiers(m => (m as PokemonHeldItemModifier).pokemonId === primary.id);
    expect(heldModifiers.length).toBeGreaterThanOrEqual(2);

    // Link item transfers from fusion into InventoryAudit
    inventoryAudit.bindTransfers(partyAudit.itemTransfers);

    expect(() => partyAudit.observe(party)).not.toThrow();

    const currentInventory = game.scene.modifiers.map(m => serialCopy(new ModifierData(m, true)));
    expect(() => inventoryAudit.observe(party, currentInventory)).not.toThrow();
  });

  it("preserves PP Up on moves inherited from fused secondary component", () => {
    const audit = new PartyAudit();
    audit.start([primaryData, secondaryData]);
    audit.beginEncounter(-1);

    // Wave 1: PP_MAX offered and consumed by secondary Charmander's Ember
    const ppOffer = {
      kind: "offer",
      rerolls: 0,
      copy: false,
      special: false,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [{ id: "PP_MAX", args: [], tier: 3, upgradeCount: 0, cost: 0 }],
    } as unknown as ShopOffer;
    audit.offer(ppOffer);
    audit.selection(1, 0);

    secondaryData.moveset = [new PokemonMove(MoveId.EMBER, 0, 3)];
    audit.observe([primaryData, secondaryData]);

    // Wave 2: DNA_SPLICERS offered and components fused
    audit.beginEncounter(-1);
    const dnaOffer = {
      kind: "offer",
      rerolls: 0,
      copy: false,
      special: false,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [{ id: "DNA_SPLICERS", args: [], tier: 4, upgradeCount: 0, cost: 0 }],
    } as unknown as ShopOffer;
    audit.offer(dnaOffer);
    audit.selection(1, 0);

    const fused = serialCopy(primaryData);
    fused.fusionSpecies = secondaryData.species;
    fused.fusionFormIndex = secondaryData.formIndex;
    fused.fusionAbilityIndex = secondaryData.abilityIndex;
    fused.fusionShiny = secondaryData.shiny;
    fused.fusionVariant = secondaryData.variant;
    fused.fusionGender = secondaryData.gender;
    fused.moveset = [new PokemonMove(MoveId.TACKLE), new PokemonMove(MoveId.EMBER, 0, 3)];

    expect(() => audit.observe([fused])).not.toThrow();

    // Forged PP Up on primary's Tackle (which had 0) is rejected
    const forgedPP = serialCopy(fused);
    forgedPP.moveset = [new PokemonMove(MoveId.TACKLE, 0, 1), new PokemonMove(MoveId.EMBER, 0, 3)];
    expect(() => audit.observe([forgedPP])).toThrow(/PP increase has no verified reward source/);
  });

  it("accepts upstream native unfuse() and rejects secondary resurrection", async () => {
    reward("DNA_SPLICERS");
    const primary = game.scene.getPlayerParty()[0];
    const secondary = game.scene.getPlayerParty()[1];

    const modifier = generateModifierType(modifierTypes.DNA_SPLICERS)!.newModifier(primary, secondary)!;
    Reflect.get(modifier, "apply").call(modifier, primary, secondary);

    let party = game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    partyAudit.observe(party);

    // Native unfuse
    await primary.unfuse();
    party = game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
    expect(!party[0].fusionSpecies).toBe(true);

    // Audit accepts unfused state
    expect(() => partyAudit.observe(party)).not.toThrow();

    // Resurrecting the sacrificed secondary member is rejected
    expect(() => partyAudit.observe([party[0], secondaryData])).toThrow(/unknown or retired individual in party/);
  });

  it("transfers certified permanent ability during fusion", () => {
    const sec = serialCopy(secondaryData);
    const audit = new PartyAudit({ claimEncounter: () => true });
    audit.start([primaryData, sec]);

    // Secondary acquires certified permanent ability from Fiery Fallout event
    audit.beginEncounter(ME.FIERY_FALLOUT);
    audit.fierySelection(1);
    audit.authorizePermanentAbility(AbilityId.HEATPROOF, [{ id: sec.id, fusion: false }]);
    sec.customPokemonData = new CustomPokemonData({ ability: AbilityId.HEATPROOF });

    // Update initial party state with certified secondary
    audit.observe([primaryData, sec]);

    audit.beginEncounter(-1);
    const dnaOffer = {
      kind: "offer",
      rerolls: 0,
      copy: false,
      special: false,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [{ id: "DNA_SPLICERS", args: [], tier: 4, upgradeCount: 0, cost: 0 }],
    } as unknown as ShopOffer;
    audit.offer(dnaOffer);
    audit.selection(1, 0);

    const fused = serialCopy(primaryData);
    fused.fusionSpecies = sec.species;
    fused.fusionFormIndex = sec.formIndex;
    fused.fusionAbilityIndex = sec.abilityIndex;
    fused.fusionShiny = sec.shiny;
    fused.fusionVariant = sec.variant;
    fused.fusionGender = sec.gender;
    fused.fusionCustomPokemonData = new CustomPokemonData({ ability: AbilityId.HEATPROOF });

    expect(() => audit.observe([fused])).not.toThrow();

    // In an audit where tampered fusion custom ability is attempted at fusion time:
    const sec2 = serialCopy(secondaryData);
    const tamperedAudit = new PartyAudit({ claimEncounter: () => true });
    tamperedAudit.start([primaryData, sec2]);
    tamperedAudit.beginEncounter(ME.FIERY_FALLOUT);
    tamperedAudit.fierySelection(1);
    tamperedAudit.authorizePermanentAbility(AbilityId.HEATPROOF, [{ id: sec2.id, fusion: false }]);
    sec2.customPokemonData = new CustomPokemonData({ ability: AbilityId.HEATPROOF });
    tamperedAudit.observe([primaryData, sec2]);

    tamperedAudit.beginEncounter(-1);
    tamperedAudit.offer(dnaOffer);
    tamperedAudit.selection(1, 0);

    const tampered = serialCopy(fused);
    tampered.fusionCustomPokemonData = new CustomPokemonData({ ability: AbilityId.SPEED_BOOST });
    expect(() => tamperedAudit.observe([tampered])).toThrow(
      /fusion custom abilities differ from their consumed source/,
    );
  });

  it("validates legal evolution of the secondary component while fused", () => {
    // Replace secondary with Nincada
    const nincadaEnemy = new EnemyPokemon(
      speciesDataRegistry.getSpecies(SpeciesId.NINCADA),
      18,
      TrainerSlot.NONE,
      false,
    );
    const nincadaData = serialCopy(new PokemonData(nincadaEnemy));
    nincadaData.player = true;
    partyAudit.capture(nincadaData, generatedPokemon(nincadaData), "AttemptCapturePhase");
    nincadaEnemy.destroy();

    partyAudit.observe([primaryData, nincadaData]);

    reward("DNA_SPLICERS");

    // Fuse with Nincada
    const fused = serialCopy(primaryData);
    fused.level = 20;
    fused.fusionSpecies = nincadaData.species;
    fused.fusionFormIndex = nincadaData.formIndex;
    fused.fusionAbilityIndex = nincadaData.abilityIndex;
    fused.fusionShiny = nincadaData.shiny;
    fused.fusionVariant = nincadaData.variant;
    fused.fusionGender = nincadaData.gender;
    partyAudit.observe([fused]);

    // Fused secondary evolves from Nincada to Ninjask at level 20
    const evolvedFused = serialCopy(fused);
    evolvedFused.fusionSpecies = SpeciesId.NINJASK;
    expect(() => partyAudit.observe([evolvedFused])).not.toThrow();

    // Illegal secondary evolution to unrelated species is rejected
    const illegalFused = serialCopy(fused);
    illegalFused.fusionSpecies = SpeciesId.CHARIZARD;
    expect(() => partyAudit.observe([illegalFused])).toThrow(
      /fusion has no consumed individual\/reward source|has no legal evolution path/,
    );
  });

  it("rejects ungranted or forged DNA Splicers fusion", () => {
    // Attempting fusion without DNA_SPLICERS reward
    const fusedWithoutGrant = serialCopy(primaryData);
    fusedWithoutGrant.fusionSpecies = secondaryData.species;
    fusedWithoutGrant.fusionFormIndex = secondaryData.formIndex;
    fusedWithoutGrant.fusionAbilityIndex = secondaryData.abilityIndex;
    fusedWithoutGrant.fusionShiny = secondaryData.shiny;
    fusedWithoutGrant.fusionVariant = secondaryData.variant;
    fusedWithoutGrant.fusionGender = secondaryData.gender;
    expect(() => partyAudit.observe([fusedWithoutGrant])).toThrow(/fusion has no consumed individual\/reward source/);

    // Granted DNA_SPLICERS, but claiming an uncaptured species as secondary
    reward("DNA_SPLICERS");
    const forgedSpecies = serialCopy(primaryData);
    forgedSpecies.fusionSpecies = SpeciesId.MEWTWO;
    forgedSpecies.fusionFormIndex = 0;
    forgedSpecies.fusionAbilityIndex = 0;
    forgedSpecies.fusionGender = 0;
    expect(() => partyAudit.observe([forgedSpecies])).toThrow(/fusion has no consumed individual\/reward source/);

    // Granted DNA_SPLICERS, but altering secondary component shiny attribute
    const forgedShiny = serialCopy(fusedWithoutGrant);
    forgedShiny.fusionShiny = !secondaryData.shiny;
    expect(() => partyAudit.observe([forgedShiny])).toThrow(
      /fusion component attributes changed|fusion has no consumed individual/,
    );
  });
});
