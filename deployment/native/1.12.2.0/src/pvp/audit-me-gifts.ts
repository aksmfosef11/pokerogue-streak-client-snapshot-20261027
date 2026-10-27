// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { TrainerSlot } from "#enums/trainer-slot";
import { EnemyPokemon } from "#field/pokemon";
import { PokemonMove } from "#moves/pokemon-move";
import { getHighestLevelPlayerPokemon } from "#mystery-encounters/encounter-pokemon-utils";
import { PokemonData } from "#system/pokemon-data";
import { AuditInputError } from "./audit-errors";
import { generatedPokemon, serialCopy } from "./generation";

/** Native option 3 constructs its Greedent before the first await inside
 * MysteryEncounterOptionSelectedPhase's seeded callback. No submitted RNG
 * state or submitted gift attributes are needed to reproduce that individual. */
export function replayAvariceGift(scene: BattleScene): ReturnType<typeof generatedPokemon> | undefined {
  const encounter = scene.currentBattle.mysteryEncounter;
  if (encounter?.encounterType !== ME.ABSOLUTE_AVARICE) {
    return undefined;
  }
  const originalOffset = encounter.getSeedOffset();
  let pokemon: EnemyPokemon | undefined;
  try {
    // The first option menu performs exactly this native offset update.
    encounter.updateSeedOffset();
    scene.executeWithSeedOffset(() => {
      pokemon = new EnemyPokemon(
        speciesDataRegistry.getSpecies(SpeciesId.GREEDENT),
        getHighestLevelPlayerPokemon(false, true).level - 2,
        TrainerSlot.NONE,
        false,
        true,
      );
      pokemon.moveset = [MoveId.THRASH, MoveId.BODY_PRESS, MoveId.STUFF_CHEEKS, MoveId.SLACK_OFF].map(
        move => new PokemonMove(move),
      );
      pokemon.passive = true;
    }, encounter.getSeedOffset() * 500);
    return serialCopy(generatedPokemon(new PokemonData(pokemon!)));
  } finally {
    Reflect.set(encounter, "seedOffset", originalOffset);
    pokemon?.destroy();
  }
}

/** Normal GTS offers are constructed by the original onInit callback. Pair
 * every offered ID with the actual outgoing owner; the accepted gift copies
 * that owner's passive and consumes that exact individual. */
export function replayGtsTradeGifts(scene: BattleScene) {
  const encounter = scene.currentBattle.mysteryEncounter;
  if (encounter?.encounterType !== ME.GLOBAL_TRADE_SYSTEM) {
    return [];
  }
  const choices = encounter.misc.tradeOptionsMap as Map<number, EnemyPokemon[]>;
  return scene.getPlayerParty().flatMap(owner =>
    (choices.get(owner.id) ?? []).map(pokemon => ({
      outgoing: owner.id,
      pokemon: { ...generatedPokemon(new PokemonData(pokemon)), passive: owner.passive },
    })),
  );
}

/** Wonder Trade can generate the same individual for two equal-level owners.
 * Bind it to the recorded outgoing ID instead of retiring the first match. */
export function findTradeGift(
  gifts: readonly ReturnType<typeof replayGtsTradeGifts>[number][],
  pokemon: Pick<PokemonData, "id" | "species">,
  outgoing?: number,
) {
  if (outgoing !== undefined && (!Number.isSafeInteger(outgoing) || outgoing < 0 || outgoing > 0xffffffff)) {
    throw new AuditInputError("trade gift has an invalid outgoing individual");
  }
  const matches = gifts.filter(
    gift =>
      gift.pokemon.id === pokemon.id
      && gift.pokemon.species === pokemon.species
      && (outgoing === undefined || outgoing === gift.outgoing),
  );
  if (matches.length > 1) {
    throw new AuditInputError("ambiguous outgoing trade individual");
  }
  if (outgoing !== undefined && !matches[0]) {
    throw new AuditInputError("trade gift has no reproduced outgoing individual");
  }
  return matches[0];
}
