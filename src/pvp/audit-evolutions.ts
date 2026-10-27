// SPDX-License-Identifier: AGPL-3.0-only
import { EvoCondKey, type EvolutionConditionData, type SpeciesFormEvolution } from "#balance/pokemon-evolutions";
import { allMoves } from "#data/data-lists";
import type { BiomeId } from "#enums/biome-id";
import type { MoveId } from "#enums/move-id";
import type { PokemonType } from "#enums/pokemon-type";
import type { TimeOfDay } from "#enums/time-of-day";
import { randSeedInt, shiftCharCodes } from "#utils/common";

export interface EvolutionFacts {
  id: number;
  seed?: string | undefined;
  level: number;
  gender: number | undefined;
  natures: Set<number>;
  moves: Set<MoveId>;
  observedMoveSets?: readonly Set<MoveId>[] | undefined;
  partyTypes?: Set<PokemonType> | undefined;
  time?: TimeOfDay | undefined;
  biome?: BiomeId | undefined;
  friendship?: number | undefined;
}
function randomForm(seed: string, id: number, range: number): boolean {
  const rng = Phaser.Math.RND.state();
  try {
    Phaser.Math.RND.sow([shiftCharCodes(seed, id)]);
    return !randSeedInt(range);
  } finally {
    Phaser.Math.RND.state(rng);
  }
}
function possible(condition: EvolutionConditionData, facts: EvolutionFacts, nature: number): boolean {
  switch (condition.key) {
    case EvoCondKey.RANDOM_FORM:
      return !!facts.seed && randomForm(facts.seed, facts.id, condition.value);
    case EvoCondKey.NATURE:
      return condition.nature.includes(nature);
    case EvoCondKey.GENDER:
      return condition.gender === facts.gender;
    case EvoCondKey.MOVE:
    case EvoCondKey.TYROGUE:
      return facts.moves.has(condition.move);
    case EvoCondKey.MOVE_TYPE:
      return [...facts.moves].some(move => allMoves[move]?.type === condition.pkmnType);
    case EvoCondKey.PARTY_TYPE:
      return facts.partyTypes ? facts.partyTypes.has(condition.pkmnType) : true;
    case EvoCondKey.TIME:
      return facts.time !== undefined && condition.time.includes(facts.time);
    case EvoCondKey.BIOME:
      return facts.biome !== undefined && condition.biome.includes(facts.biome);
    case EvoCondKey.FRIENDSHIP:
      return facts.friendship === undefined ? true : facts.friendship >= condition.value;
    case EvoCondKey.SHEDINJA:
      return false;
    default:
      return true; // World/battle context is separate from these deterministic branch checks.
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** getEvolution selects the first valid rule. A common unconditional fallback
 * is not an alternative lottery roll when the ID's rare branch already wins.
 * Conditions shared with the target (e.g. Hyper Drill) must also hold there. */
export function possibleEvolution(
  rule: SpeciesFormEvolution,
  siblings: SpeciesFormEvolution[],
  facts: EvolutionFacts,
): boolean {
  const index = siblings.indexOf(rule);
  const conditions = rule.condition?.data ?? [];
  if (
    !facts.seed
    && siblings.some(
      e => e.preFormKey === rule.preFormKey && e.condition?.data.some(c => c.key === EvoCondKey.RANDOM_FORM),
    )
  ) {
    return false;
  }
  return [...facts.natures].some(nature => {
    if (!conditions.every(c => possible(c, facts, nature))) {
      return false;
    }
    // A learnable move can establish a possible target prerequisite, but cannot
    // force a higher-priority branch. The player may have declined that move.
    return (facts.observedMoveSets ?? [facts.moves]).some(
      held =>
        !siblings.slice(0, index).some(prior => {
          const observed = { ...facts, moves: held };
          if (prior.preFormKey !== rule.preFormKey || prior.item !== rule.item || prior.level > facts.level) {
            return false;
          }
          const data = prior.condition?.data ?? [];
          if (
            !data.some(
              c =>
                c.key === EvoCondKey.RANDOM_FORM
                || c.key === EvoCondKey.NATURE
                || (c.key === EvoCondKey.TIME && facts.time !== undefined)
                || (c.key === EvoCondKey.BIOME && facts.biome !== undefined)
                || (c.key === EvoCondKey.MOVE_TYPE && facts.moves.size > 0),
            )
          ) {
            return false;
          }
          return data.every(c => {
            if (
              c.key === EvoCondKey.RANDOM_FORM
              || c.key === EvoCondKey.NATURE
              || c.key === EvoCondKey.GENDER
              || c.key === EvoCondKey.TIME
              || c.key === EvoCondKey.BIOME
              || c.key === EvoCondKey.MOVE_TYPE
              || c.key === EvoCondKey.FRIENDSHIP
            ) {
              return possible(c, observed, nature);
            }
            return conditions.some(required => same(required, c));
          });
        }),
    );
  });
}
