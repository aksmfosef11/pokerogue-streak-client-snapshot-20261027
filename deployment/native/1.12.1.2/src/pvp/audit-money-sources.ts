// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import { speciesDataRegistry as registry } from "#app/global-species-data-registry";
import { allMoves, modifierTypes } from "#data/data-lists";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { MoneyRewardModifier, PersistentModifier } from "#modifiers/modifier";
import { PokemonData } from "#system/pokemon-data";
import type { MoneySource } from "./audit-money";
import type { InventoryData } from "./inventory-ledger";
import type { ShopOffer } from "./shop";

const battleEncounters = new Set<number>([
  ME.BUG_TYPE_SUPERFAN,
  ME.BERRIES_ABOUND,
  ME.A_TRAINERS_TEST,
  ME.ABSOLUTE_AVARICE,
  ME.FIGHT_OR_FLIGHT,
  ME.FIERY_FALLOUT,
  ME.MYSTERIOUS_CHALLENGERS,
  ME.DANCING_LESSONS,
  ME.DARK_DEAL,
  ME.CLOWNING_AROUND,
  ME.MYSTERIOUS_CHEST,
  ME.THE_EXPERT_POKEMON_BREEDER,
  ME.WEIRD_DREAM,
  ME.TELEPORTING_HIJINKS,
  ME.TRAINING_SESSION,
  ME.THE_WINSTRATE_CHALLENGE,
  ME.SLUMBERING_SNORLAX,
  ME.THE_STRONG_STUFF,
  ME.TRASH_TO_TREASURE,
  ME.UNCOMMON_BREED,
]);
export function moneyStacks(items: readonly InventoryData[], id: string): number {
  return items.filter(item => item.typeId === id).reduce((sum, item) => sum + item.stackCount, 0);
}
/** Native MoneyMultiplierModifier rounding. Its actual stock is verified by
 * InventoryAudit, including the native total cap of five Amulet Coins. */
export function multipliedMoney(base: number, items: readonly InventoryData[]): number {
  return Math.min(Number.MAX_SAFE_INTEGER, base + Math.floor(base * 0.2 * moneyStacks(items, "AMULET_COIN")));
}
function moneyMove(id: number): boolean {
  // Metronome can call MoneyAttr even if neither saved moveset has Pay Day.
  return id === MoveId.METRONOME || !!allMoves[id]?.hasAttr("MoneyAttr");
}
function canLearnMoney(p: PokemonData, cap: number): boolean {
  return (
    p.moveset.some(m => moneyMove(m.moveId))
    || [
      ...registry.getLevelMoves(p.species, p.formIndex),
      ...(p.fusionSpecies ? registry.getLevelMoves(p.fusionSpecies, p.fusionFormIndex) : []),
    ].some(([level, move]) => level <= Math.max(p.level, cap) && moneyMove(move))
  );
}
/** Derive while the reproduced encounter is loaded, before any client shop is
 * loaded. Campaign combat is not replayed: repeatable money moves/Golden Punch
 * open a native wallet bound rather than a fabricated per-wave turn limit. */
export function encounterMoneySource(scene: BattleScene, captured: PokemonData[] = [], noCombat = false): MoneySource {
  const encounter = scene.currentBattle.mysteryEncounter;
  const type = encounter?.encounterType ?? -1;
  const configs = encounter?.enemyPartyConfigs ?? [];
  const party = scene.gameData.getSessionSaveData().party;
  const items = scene.gameData.getSessionSaveData().modifiers;
  const combat = !noCombat && (type < 0 || battleEncounters.has(type));
  let income = 0;
  if (combat) {
    const trainers = encounter
      ? configs.flatMap(config => (config.trainerConfig ? [config.trainerConfig] : []))
      : scene.currentBattle.trainer
        ? [scene.currentBattle.trainer.config]
        : [];
    // Happy Hour doubles a trainer payout; using that ceiling avoids replaying
    // every possible called move in campaign combat.
    for (const trainer of trainers) {
      income += multipliedMoney(scene.getWaveMoneyAmount(trainer.moneyMultiplier), items) * 2;
    }
  }
  if (type === ME.PART_TIMER) {
    income += multipliedMoney(scene.getWaveMoneyAmount(4), items);
  }
  if (type === ME.AN_OFFER_YOU_CANT_REFUSE) {
    income += encounter!.misc.price;
  }
  const cap = scene.getMaxExpLevel();
  let repeated = [...party, ...captured].some(p => canLearnMoney(p, cap));
  repeated ||= scene.getEnemyParty().some(p => p.moveset.some(m => moneyMove(m.moveId)));
  repeated ||= items.some(item => item.typeId === "GOLDEN_PUNCH" && item.stackCount > 0);
  repeated ||= scene.gameData
    .getSessionSaveData()
    .enemyModifiers.some(item => item.typeId === "GOLDEN_PUNCH" && item.stackCount > 0);
  for (const config of configs) {
    // Some ME trainers generate their full party only when battle is selected.
    // Their loot/money-move source remains a conservative combat bound.
    if (!config.pokemonConfigs) {
      repeated = true;
    }
    for (const pokemon of config.pokemonConfigs ?? []) {
      const possible =
        pokemon.moveSet
        ?? registry
          .getLevelMoves(pokemon.species.speciesId, pokemon.formIndex ?? 0)
          .filter(([level]) => level <= cap)
          .map(([, move]) => move);
      repeated ||= possible.some(moneyMove);
      repeated ||=
        pokemon.modifierConfigs?.some(
          receipt =>
            (receipt.modifier instanceof PersistentModifier ? receipt.modifier.type.id : receipt.modifier.id)
            === "GOLDEN_PUNCH",
        ) ?? false;
    }
  }
  // Weird Dream creates its alternative opponents from these native templates
  // only after selecting the nightmare battle.
  if (type === ME.WEIRD_DREAM) {
    repeated ||= (encounter!.misc.teamTransformations ?? []).some(t =>
      canLearnMoney(new PokemonData(t.newPokemon), cap),
    );
  }
  return { income: Math.min(Number.MAX_SAFE_INTEGER, income), repeatedCombatIncome: combat && repeated };
}
export function selectedMoneyReward(scene: BattleScene, offer: ShopOffer, cursor: number): number {
  const option = offer.options[cursor];
  if (!option || !["NUGGET", "BIG_NUGGET", "RELIC_GOLD"].includes(option.id)) {
    return 0;
  }
  const factory = modifierTypes[option.id];
  const modifier = factory().withIdFromFunc(factory).newModifier();
  if (!(modifier instanceof MoneyRewardModifier)) {
    return 0;
  }
  return multipliedMoney(scene.getWaveMoneyAmount(Reflect.get(modifier, "moneyMultiplier")), offer.session.modifiers);
}
