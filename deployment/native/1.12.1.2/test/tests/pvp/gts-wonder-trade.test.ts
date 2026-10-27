// SPDX-License-Identifier: AGPL-3.0-only
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterTier } from "#enums/mystery-encounter-tier";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
// biome-ignore lint/performance/noNamespaceImport: Select the original GTS without replacing its generation or option callbacks.
import * as mysteryBiomes from "#mystery-encounters/mystery-encounter-biomes";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replayGtsWonderTradeGifts } from "../../../scripts/pvp/audit-me-selections";
import { findTradeGift } from "../../../src/pvp/audit-me-gifts";
import { PartyAudit } from "../../../src/pvp/audit-party";
import { generatedPokemon, serialCopy } from "../../../src/pvp/generation";

describe("Native GTS Wonder Trade replay", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  const party = () => game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p)));
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    game.override.normalizeNatures = false;
    game.override.normalizeIVs = false;
    game.override.disableShinies = false;
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
  });
  it.each([1, 2, 3])("reproduces the real UI trade of party slot %i and retires that owner", async slot => {
    game.scene.getPlayerParty()[slot - 1].passive = true;
    const before = party();
    const rng = Phaser.Math.RND.state();
    const proofs = await replayGtsWonderTradeGifts(game.scene);
    expect(Phaser.Math.RND.state()).toBe(rng);
    const expected = proofs.find(gift => gift.outgoing === before[slot - 1].id)!;
    await runMysteryEncounterToEnd(game, 2, { pokemonNo: slot });
    const caught = party().at(-1)!;
    expect(generatedPokemon(caught)).toMatchObject(expected.pokemon);
    expect(findTradeGift(proofs, caught, before[slot - 1].id)).toBe(expected);
    const audit = new PartyAudit();
    audit.start(before);
    audit.beginEncounter(ME.GLOBAL_TRADE_SYSTEM, game.scene.getMaxExpLevel());
    audit.capture(caught, expected.pokemon, "MysteryEncounterOptionSelectedPhase", true, expected.outgoing);
    audit.observe(party());
    expect(() => audit.finishWave()).not.toThrow();
  });
  it("derives generation from the server wave seed and restores the caller's RNG and ME state", async () => {
    const encounter = game.scene.currentBattle.mysteryEncounter!;
    const misc = { ...encounter.misc };
    const tokens = { ...encounter.dialogueTokens };
    const first = await replayGtsWonderTradeGifts(game.scene);
    Phaser.Math.RND.sow(["untrusted-later-ui-state"]);
    const changed = Phaser.Math.RND.state();
    expect(await replayGtsWonderTradeGifts(game.scene)).toEqual(first);
    expect(Phaser.Math.RND.state()).toBe(changed);
    expect(encounter.misc).toEqual(misc);
    expect(encounter.dialogueTokens).toEqual(tokens);
  });
  it("requires the outgoing owner when equal-level party members produce the same offered ID", async () => {
    const proofs = await replayGtsWonderTradeGifts(game.scene);
    expect(proofs[0].pokemon.id).toBe(proofs[1].pokemon.id);
    expect(() => findTradeGift(proofs, proofs[0].pokemon)).toThrow(/ambiguous outgoing/);
    expect(() => findTradeGift(proofs, proofs[0].pokemon, 0x100000000)).toThrow(/invalid outgoing/);
    expect(() => findTradeGift(proofs, proofs[0].pokemon, -1)).toThrow(/invalid outgoing/);
    expect(() => findTradeGift(proofs, proofs[0].pokemon, 123)).toThrow(/no reproduced outgoing/);
  });
  it("reproduces the native common egg move bonus and rejects an invented move", async () => {
    // Native Wonder Trade can legitimately return shiny/hidden-ability Pokemon,
    // which do not receive this bonus. Select this branch with a fixed wave seed.
    game.scene.setSeed("pvp-gts-common-egg-v1");
    game.scene.resetSeed();
    const before = party();
    const proof = (await replayGtsWonderTradeGifts(game.scene))[0];
    expect(proof.pokemon.shiny).toBe(false);
    expect(proof.pokemon.abilityIndex).toBeLessThan(2);
    await runMysteryEncounterToEnd(game, 2, { pokemonNo: 1 });
    const received = game.scene.getPlayerParty().at(-1)!;
    expect(received.shiny).toBe(false);
    expect(received.abilityIndex).toBeLessThan(2);
    expect(
      received
        .getEggMoves()
        ?.slice(0, 3)
        .some(move => proof.pokemon.moves.includes(move)),
    ).toBe(true);
    const caught = party().at(-1)!;
    caught.moveset[0].moveId = MoveId.SPORE;
    const audit = new PartyAudit();
    audit.start(before);
    audit.beginEncounter(ME.GLOBAL_TRADE_SYSTEM, game.scene.getMaxExpLevel());
    expect(() =>
      audit.capture(caught, proof.pokemon, "MysteryEncounterOptionSelectedPhase", true, proof.outgoing),
    ).toThrow(/captured moves/);
  });
});
