// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry as registry } from "#app/global-species-data-registry";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { TimeOfDay } from "#enums/time-of-day";
import { PokemonMove } from "#moves/pokemon-move";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { serialCopy } from "../../../src/pvp/generation";

describe("Evolution prerequisite regressions", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(() => {
    game = new GameManager(phaser);
  });
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));

  it("accepts native Espeon when the Eevee actually knows no Fairy move", async () => {
    game.override.startingLevel(50);
    await game.classicMode.startBattle(SpeciesId.EEVEE);
    const eevee = game.scene.getPlayerParty()[0];
    eevee.friendship = 120;
    eevee.moveset = [new PokemonMove(MoveId.TACKLE)];
    game.scene.arena.getTimeOfDay = () => TimeOfDay.DAY;
    const rule = eevee.getEvolution()!;
    expect(rule.speciesId).toBe(SpeciesId.ESPEON);
    const before = party();
    await eevee.evolve(rule, eevee.getSpeciesForm());
    const audit = new PartyAudit({ seed: game.scene.seed, time: TimeOfDay.DAY });
    audit.start(before);
    expect(() => audit.observe(party())).not.toThrow();
  });

  it("rejects the wrong Rockruff time branch in the worker observation sequence", async () => {
    game.override.startingLevel(25);
    await game.classicMode.startBattle(SpeciesId.ROCKRUFF);
    const rockruff = game.scene.getPlayerParty()[0];
    game.scene.arena.getTimeOfDay = () => TimeOfDay.DAY;
    const before = party();
    const rule = rockruff.getEvolution()!;
    expect(rule.evoFormKey).toBe("midday");
    await rockruff.evolve(rule, rockruff.getSpeciesForm());
    const after = party();
    expect(after[0].formIndex).toBe(
      registry.getSpecies(SpeciesId.LYCANROC).forms.findIndex(f => f.formKey === "midday"),
    );
    const control = new PartyAudit({ seed: game.scene.seed, time: TimeOfDay.NIGHT });
    control.start(before);
    expect(() => control.observe(after)).toThrow(/evolution path/);
    const worker = new PartyAudit({ seed: game.scene.seed });
    worker.start(before);
    worker.setEnvironment({ time: TimeOfDay.NIGHT });
    worker.observe(before);
    worker.setEnvironment(undefined);
    // audit-job observes shop/next-wave parties after this environment reset.
    expect(() => worker.observe(after)).toThrow(/evolution path/);
  });

  it("rejects two Pancham evolving through a circular claimed Dark-type companion", async () => {
    game.override.startingLevel(35);
    await game.classicMode.startBattle(SpeciesId.PANCHAM, SpeciesId.PANCHAM);
    expect(game.scene.getPlayerParty().every(p => p.getEvolution() === null)).toBe(true);
    const before = party();
    const forged = serialCopy(before);
    for (const p of forged) {
      p.species = SpeciesId.PANGORO;
      p.formIndex = 0;
    }
    const audit = new PartyAudit({ seed: game.scene.seed });
    audit.start(before);
    expect(() => audit.observe(forged)).toThrow(/evolution path/);
  });

  it("does not certify a friendship evolution solely by raising the submitted friendship field", async () => {
    await game.classicMode.startBattle(SpeciesId.PICHU);
    const pichu = game.scene.getPlayerParty()[0];
    pichu.friendship = 20;
    expect(pichu.getEvolution()).toBeNull();
    const before = party();
    const forged = serialCopy(before);
    forged[0].species = SpeciesId.PIKACHU;
    forged[0].formIndex = 0;
    forged[0].friendship = 255;
    const audit = new PartyAudit({ seed: game.scene.seed });
    audit.start(before);
    expect(() => audit.observe(forged)).toThrow();
  });

  it("resolves a real companion evolution before the dependent party slot", async () => {
    game.override.startingLevel(35);
    await game.classicMode.startBattle(SpeciesId.PANCHAM, SpeciesId.EEVEE);
    const [pancham, eevee] = game.scene.getPlayerParty();
    eevee.friendship = 120;
    eevee.moveset = [new PokemonMove(MoveId.TACKLE)];
    game.scene.arena.getTimeOfDay = () => TimeOfDay.NIGHT;
    const before = party();
    expect(pancham.getEvolution()).toBeNull();
    const companion = eevee.getEvolution()!;
    expect(companion.speciesId).toBe(SpeciesId.UMBREON);
    await eevee.evolve(companion, eevee.getSpeciesForm());
    const dependent = pancham.getEvolution()!;
    expect(dependent.speciesId).toBe(SpeciesId.PANGORO);
    await pancham.evolve(dependent, pancham.getSpeciesForm());
    const audit = new PartyAudit({ seed: game.scene.seed, time: TimeOfDay.NIGHT });
    audit.start(before);
    expect(() => audit.observe(party())).not.toThrow();
  });

  it("checks an evolution before a next-wave time boundary in the prior wave environment", async () => {
    game.override.startingLevel(50);
    await game.classicMode.startBattle(SpeciesId.EEVEE);
    const eevee = game.scene.getPlayerParty()[0];
    eevee.friendship = 120;
    eevee.moveset = [new PokemonMove(MoveId.TACKLE)];
    game.scene.arena.getTimeOfDay = () => TimeOfDay.DAY;
    const before = party();
    await eevee.evolve(eevee.getEvolution()!, eevee.getSpeciesForm());
    const after = party();
    const audit = new PartyAudit({ seed: game.scene.seed });
    audit.start(before);
    audit.setEnvironment({ time: TimeOfDay.DAY });
    expect(() => audit.observe(after)).not.toThrow();
    audit.setEnvironment({ time: TimeOfDay.NIGHT });
    expect(() => audit.observe(after)).not.toThrow();
  });

  it("can use an independently proved native type shuffle before the dependent evolution", async () => {
    game.override.startingLevel(35);
    await game.classicMode.startBattle(SpeciesId.PANCHAM, SpeciesId.BULBASAUR);
    const before = party();
    for (const pokemon of game.scene.getPlayerParty()) {
      pokemon.customPokemonData.types = [PokemonType.DARK];
    }
    const transformed = party();
    const pancham = game.scene.getPlayerParty()[0];
    const rule = pancham.getEvolution()!;
    expect(rule.speciesId).toBe(SpeciesId.PANGORO);
    await pancham.evolve(rule, pancham.getSpeciesForm());
    const audit = new PartyAudit({ seed: game.scene.seed, deferResources: true, claimEncounter: () => true });
    audit.start(before);
    audit.beginEncounter(ME.CLOWNING_AROUND);
    audit.clownSelection(2, transformed);
    expect(() => audit.observe(party())).not.toThrow();
    expect(() => audit.finishWave()).not.toThrow();
  });
});
