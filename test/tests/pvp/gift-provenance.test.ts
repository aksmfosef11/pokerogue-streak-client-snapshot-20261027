// SPDX-License-Identifier: AGPL-3.0-only
import { loggedInUser } from "#app/account";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { speciesEggMoves } from "#balance/egg-moves";
import { modifierTypes } from "#data/data-lists";
import { BattleType } from "#enums/battle-type";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import type { EnemyPokemon } from "#field/pokemon";
import { PokemonMove } from "#moves/pokemon-move";
import { DancingLessonsEncounter } from "#mystery-encounters/dancing-lessons-encounter";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { GlobalTradeSystemEncounter } from "#mystery-encounters/global-trade-system-encounter";
import { ThePokemonSalesmanEncounter } from "#mystery-encounters/the-pokemon-salesman-encounter";
import { UncommonBreedEncounter } from "#mystery-encounters/uncommon-breed-encounter";
import { MysteryEncounterOptionSelectedPhase } from "#phases/mystery-encounter-phases";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { initSceneWithoutEncounterPhase } from "#test/utils/game-manager-utils";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { generationResult, serialCopy } from "../../../src/pvp/generation";
import type { ItemRecord } from "../../../src/pvp/inventory-ledger";
import { installGenerationCapture, recordWave } from "../../../src/pvp/log";
// biome-ignore lint/performance/noNamespaceImport: Spy on the same feature gate as the live logger.
import * as pvpState from "../../../src/pvp/state";

describe("Seed-reproduced mystery encounter gift provenance", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(() => {
    game = new GameManager(phaser);
    initSceneWithoutEncounterPhase(game.scene, [SpeciesId.BULBASAUR]);
    game.scene.currentBattle.waveIndex = 45;
  });
  function prepare(encounter: typeof ThePokemonSalesmanEncounter) {
    const audit = new PartyAudit();
    audit.start(game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p))));
    game.scene.currentBattle.mysteryEncounter = encounter;
    expect(encounter.onInit!()).toBe(true);
    audit.beginEncounter(encounter.encounterType);
    const proof = generationResult(game.scene).giftParty;
    expect(proof).toHaveLength(1);
    const source =
      encounter.encounterType === ME.DANCING_LESSONS ? encounter.misc.oricorioData : encounter.misc.pokemon;
    const data = new PokemonData(source);
    data.player = false;
    return { audit, proof: proof[0], enemy: data.toPokemon() as EnemyPokemon };
  }
  it.each([
    ["salesman", ThePokemonSalesmanEncounter],
    ["dance", DancingLessonsEncounter],
    ["uncommon", UncommonBreedEncounter],
  ] as const)("accepts a real generated gift and native addToParty (%s)", (_name, encounter) => {
    const { audit, proof, enemy } = prepare(encounter);
    const caught = enemy.addToParty(PokeballType.POKEBALL)!;
    expect(caught).not.toBeNull();
    const data = serialCopy(new PokemonData(caught));
    audit.capture(data, proof, "MysteryEncounterOptionSelectedPhase", true);
    expect(() => audit.observe(game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p))))).not.toThrow();
    expect(() => audit.capture(data, proof, "MysteryEncounterOptionSelectedPhase", true)).toThrow(
      /too many direct gifts/,
    );
  });
  it("rejects a forged gift species despite a genuine generated offer", () => {
    const { audit, proof, enemy } = prepare(ThePokemonSalesmanEncounter);
    const data = serialCopy(new PokemonData(enemy));
    data.species = SpeciesId.MEWTWO;
    expect(() => audit.capture(data, proof, "MysteryEncounterOptionSelectedPhase", true)).toThrow(/capture source/);
  });
  it("allows only one source-valid extra egg move on an Uncommon Breed gift", () => {
    const { audit, proof, enemy } = prepare(UncommonBreedEncounter);
    const eggs = speciesEggMoves[enemy.getSpeciesForm().getRootSpeciesId()] ?? [];
    const extra = eggs.find(move => !proof.moves.includes(move));
    expect(extra).toBeDefined();
    enemy.moveset[Math.min(2, enemy.moveset.length)] = new PokemonMove(extra!);
    const caught = enemy.addToParty(PokeballType.POKEBALL)!;
    expect(() =>
      audit.capture(serialCopy(new PokemonData(caught)), proof, "MysteryEncounterOptionSelectedPhase", true),
    ).not.toThrow();
  });
  it("rejects an invented move on a Salesman gift", () => {
    const { audit, proof, enemy } = prepare(ThePokemonSalesmanEncounter);
    const data = serialCopy(new PokemonData(enemy));
    data.moveset = [new PokemonMove(MoveId.SPORE)];
    expect(() => audit.capture(data, proof, "MysteryEncounterOptionSelectedPhase", true)).toThrow(/captured moves/);
  });
  it("records an actual party insertion but excludes a native summary preview", async () => {
    vi.spyOn(pvpState, "pvpEnabled", "get").mockReturnValue(true);
    const scene = game.scene;
    const key = `pvp:run:${loggedInUser?.username}:gift-logger`;
    localStorage.setItem(key, JSON.stringify({ id: "gift-logger", seed: scene.seed, logs: [], anchored: 0 }));
    // The upstream storage mock implements get/set but does not enumerate its
    // stored keys as native Storage does. Expose this one key for run discovery.
    Object.defineProperty(localStorage, key, { value: true, enumerable: true, configurable: true });
    scene.currentBattle.battleType = BattleType.MYSTERY_ENCOUNTER;
    const session = scene.gameData.getSessionSaveData();
    expect(session.gameMode).toBe(0);
    await recordWave(session, false);
    installGenerationCapture();
    scene.currentBattle.mysteryEncounter = ThePokemonSalesmanEncounter;
    ThePokemonSalesmanEncounter.selectedOption = ThePokemonSalesmanEncounter.options[0];
    vi.spyOn(scene.phaseManager, "getCurrentPhase").mockReturnValue(new MysteryEncounterOptionSelectedPhase());
    const preview = scene.addPlayerPokemon(speciesDataRegistry.getSpecies(SpeciesId.PIKACHU), 5);
    const acquired = scene.addPlayerPokemon(speciesDataRegistry.getSpecies(SpeciesId.CHARMANDER), 5);
    scene.getPlayerParty().push(acquired);
    await Promise.resolve();
    const captures = JSON.parse(localStorage.getItem(key)!).frame.captures as {
      pokemon: PokemonData;
      source: string;
    }[];
    expect(captures.map(c => c.pokemon.id)).toEqual([acquired.id]);
    expect(captures[0].source).toBe("MysteryEncounterOptionSelectedPhase");
    expect(captures.some(c => c.pokemon.id === preview.id)).toBe(false);
    scene.currentBattle.mysteryEncounter = GlobalTradeSystemEncounter;
    const oldMisc = GlobalTradeSystemEncounter.misc;
    const outgoing = scene.getPlayerParty()[0];
    GlobalTradeSystemEncounter.misc = { tradedPokemon: outgoing };
    const traded = scene.addPlayerPokemon(speciesDataRegistry.getSpecies(SpeciesId.ABRA), 5);
    scene.getPlayerParty().push(traded);
    await Promise.resolve();
    expect(JSON.parse(localStorage.getItem(key)!).frame.captures.at(-1)).toMatchObject({
      pokemon: { id: traded.id },
      outgoing: outgoing.id,
      source: "MysteryEncounterOptionSelectedPhase",
    });
    GlobalTradeSystemEncounter.misc = oldMisc;
    const charm = generateModifierType(modifierTypes.SHINY_CHARM)!.newModifier()!;
    Reflect.set(charm, "stackCount", Reflect.get(charm, "getMaxStackCount").call(charm));
    scene.addModifier(charm, true);
    scene.addModifier(generateModifierType(modifierTypes.SHINY_CHARM)!.newModifier(), true);
    const events = JSON.parse(localStorage.getItem(key)!).frame.items as ItemRecord[];
    expect(events.map(event => event.kind)).toEqual(["acquire", "state", "acquire", "state"]);
    const states = events.filter((event): event is Extract<ItemRecord, { kind: "state" }> => event.kind === "state");
    expect(states[0].changes[0].delta).toBe(4);
    // Full-stack fallback creates no extra charm, but still flushes a zero-delta
    // checkpoint so the auditor can discard the unsuccessful acquisition credit.
    expect(states[1].changes).toEqual([]);
    scene.addModifier(generateModifierType(modifierTypes.SHINY_CHARM)!.newModifier(), true, false, true);
    expect(JSON.parse(localStorage.getItem(key)!).frame.items).toHaveLength(events.length);
    const before = localStorage.getItem(key);
    scene.setSeed("other-unranked-run");
    scene.addModifier(generateModifierType(modifierTypes.MAP)!.newModifier(), true);
    expect(localStorage.getItem(key)).toBe(before);
    localStorage.removeItem(key);
    Reflect.deleteProperty(localStorage, key);
  });
});
