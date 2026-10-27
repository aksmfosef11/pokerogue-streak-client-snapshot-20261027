// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import { timedEventManager } from "#app/global-event-manager";
import { modifierTypes } from "#data/data-lists";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import { ModifierTier } from "#enums/modifier-tier";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import type { Pokemon } from "#field/pokemon";
import { BerryModifier, MoneyRewardModifier, PersistentModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import type { ModifierType } from "#modifiers/modifier-type";
import { ModifierData } from "#system/modifier-data";
import type { PokemonData } from "#system/pokemon-data";
import { canonicalItem, type InventoryGrant, type InventoryItem, rewardInventoryItem } from "./audit-inventory";
import type { InventoryData } from "./inventory-ledger";
import { optionData, rewardChoice, type ShopOffer } from "./shop";

function fromItem(item: InventoryItem, source: string, count = item.count): InventoryGrant {
  return {
    base: item.base,
    count,
    source,
    lifetime: item.lifetime?.nativeMaximum,
    owners: item.owner != null && !item.transferable ? new Set([item.owner]) : undefined,
  };
}
export function selectedItemGrant(
  offer: ShopOffer,
  row: number,
  cursor: number,
  group: string,
): InventoryGrant | undefined {
  if (row !== 1 || cursor < 0 || cursor >= offer.options.length) {
    return undefined;
  }
  const item = rewardInventoryItem(offer.options[cursor]);
  if (!item) {
    return undefined;
  }
  return {
    ...fromItem(item, "SelectModifierPhase", 1),
    owners: undefined,
    group,
    choice: rewardChoice(offer.options[cursor]),
  };
}
function treasureGrants(
  party: Pick<PokemonData, "id" | "species" | "fusionSpecies">[],
  type: ModifierType,
  source: string,
  group?: string,
): InventoryGrant[] {
  const modifier = type.newModifier();
  if (!(modifier instanceof MoneyRewardModifier)) {
    return [];
  }
  const count = Math.min(Math.floor(Reflect.get(modifier, "moneyMultiplier") as number), 3);
  return party
    .filter(p => p.species === SpeciesId.GIMMIGHOUL || p.fusionSpecies === SpeciesId.GIMMIGHOUL)
    .map(p => ({
      base: canonicalItem(
        new ModifierData(
          modifierTypes
            .EVOLUTION_TRACKER_GIMMIGHOUL()
            .withIdFromFunc(modifierTypes.EVOLUTION_TRACKER_GIMMIGHOUL)
            .newModifier(p),
          true,
        ),
      ).base,
      count,
      source,
      owners: new Set([p.id]),
      group,
      choice: type.id,
      portion: String(p.id),
    }));
}
export function selectedTreasureGrants(offer: ShopOffer, row: number, cursor: number, group: string): InventoryGrant[] {
  const option = row === 1 ? offer.options[cursor] : undefined;
  if (!option || !["NUGGET", "BIG_NUGGET", "RELIC_GOLD"].includes(option.id)) {
    return [];
  }
  const factory = modifierTypes[option.id];
  return treasureGrants(offer.session.party, factory().withIdFromFunc(factory), "SelectModifierPhase", group).map(
    grant => ({
      ...grant,
      choice: rewardChoice(option),
    }),
  );
}

/** The native GTS removes the outgoing party member before re-adding its held
 * items. This is a paid relocation, including normally nontransferable ME
 * items. Species-specific boosters and form items are discarded by the native code. */
export function tradeItemGrants(
  outgoing: number,
  incoming: number,
  modifiers: InventoryData[],
  dream = false,
): InventoryGrant[] {
  return modifiers.flatMap(raw => {
    const item = canonicalItem(raw);
    if (
      item.owner !== outgoing
      || raw.className === "PokemonFormChangeItemModifier"
      || (!dream && raw.className === "SpeciesStatBoosterModifier")
    ) {
      return [];
    }
    return [
      {
        base: item.base,
        count: item.count,
        source: "MysteryEncounterOptionSelectedPhase",
        owners: new Set([incoming]),
        debit: { owner: outgoing, bases: [item.base] },
        lifetime: item.lifetime?.maximum,
        remaining: item.lifetime?.remaining,
      },
    ];
  });
}

/** Derive budgets while the replayed encounter is still loaded. These values
 * must never come from a later client shop session or submitted phase name. */
export function encounterItemGrants(scene: BattleScene): InventoryGrant[] {
  const rng = Phaser.Math.RND.state();
  try {
    const grants: InventoryGrant[] = [];
    const party = scene.getPlayerParty();
    const wave = scene.currentBattle.waveIndex;
    const encounter = scene.currentBattle.mysteryEncounter;
    const fixed = (id: string, source = "ModifierRewardPhase", count = 1, group?: string) => {
      const item = rewardInventoryItem({ id, args: [], cost: 0, tier: ModifierTier.COMMON, upgradeCount: 0 });
      if (item) {
        grants.push({ ...fromItem(item, source, count), owners: undefined, group });
      }
    };
    if (!encounter) {
      for (const reward of scene.currentBattle.trainer?.config.modifierRewardFuncs ?? []) {
        const type = reward();
        const item = rewardInventoryItem(optionData({ type, cost: 0, upgradeCount: 0 }));
        if (item) {
          grants.push(fromItem(item, "ModifierRewardPhase"));
        }
        grants.push(...treasureGrants(scene.gameData.getSessionSaveData().party, type, "ModifierRewardPhase"));
      }
      if (wave < 200) {
        if (wave === 165) {
          fixed("LOCK_CAPSULE");
        }
        for (const id of timedEventManager.getFixedBattleEventRewards(wave)) {
          fixed(id);
        }
        if (wave % 10 === 0) {
          if (wave === 10) {
            fixed("EXP_CHARM");
          }
          fixed(wave % 30 === (scene.offsetGym ? 0 : 20) ? "SUPER_EXP_CHARM" : "EXP_CHARM");
          if (wave <= 150 && wave % 50 === 0) {
            fixed("GOLDEN_POKEBALL");
          }
        }
      }
    }
    // Enemy global buffs cannot be captured or stolen. Nontransferable items
    // remain with the reproduced individual when that individual is captured.
    const enemies = new Map<string, InventoryGrant>();
    const addEnemy = (raw: InventoryData, configured = false) => {
      const item = canonicalItem(raw);
      if (item.owner == null) {
        return;
      }
      const id = `${item.base}:${item.transferable ? "*" : item.owner}`;
      const old = enemies.get(id);
      const count = configured ? Math.max(old?.count ?? 0, item.count) : (old?.count ?? 0) + item.count;
      enemies.set(id, { ...fromItem(item, "battle", count) });
    };
    for (const modifier of scene.findModifiers(m => m instanceof PokemonHeldItemModifier, false)) {
      if (modifier instanceof PokemonHeldItemModifier && modifier.stackCount > 0) {
        addEnemy(new ModifierData(modifier, false));
      }
    }
    // ME options create combat parties after their onInit boundary. Their
    // explicit held-item configs are trusted source bounds, with native caps.
    for (const config of encounter?.enemyPartyConfigs ?? []) {
      const configured = new Map<string, InventoryData>();
      for (const [index, pokemon] of (config.pokemonConfigs ?? []).entries()) {
        for (const receipt of pokemon.modifierConfigs ?? []) {
          const native =
            receipt.modifier instanceof PersistentModifier
              ? receipt.modifier
              : receipt.modifier.newModifier({ id: index, ivs: [31, 31, 31, 31, 31, 31] } as Pokemon);
          if (
            !(native instanceof PokemonHeldItemModifier)
            || !native.isTransferable
            || receipt.isTransferable === false
          ) {
            continue;
          }
          const item = canonicalItem(new ModifierData(native, false));
          const count = receipt.stackCount ?? native.stackCount;
          if (count <= 0) {
            continue;
          }
          const key = `${item.base}:${index}`;
          const old = configured.get(key);
          configured.set(key, { ...item.data, stackCount: Math.min(item.maximum, count + (old?.stackCount ?? 0)) });
        }
      }
      const totals = new Map<string, InventoryData>();
      for (const raw of configured.values()) {
        const base = canonicalItem(raw).base;
        const old = totals.get(base);
        // Aggregate different enemy holders only after each native holder cap.
        totals.set(base, { ...raw, stackCount: raw.stackCount + (old?.stackCount ?? 0) });
      }
      for (const [base, raw] of totals) {
        const item = canonicalItem({ ...raw, stackCount: 1 });
        const key = `${base}:*`;
        const old = enemies.get(key);
        enemies.set(key, { ...fromItem(item, "battle", Math.max(old?.count ?? 0, raw.stackCount)) });
      }
    }
    grants.push(...enemies.values());
    const defeatedBound = Math.max(
      scene.getEnemyParty().length,
      (encounter?.enemyPartyConfigs ?? []).reduce((sum, config) => sum + (config.pokemonConfigs?.length ?? 6), 0),
    );
    // Campaign combat is not replayed. A defeated enemy can return through
    // Revival Blessing (including copied/called moves), so use the item's native
    // total cap when that branch is possible instead of counting each ID once.
    const revivalMoves = new Set([
      MoveId.REVIVAL_BLESSING,
      MoveId.COPYCAT,
      MoveId.METRONOME,
      MoveId.MIMIC,
      MoveId.SKETCH,
      MoveId.MIRROR_MOVE,
    ]);
    const canRevive =
      scene.getEnemyParty().some(p => p.moveset.some(m => revivalMoves.has(m.moveId)))
      || (encounter?.enemyPartyConfigs ?? []).some(config =>
        config.pokemonConfigs?.some(p => p.moveSet?.some(move => revivalMoves.has(move))),
      );
    for (const pokemon of party) {
      if (pokemon.getHeldItems().some(m => m.type.id === "MYSTERY_ENCOUNTER_MACHO_BRACE")) {
        grants.push({
          typeId: "MYSTERY_ENCOUNTER_MACHO_BRACE",
          count: canRevive ? 49 : defeatedBound,
          source: "growth",
          owners: new Set([pokemon.id]),
        });
      }
    }
    if (encounter) {
      const bounded = (typeId: string, count: number, group?: string) =>
        grants.push({ typeId, count, source: "mystery", lifetime: "native", group });
      switch (encounter.encounterType) {
        case ME.BERRIES_ABOUND:
          bounded("BERRY", wave > 160 ? 7 : wave > 120 ? 5 : wave > 40 ? 4 : 2);
          break;
        case ME.FIERY_FALLOUT:
          for (const grant of grants) {
            if (grant.source === "battle" || grant.source === "growth") {
              Object.assign(grant, { group: "fiery:option", choice: "reward", sharedChoice: true });
            }
          }
          grants.push({
            typeId: "ATTACK_TYPE_BOOSTER",
            count: 1,
            source: "mystery",
            lifetime: "native",
            group: "fiery:option",
            choice: "reward",
            sharedChoice: true,
          });
          for (const choice of ["heat", "reward"]) {
            grants.push({ claim: true, group: "fiery:option", choice, count: 1, source: "mystery" });
          }
          break;
        case ME.SHADY_VITAMIN_DEALER:
          bounded("BASE_STAT_BOOSTER", 2);
          break;
        case ME.AN_OFFER_YOU_CANT_REFUSE:
          bounded("SHINY_CHARM", 1);
          break;
        case ME.ABSOLUTE_AVARICE:
          grants.push(...avariceRefundGrants(scene, grants));
          break;
        case ME.DELIBIRDY:
          for (const id of ["AMULET_COIN", "CANDY_JAR", "BERRY_POUCH", "HEALING_CHARM", "SHELL_BELL"]) {
            bounded(id, 1, "delibirdy:main");
          }
          for (const id of timedEventManager.getDelibirdyBuff()) {
            fixed(id, "mystery", 1, "delibirdy:event");
          }
          break;
        case ME.TRASH_TO_TREASURE:
          for (const id of ["LEFTOVERS", "SHELL_BELL", "MYSTERY_ENCOUNTER_BLACK_SLUDGE"]) {
            fixed(id, "mystery");
          }
          break;
        case ME.THE_STRONG_STUFF:
          for (const [index, pokemon] of [...party]
            .sort((a, b) => b.getSpeciesForm().getBaseStatTotal() - a.getSpeciesForm().getBaseStatTotal())
            .entries()) {
            const value = index < 2 ? -15 : 10;
            const native = modifierTypes
              .MYSTERY_ENCOUNTER_SHUCKLE_JUICE()
              .generateType(party, [value])!
              .withIdFromFunc(modifierTypes.MYSTERY_ENCOUNTER_SHUCKLE_JUICE)
              .newModifier(pokemon) as PersistentModifier;
            grants.push(fromItem(canonicalItem(new ModifierData(native, true)), "mystery"));
          }
          break;
        case ME.CLOWNING_AROUND:
          for (const grant of grants) {
            if (grant.source === "battle" || grant.source === "growth") {
              Object.assign(grant, { group: "clown:option", choice: "fight", sharedChoice: true });
            }
          }
          for (const choice of ["fight", "exchange", "types"]) {
            grants.push({ claim: true, group: "clown:option", choice, count: 1, source: "mystery" });
          }
          grants.push(...clownExchangeGrants(scene));
          break;
      }
    }
    return grants;
  } finally {
    Phaser.Math.RND.state(rng);
  }
}

function avariceRefundGrants(scene: BattleScene, grants: InventoryGrant[]): InventoryGrant[] {
  const entries = new Map<string, { owner: number; base: string; count: number }>();
  for (const pokemon of scene.getPlayerParty()) {
    for (const berry of pokemon.getHeldItems().filter(m => m instanceof BerryModifier)) {
      const item = canonicalItem(new ModifierData(berry, true));
      const key = `${item.base}:${pokemon.id}`;
      const old = entries.get(key);
      entries.set(key, { owner: pokemon.id, base: item.base, count: item.count + (old?.count ?? 0) });
    }
  }
  const escrow = { key: "avarice:stolen", entries: [...entries.values()] };
  const fight = { group: "avarice:option", choice: "fight", sharedChoice: true, escrow };
  for (const grant of grants) {
    if (grant.source === "battle") {
      Object.assign(grant, fight);
    }
  }
  const refunds: InventoryGrant[] = [
    { claim: true, group: "avarice:option", choice: "gift", count: 1, source: "mystery", escrow },
    { typeId: "REVIVER_SEED", count: scene.getPlayerParty().length, source: "mystery", ...fight },
  ];
  for (const pokemon of scene.getPlayerParty()) {
    const stolen = escrow.entries.filter(e => e.owner === pokemon.id);
    const count = Math.floor((stolen.reduce((sum, e) => sum + e.count, 0) * 2) / 5);
    if (count) {
      refunds.push({
        bases: stolen.map(e => e.base),
        count,
        owners: new Set([pokemon.id]),
        source: "mystery",
        group: "avarice:option",
        choice: "refund",
        sharedChoice: true,
        escrow,
      });
    }
  }
  return refunds;
}

function clownExchangeGrants(scene: BattleScene): InventoryGrant[] {
  const party = scene.getPlayerParty();
  const heldCount = (p: Pokemon) =>
    p
      .getHeldItems()
      .filter(m => m.isTransferable && !(m instanceof BerryModifier))
      .reduce((sum, m) => sum + m.stackCount, 0);
  const chosen = party.reduce((best, p) => (heldCount(p) > heldCount(best) ? p : best), party[0]);
  const groups = new Map<string, { bases: string[]; count: number }>();
  for (const modifier of chosen.getHeldItems()) {
    if (!modifier.isTransferable) {
      continue;
    }
    const type: ModifierType = modifier.type.withTierFromPool(ModifierPoolType.PLAYER, party);
    const group =
      modifier instanceof BerryModifier
        ? "berry"
        : type.id === "GOLDEN_EGG" || type.tier === ModifierTier.ROGUE
          ? "rogue"
          : ["LUCKY_EGG", "SOOTHE_BELL"].includes(type.id) || (type.tier ?? ModifierTier.ULTRA) === ModifierTier.ULTRA
            ? "ultra"
            : undefined;
    if (!group) {
      continue;
    }
    const old = groups.get(group) ?? { bases: [], count: 0 };
    old.bases.push(canonicalItem(new ModifierData(modifier, true)).base);
    old.count += modifier.stackCount;
    groups.set(group, old);
  }
  const pools = {
    berry: ["BERRY"],
    ultra: ["REVIVER_SEED", "GOLDEN_PUNCH", "ATTACK_TYPE_BOOSTER", "QUICK_CLAW", "WIDE_LENS"],
    rogue: ["LEFTOVERS", "SHELL_BELL", "SOUL_DEW", "SCOPE_LENS", "BATON", "FOCUS_BAND", "KINGS_ROCK", "GRIP_CLAW"],
  };
  return [...groups].map(([group, old]) => ({
    typeIds: pools[group],
    count: old.count,
    owners: new Set([chosen.id]),
    source: "mystery",
    group: "clown:option",
    choice: "exchange",
    sharedChoice: true,
    debit: { owner: chosen.id, bases: [...new Set(old.bases)] },
  }));
}
