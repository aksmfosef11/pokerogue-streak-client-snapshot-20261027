// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry as registry } from "#app/global-species-data-registry";
import { EvolutionItem } from "#balance/pokemon-evolutions";
import { modifierTypes } from "#data/data-lists";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { Nature } from "#enums/nature";
import { SpeciesId } from "#enums/species-id";
import { TimeOfDay } from "#enums/time-of-day";
import type { PersistentModifier } from "#modifiers/modifier";
import { PokemonMove } from "#moves/pokemon-move";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { serialCopy } from "../../../src/pvp/generation";

describe("Native evolution branch and prerequisite provenance", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(() => {
    game = new GameManager(phaser);
  });
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  it.each([SpeciesId.TANDEMAUS, SpeciesId.DUNSPARCE])(
    "matches both native ID-seeded branches, including the common fallback (%i)",
    async species => {
      game.override.startingLevel(40);
      await game.classicMode.startBattle(species);
      const pokemon = game.scene.getPlayerParty()[0];
      if (species === SpeciesId.DUNSPARCE) {
        pokemon.moveset = [new PokemonMove(MoveId.HYPER_DRILL)];
      }
      const forms = new Set<number>();
      for (let id = 100; id < 132; id++) {
        pokemon.id = id;
        const rule = pokemon.getEvolution()!;
        expect(rule).not.toBeNull();
        const source = party();
        const evolved = serialCopy(source);
        evolved[0].species = rule.speciesId;
        evolved[0].formIndex = registry.getSpecies(rule.speciesId).forms.findIndex(f => f.formKey === rule.evoFormKey);
        forms.add(evolved[0].formIndex);
        const audit = new PartyAudit({ seed: game.scene.seed });
        audit.start(source);
        const rng = Phaser.Math.RND.state();
        expect(() => audit.observe(evolved)).not.toThrow();
        expect(Phaser.Math.RND.state()).toBe(rng);
        const wrong = new PartyAudit({ seed: game.scene.seed });
        wrong.start(source);
        evolved[0].formIndex = evolved[0].formIndex === 0 ? 1 : 0;
        expect(() => wrong.observe(evolved)).toThrow(/evolution path/);
      }
      expect(forms.size).toBe(2);
    },
  );
  it.each([Nature.HARDY, Nature.LONELY])("matches the native Toxel nature branch (%i)", async nature => {
    game.override.startingLevel(30);
    await game.classicMode.startBattle(SpeciesId.TOXEL);
    const pokemon = game.scene.getPlayerParty()[0];
    pokemon.nature = nature;
    const before = party();
    const rule = pokemon.getEvolution()!;
    await pokemon.evolve(rule, pokemon.getSpeciesForm());
    const after = party();
    const audit = new PartyAudit({ seed: game.scene.seed });
    audit.start(before);
    expect(() => audit.observe(after)).not.toThrow();
    const denied = new PartyAudit({ seed: game.scene.seed });
    denied.start(before);
    after[0].formIndex = after[0].formIndex === 0 ? 1 : 0;
    expect(() => denied.observe(after)).toThrow(/evolution path/);
  });
  it.each(["DEEP_SEA_TOOTH", "DEEP_SEA_SCALE"])(
    "requires the actual held %s for a native Clamperl evolution",
    async key => {
      await game.classicMode.startBattle(SpeciesId.CLAMPERL);
      const pokemon = game.scene.getPlayerParty()[0];
      const before = party();
      expect(pokemon.getEvolution()).toBeNull();
      const inventory = new InventoryAudit();
      const modifier = generateModifierType(modifierTypes.SPECIES_STAT_BOOSTER, [key])!.newModifier(
        pokemon,
      ) as PersistentModifier;
      const data = new ModifierData(modifier, true);
      inventory.grant({ base: canonicalItem(data).base, count: 1, source: "SelectModifierPhase" });
      inventory.acquire(data, "SelectModifierPhase", new Set([pokemon.id]));
      game.scene.addModifier(modifier, true);
      inventory.observe(
        game.scene.getPlayerParty(),
        game.scene.modifiers.map(m => new ModifierData(m, true)),
      );
      const rule = registry
        .getEvolutions(SpeciesId.CLAMPERL)
        .find(rule => rule.validate(pokemon, false, EvolutionItem.LINKING_CORD))!;
      expect(rule).not.toBeNull();
      await pokemon.evolve(rule, pokemon.getSpeciesForm());
      const after = party();
      const audit = new PartyAudit({ inventory: id => inventory.provedItems(id), seed: game.scene.seed });
      audit.start(before);
      audit.grant("evolution", EvolutionItem.LINKING_CORD);
      expect(() => audit.observe(after)).not.toThrow();
      const denied = new PartyAudit({ seed: game.scene.seed });
      denied.start(before);
      denied.grant("evolution", EvolutionItem.LINKING_CORD);
      expect(() => denied.observe(after)).toThrow(/held evolution item/);
    },
  );
  it("does not allow two Dipplin to evolve using one Dragon Cheer TM", async () => {
    game.override.startingLevel(60);
    await game.classicMode.startBattle(SpeciesId.DIPPLIN, SpeciesId.DIPPLIN);
    const pokemon = game.scene.getPlayerParty()[0];
    const audit = new PartyAudit({ seed: game.scene.seed });
    audit.start(party());
    audit.grant("tm", MoveId.DRAGON_CHEER);
    const before = party();
    const forged = serialCopy(before);
    for (const data of forged) {
      data.species = SpeciesId.HYDRAPPLE;
    }
    expect(() => audit.observe(forged)).toThrow(/evolution path|learning source/);
    const allowed = new PartyAudit({ seed: game.scene.seed });
    allowed.start(before);
    allowed.grant("tm", MoveId.DRAGON_CHEER, new Set([pokemon.id]));
    forged[1] = before[1];
    expect(() => allowed.observe(forged)).not.toThrow();
  });
  it.each(["valid", "short", "unproved"])("checks native Gimmighoul treasure provenance (%s)", async mode => {
    await game.classicMode.startBattle(SpeciesId.GIMMIGHOUL);
    const pokemon = game.scene.getPlayerParty()[0];
    const before = party();
    const inventory = new InventoryAudit();
    const add = (id: string, count: number) => {
      const modifier = generateModifierType(modifierTypes[id])!.newModifier(pokemon, count) as PersistentModifier;
      const data = new ModifierData(modifier, true);
      inventory.grant({ base: canonicalItem(data).base, count: modifier.stackCount, source: "SelectModifierPhase" });
      inventory.acquire(data, "SelectModifierPhase", new Set([pokemon.id]));
      game.scene.addModifier(modifier, true);
      inventory.observe(
        game.scene.getPlayerParty(),
        game.scene.modifiers.map(m => new ModifierData(m, true)),
      );
    };
    add("EVOLUTION_TRACKER_GIMMIGHOUL", 9);
    expect(pokemon.getEvolution()).toBeNull();
    if (mode !== "short") {
      add("GOLDEN_PUNCH", 1);
    }
    const audit = new PartyAudit({
      seed: game.scene.seed,
      inventory: mode === "unproved" ? undefined : id => inventory.provedItems(id),
    });
    audit.start(before);
    if (mode === "valid") {
      const rule = pokemon.getEvolution()!;
      expect(rule).not.toBeNull();
      await pokemon.evolve(rule, pokemon.getSpeciesForm());
      // The native evolution consumes the tracker, so ownership earlier in the
      // wave must remain usable even after the current stock becomes smaller.
      inventory.observe(
        game.scene.getPlayerParty(),
        game.scene.modifiers.map(m => new ModifierData(m, true)),
      );
      expect(() => audit.observe(party())).not.toThrow();
    } else {
      const forged = party();
      forged[0].species = SpeciesId.GHOLDENGO;
      forged[0].formIndex = 0;
      expect(() => audit.observe(forged)).toThrow(/treasure evolution/);
    }
  });
  it("denies native Pancham evolution without a Dark-type party member", async () => {
    game.override.startingLevel(35);
    await game.classicMode.startBattle(SpeciesId.PANCHAM, SpeciesId.BULBASAUR);
    const panchamWithoutDark = game.scene.getPlayerParty()[0];
    expect(panchamWithoutDark.getEvolution()).toBeNull();
    const beforeWithoutDark = party();
    const denied = new PartyAudit({ seed: game.scene.seed });
    denied.start(beforeWithoutDark);
    const forged = serialCopy(beforeWithoutDark);
    forged[0].species = SpeciesId.PANGORO;
    forged[0].formIndex = 0;
    expect(() => denied.observe(forged)).toThrow(/evolution path/);
  });
  it("accepts native Pancham evolution with a Dark-type party member", async () => {
    game.override.startingLevel(35);
    await game.classicMode.startBattle(SpeciesId.PANCHAM, SpeciesId.POOCHYENA);
    const panchamWithDark = game.scene.getPlayerParty()[0];
    const rule = panchamWithDark.getEvolution()!;
    expect(rule).not.toBeNull();
    expect(rule.speciesId).toBe(SpeciesId.PANGORO);
    const beforeWithDark = party();
    await panchamWithDark.evolve(rule, panchamWithDark.getSpeciesForm());
    const afterWithDark = party();
    expect(afterWithDark[0].species).toBe(SpeciesId.PANGORO);
    const allowed = new PartyAudit({ seed: game.scene.seed });
    allowed.start(beforeWithDark);
    expect(() => allowed.observe(afterWithDark)).not.toThrow();
  });
  it.each([TimeOfDay.DAY, TimeOfDay.NIGHT])(
    "enforces native time-of-day Rockruff evolution branch (%s)",
    async timeOfDay => {
      game.override.startingLevel(25);
      await game.classicMode.startBattle(SpeciesId.ROCKRUFF);
      const rockruff = game.scene.getPlayerParty()[0];
      game.scene.arena.getTimeOfDay = () => timeOfDay;
      const before = party();
      const rule = rockruff.getEvolution()!;
      expect(rule).not.toBeNull();
      const expectedFormKey = timeOfDay === TimeOfDay.DAY ? "midday" : "midnight";
      expect(rule.evoFormKey).toBe(expectedFormKey);
      await rockruff.evolve(rule, rockruff.getSpeciesForm());
      const after = party();
      expect(after[0].species).toBe(SpeciesId.LYCANROC);
      const expectedFormIndex = registry
        .getSpecies(SpeciesId.LYCANROC)
        .forms.findIndex(f => f.formKey === expectedFormKey);
      expect(after[0].formIndex).toBe(expectedFormIndex);

      const allowed = new PartyAudit({ seed: game.scene.seed, time: timeOfDay });
      allowed.start(before);
      expect(() => allowed.observe(after)).not.toThrow();

      const oppositeTime = timeOfDay === TimeOfDay.DAY ? TimeOfDay.NIGHT : TimeOfDay.DAY;
      const denied = new PartyAudit({ seed: game.scene.seed, time: oppositeTime });
      denied.start(before);
      expect(() => denied.observe(after)).toThrow(/evolution path/);
    },
  );
  it.each([BiomeId.PLAINS, BiomeId.VOLCANO])(
    "enforces native biome-dependent Milcery Alcremie evolution branch (%s)",
    async biomeId => {
      await game.classicMode.startBattle(SpeciesId.MILCERY);
      const milcery = game.scene.getPlayerParty()[0];
      game.scene.newArena(biomeId);
      game.scene.arena.init();
      const before = party();
      const rule = registry
        .getEvolutions(SpeciesId.MILCERY)
        .find(r => r.validate(milcery, false, EvolutionItem.STRAWBERRY_SWEET))!;
      expect(rule).not.toBeNull();
      const expectedFormKey = biomeId === BiomeId.PLAINS ? "vanilla-cream" : "ruby-cream";
      expect(rule.evoFormKey).toBe(expectedFormKey);
      await milcery.evolve(rule, milcery.getSpeciesForm());
      const after = party();
      expect(after[0].species).toBe(SpeciesId.ALCREMIE);
      const expectedFormIndex = registry
        .getSpecies(SpeciesId.ALCREMIE)
        .forms.findIndex(f => f.formKey === expectedFormKey);
      expect(after[0].formIndex).toBe(expectedFormIndex);

      const allowed = new PartyAudit({ seed: game.scene.seed, biome: biomeId });
      allowed.start(before);
      allowed.grant("evolution", EvolutionItem.STRAWBERRY_SWEET);
      expect(() => allowed.observe(after)).not.toThrow();

      const oppositeBiome = biomeId === BiomeId.PLAINS ? BiomeId.VOLCANO : BiomeId.PLAINS;
      const denied = new PartyAudit({ seed: game.scene.seed, biome: oppositeBiome });
      denied.start(before);
      denied.grant("evolution", EvolutionItem.STRAWBERRY_SWEET);
      expect(() => denied.observe(after)).toThrow(/evolution path|form item/);
    },
  );
  it("enforces native Pichu friendship threshold", async () => {
    await game.classicMode.startBattle(SpeciesId.PICHU);
    const pichu = game.scene.getPlayerParty()[0];
    pichu.friendship = 20;
    expect(pichu.getEvolution()).toBeNull();
    const before = party();
    before[0].friendship = 20;
    const denied = new PartyAudit({ seed: game.scene.seed });
    denied.start(before);
    const forged = serialCopy(before);
    forged[0].species = SpeciesId.PIKACHU;
    forged[0].friendship = 20;
    expect(() => denied.observe(forged)).toThrow(/evolution path/);

    const allowed = new PartyAudit({ seed: game.scene.seed });
    allowed.start(before);
    // Earn the friendship through the native operation, within four observed
    // six-opponent wave budgets. Assigning 90 directly is not an earning proof.
    for (let wave = 0; wave < 4; wave++) {
      allowed.beginEncounter(-1, game.scene.getMaxExpLevel(), 6);
      for (let foe = 0; foe < 6; foe++) {
        pichu.addFriendship(3);
      }
      if (wave === 3) {
        const rule = pichu.getEvolution()!;
        expect(rule.speciesId).toBe(SpeciesId.PIKACHU);
        await pichu.evolve(rule, pichu.getSpeciesForm());
      }
      expect(() => allowed.observe(party())).not.toThrow();
      allowed.finishWave();
    }
    expect(party()[0].species).toBe(SpeciesId.PIKACHU);
  });
  it("resolves native Eevee branching evolution across friendship, time, and move type", async () => {
    await game.classicMode.startBattle(SpeciesId.EEVEE, SpeciesId.EEVEE);
    const eevee1 = game.scene.getPlayerParty()[0];
    const eevee2 = game.scene.getPlayerParty()[1];
    eevee1.friendship = 50;
    eevee2.friendship = 50;
    expect(eevee1.getEvolution()).toBeNull();
    expect(eevee2.getEvolution()).toBeNull();
    const beforeLow = party();
    beforeLow[0].friendship = 50;
    const deniedLow = new PartyAudit({ seed: game.scene.seed });
    deniedLow.start(beforeLow);
    const forgedEspeon = serialCopy(beforeLow);
    forgedEspeon[0].species = SpeciesId.ESPEON;
    forgedEspeon[0].friendship = 50;
    expect(() => deniedLow.observe(forgedEspeon)).toThrow(/evolution path/);

    eevee1.friendship = 120;
    game.scene.arena.getTimeOfDay = () => TimeOfDay.NIGHT;
    const beforeNight = party();
    const ruleNight = eevee1.getEvolution()!;
    expect(ruleNight.speciesId).toBe(SpeciesId.UMBREON);
    await eevee1.evolve(ruleNight, eevee1.getSpeciesForm());
    const afterUmbreon = party();
    expect(afterUmbreon[0].species).toBe(SpeciesId.UMBREON);

    const allowedNight = new PartyAudit({ seed: game.scene.seed, time: TimeOfDay.NIGHT });
    allowedNight.start(beforeNight);
    expect(() => allowedNight.observe(afterUmbreon)).not.toThrow();

    const deniedDay = new PartyAudit({ seed: game.scene.seed, time: TimeOfDay.DAY });
    deniedDay.start(beforeNight);
    expect(() => deniedDay.observe(afterUmbreon)).toThrow(/evolution path/);

    eevee2.friendship = 120;
    eevee2.moveset = [new PokemonMove(MoveId.BABY_DOLL_EYES)];
    game.scene.arena.getTimeOfDay = () => TimeOfDay.DAY;
    const beforeSylveon = party();
    const ruleSylveon = eevee2.getEvolution()!;
    expect(ruleSylveon.speciesId).toBe(SpeciesId.SYLVEON);
    await eevee2.evolve(ruleSylveon, eevee2.getSpeciesForm());
    const afterSylveon = party();
    expect(afterSylveon[1].species).toBe(SpeciesId.SYLVEON);

    const allowedSylveon = new PartyAudit({ seed: game.scene.seed, time: TimeOfDay.DAY });
    allowedSylveon.start(beforeSylveon);
    expect(() => allowedSylveon.observe(afterSylveon)).not.toThrow();

    const forgedDayEspeon = serialCopy(beforeSylveon);
    forgedDayEspeon[1].species = SpeciesId.ESPEON;
    forgedDayEspeon[1].friendship = 120;
    const deniedEspeonWithFairy = new PartyAudit({ seed: game.scene.seed, time: TimeOfDay.DAY });
    deniedEspeonWithFairy.start(beforeSylveon);
    expect(() => deniedEspeonWithFairy.observe(forgedDayEspeon)).toThrow(/evolution path/);
  });
});
