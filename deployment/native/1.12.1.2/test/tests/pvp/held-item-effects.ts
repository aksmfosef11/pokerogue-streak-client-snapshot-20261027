// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { modifierTypes } from "#data/data-lists";
import { SpeciesFormChangeItemTrigger } from "#data/form-change-triggers";
import { Status } from "#data/status-effect";
import { BattlerTagType } from "#enums/battler-tag-type";
import { BerryType } from "#enums/berry-type";
import { HitResult } from "#enums/hit-result";
import { MoveId } from "#enums/move-id";
import { Stat } from "#enums/stat";
import { StatusEffect } from "#enums/status-effect";
import type { Pokemon } from "#field/pokemon";
// biome-ignore lint/performance/noNamespaceImport: Exhaustively dispatch the real native item effects.
import * as M from "#modifiers/modifier";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { PokemonHealPhase } from "#phases/pokemon-heal-phase";
import { BooleanHolder, NumberHolder, toDmgValue } from "#utils/common";
import { expect, vi } from "vitest";

/** Exercises native effect code after server serialization; probabilities are forced only to select a branch. */
export async function checkHeldEffect(m: M.PokemonHeldItemModifier, p: Pokemon, scene: BattleScene) {
  const count = m.stackCount;
  const args = m.getArgs();
  const apply = (...rest: unknown[]) => {
    expect(Reflect.apply(m.shouldApply, m, [p, ...rest]), m.type.name).toBe(true);
    const other = (p.isPlayer() ? scene.getPlayerParty() : scene.getEnemyParty()).find(other => other.id !== p.id)!;
    expect(Reflect.apply(m.shouldApply, m, [other, ...rest]), `${m.type.name}: wrong owner`).toBe(false);
    expect(Reflect.apply(m.apply, m, [p, ...rest]), m.type.name).toBe(true);
  };
  const value = new NumberHolder(100);
  const party: Pokemon[] = p.isPlayer() ? scene.getPlayerParty() : scene.getEnemyParty();
  const index = party.indexOf(p);
  [party[0], party[index]] = [party[index], party[0]];
  scene.field.add(p);
  p.calculateStats();
  p.hp = p.getMaxHp();
  const rng = vi.spyOn(p, "randBattleSeedInt").mockReturnValue(0);
  const queued = vi.spyOn(scene.phaseManager, "unshiftNew");
  const playerMods = scene.modifiers.slice();
  const enemyMods = scene.findModifiers(() => true, false);
  try {
    if (m instanceof M.PokemonFormChangeItemModifier) {
      // A registered party retains its already selected form, not a newly rolled campaign transformation.
      expect(
        speciesDataRegistry
          .getFormChanges(p.species.speciesId)
          .some(
            change =>
              (change.findTrigger(SpeciesFormChangeItemTrigger) as SpeciesFormChangeItemTrigger | undefined)?.item
              === m.formChangeItem,
          ),
      ).toBe(true);
      expect(m.active).toBe(args[2]);
    } else if (m instanceof M.BaseStatModifier) {
      const stats = [100, 100, 100, 100, 100, 100];
      apply(stats);
      expect(stats[args[1]]).toBe(Math.floor(100 * (1 + 0.1 * count)));
      expect(stats.filter(v => v !== 100)).toHaveLength(1);
    } else if (m instanceof M.PokemonBaseStatTotalModifier) {
      const stats = [100, 100, 100, 100, 100, 100];
      apply(stats);
      expect(stats).toEqual([Math.floor(100 + args[1] / 2), ...new Array(5).fill(100 + args[1])]);
    } else if (m instanceof M.PokemonBaseStatFlatModifier) {
      const stats = [100, 100, 100, 100, 100, 100];
      apply(stats);
      expect(stats.filter(v => v === 120)).toHaveLength(3);
      expect(stats.filter(v => v === 100)).toHaveLength(3);
    } else if (m instanceof M.PokemonIncrementingStatModifier) {
      apply(Stat.HP, value);
      expect(value.value).toBe(count === 50 ? Math.floor((100 + 2 * count) * 1.1) : 100 + 2 * count);
      value.value = 100;
      apply(Stat.ATK, value);
      expect(value.value).toBe(count === 50 ? Math.floor((100 + count) * 1.05) : 100 + count);
    } else if (m instanceof M.StatBoosterModifier) {
      apply(args[1][0], value);
      expect(value.value).toBe(100 * args[2]);
      expect(m.shouldApply(p, Stat.HP, new NumberHolder(100))).toBe(false);
    } else if (m instanceof M.CritBoosterModifier) {
      value.value = 0;
      apply(value);
      expect(value.value).toBe(args[1]);
    } else if (m instanceof M.AttackTypeBoosterModifier) {
      apply(args[1], value);
      expect(value.value).toBe(Math.floor(100 * (1 + (count * args[2]) / 100)));
      expect(m.shouldApply(p, (args[1] + 1) % 18, value)).toBe(false);
    } else if (m instanceof M.PokemonNatureWeightModifier) {
      for (const multiplier of [1.1, 0.9]) {
        value.value = multiplier;
        apply(value);
        expect(value.value).toBeCloseTo(multiplier + (multiplier > 1 ? 1 : -1) * 0.1 * count);
      }
      value.value = 1;
      expect(m.apply(p, value)).toBe(false);
      expect(value.value).toBe(1);
    } else if (m instanceof M.PokemonMoveAccuracyBoosterModifier) {
      apply(value);
      expect(value.value).toBe(100 + args[1] * count);
    } else if (m instanceof M.PokemonMultiHitModifier) {
      value.value = 1;
      apply(MoveId.TACKLE, value);
      expect(value.value).toBe(1 + count);
      p.turnData.hitCount = 1 + count;
      p.turnData.hitsLeft = 1 + count;
      value.value = 1;
      apply(MoveId.TACKLE, null, value);
      expect(value.value).toBe(1 - 0.25 * count);
      p.turnData.hitsLeft--;
      value.value = 1;
      apply(MoveId.TACKLE, null, value);
      expect(value.value).toBe(0.25);
    } else if (m instanceof M.PokemonExpBoosterModifier) {
      apply(value);
      expect(value.value).toBe(Math.floor(100 * (1 + (count * args[1]) / 100)));
    } else if (m instanceof M.PokemonFriendshipBoosterModifier) {
      apply(value);
      expect(value.value).toBe(Math.floor(100 * (1 + count * 0.5)));
    } else if (m instanceof M.FieldEffectModifier) {
      value.value = 5;
      apply(value);
      expect(value.value).toBe(5 + count * 2);
    } else if (m instanceof M.SurviveDamageModifier || m instanceof M.FlinchChanceModifier) {
      const flag = new BooleanHolder(false);
      apply(flag);
      expect(flag.value).toBe(true);
      flag.value = false;
      rng.mockReturnValue(99);
      expect(m.apply(p, flag)).toBe(false);
      expect(flag.value).toBe(false);
    } else if (m instanceof M.BypassSpeedChanceModifier) {
      apply();
      expect(p.getTag(BattlerTagType.BYPASS_SPEED)).toBeTruthy();
    } else if (
      m instanceof M.HitHealModifier
      || m instanceof M.TurnHealModifier
      || m instanceof M.PokemonInstantReviveModifier
    ) {
      p.hp = m instanceof M.PokemonInstantReviveModifier ? 0 : Math.floor(p.getMaxHp() / 4);
      const before = p.hp;
      p.turnData.totalDamageDealt = 80;
      apply();
      const heal = queued.mock.calls.find(c => c[0] === "PokemonHealPhase");
      const expected =
        m instanceof M.HitHealModifier
          ? 10 * count
          : m instanceof M.TurnHealModifier
            ? toDmgValue(p.getMaxHp() / 16) * count
            : toDmgValue(p.getMaxHp() / 2);
      expect(heal?.[2]).toBe(expected);
      if (m instanceof M.PokemonInstantReviveModifier) {
        expect(heal?.[3]).toMatchObject({ revive: true });
      }
      await (Reflect.construct(PokemonHealPhase, heal!.slice(1)) as PokemonHealPhase).end();
      expect(p.hp).toBe(Math.min(p.getMaxHp(), before + expected));
      if (m instanceof M.PokemonInstantReviveModifier) {
        await p.loadAssets(false);
      }
    } else if (m instanceof M.ResetNegativeStatStageModifier) {
      p.setStatStage(Stat.ATK, -3);
      p.setStatStage(Stat.DEF, 2);
      apply();
      expect(p.getStatStage(Stat.ATK)).toBe(0);
      expect(p.getStatStage(Stat.DEF)).toBe(2);
    } else if (m instanceof M.TurnStatusEffectModifier) {
      apply();
      const status = queued.mock.calls.find(c => c[0] === "ObtainStatusEffectPhase");
      expect(status?.[2]).toBe(m.type.id === "TOXIC_ORB" ? StatusEffect.TOXIC : StatusEffect.BURN);
    } else if (m instanceof M.BerryModifier) {
      p.hp = 1;
      if (m.berryType === BerryType.LUM) {
        p.status = new Status(StatusEffect.PARALYSIS);
      }
      if (m.berryType === BerryType.ENIGMA) {
        p.turnData.attacksReceived.push({ result: HitResult.SUPER_EFFECTIVE } as never);
      }
      if (m.berryType === BerryType.LEPPA) {
        p.getMoveset()[0].ppUsed = p.getMoveset()[0].getMovePp();
      }
      apply();
      expect(m.consumed).toBe(true);
      if ([BerryType.SITRUS, BerryType.ENIGMA].includes(m.berryType)) {
        expect(queued.mock.calls.find(c => c[0] === "PokemonHealPhase")?.[2]).toBe(toDmgValue(p.getMaxHp() / 4));
      } else if (m.berryType === BerryType.LUM) {
        expect(queued.mock.calls.some(c => c[0] === "ResetStatusPhase")).toBe(true);
        p.clearStatus(true, false);
        expect(p.status).toBeNull();
      } else if (m.berryType === BerryType.LEPPA) {
        expect(p.getMoveset()[0].ppUsed).toBe(p.getMoveset()[0].getMovePp() - 10);
      } else if (m.berryType === BerryType.LANSAT) {
        expect(p.getTag(BattlerTagType.CRIT_BOOST)).toBeTruthy();
      } else {
        expect(p.queuedBerryStatChanges[0].stages).toBe(m.berryType === BerryType.STARF ? 2 : 1);
      }
    } else if (m instanceof M.HeldItemTransferModifier) {
      const target = (p.isPlayer() ? scene.getEnemyParty() : scene.getPlayerParty())[0];
      scene.field.add(target);
      const donor = generateModifierType(modifierTypes.BERRY, [BerryType.LUM])!.newModifier(target) as M.BerryModifier;
      if (p.isPlayer()) {
        Reflect.set(scene, "enemyModifiers", [donor]);
      } else {
        scene.modifiers = [donor];
      }
      const selected =
        m instanceof M.ContactHeldItemTransferChanceModifier
          ? vi.spyOn(m, "getTransferredItemCount").mockReturnValue(1)
          : null;
      try {
        apply(target);
        expect(
          scene.findModifiers(x => x instanceof M.BerryModifier && x.pokemonId === p.id, p.isPlayer()),
        ).toHaveLength(1);
        expect(
          scene.findModifiers(x => x instanceof M.BerryModifier && x.pokemonId === target.id, target.isPlayer()),
        ).toHaveLength(0);
      } finally {
        selected?.mockRestore();
      }
    } else if (m instanceof M.DamageMoneyRewardModifier) {
      scene.money = 0;
      apply(value);
      expect(scene.money).toBe(50 * count);
    } else if (m instanceof M.EvoTrackerModifier || m instanceof M.SwitchEffectTransferModifier) {
      // Native engine markers: consumed by the evolution and switch phases, with no arithmetic apply effect.
      apply();
    } else {
      throw new Error(`No native effect assertion for ${m.constructor.name}`);
    }
  } finally {
    rng.mockRestore();
    queued.mockRestore();
    scene.modifiers = playerMods;
    Reflect.set(scene, "enemyModifiers", enemyMods);
    scene.phaseManager.clearPhaseQueue();
  }
}
