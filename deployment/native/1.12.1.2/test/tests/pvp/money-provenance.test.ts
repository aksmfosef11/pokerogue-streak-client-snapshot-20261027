// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import type { MoneyInterestModifier, MoneyRewardModifier, PersistentModifier } from "#modifiers/modifier";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { MoneyRewardPhase } from "#phases/money-reward-phase";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compoundMoney, MoneyAudit } from "../../../src/pvp/audit-money";
import { encounterMoneySource, selectedMoneyReward } from "../../../src/pvp/audit-money-sources";
import { optionData, type ShopOffer } from "../../../src/pvp/shop";

describe("Native money source bounds", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    game.scene.phaseManager.clearPhaseQueue();
  });
  function wallet(value = 1000) {
    const audit = new MoneyAudit();
    audit.start(value, game.scene.gameMode.getStartingMoney());
    return audit;
  }
  function moneyOffer() {
    const type = generateModifierType(modifierTypes.RELIC_GOLD)!;
    return {
      kind: "offer",
      rerolls: 0,
      special: false,
      copy: false,
      locked: false,
      session: game.scene.gameData.getSessionSaveData(),
      options: [optionData({ type, cost: 0, upgradeCount: 0 })],
    } as ShopOffer;
  }
  it("supports native high-balance arithmetic in a maximum-budget reward/interest control", () => {
    const scene = game.scene;
    scene.money = scene.gameMode.getStartingMoney();
    const audit = wallet(scene.money);
    const coin = generateModifierType(modifierTypes.COIN_CASE)!.newModifier() as MoneyInterestModifier;
    coin.stackCount = 0;
    for (let wave = 1; wave < 200; wave++) {
      scene.currentBattle.waveIndex = wave;
      audit.begin({ income: 0, repeatedCombatIncome: false });
      // This maximum-budget control uses native reward factories/effects;
      // it does not claim that a particular seed offers every chosen reward.
      if (wave <= 5) {
        coin.stackCount++;
      } else {
        const offer = moneyOffer();
        audit.reward(selectedMoneyReward(scene, offer, 0), () => true);
        (generateModifierType(modifierTypes.RELIC_GOLD)!.newModifier() as MoneyRewardModifier).apply();
        audit.observe(scene.money);
      }
      if (wave % 10 === 0) {
        coin.apply();
      }
      audit.finish(scene.money, wave % 10 === 0 ? coin.stackCount : 0);
    }
    expect(scene.money).toBeGreaterThan(10000000);
    expect(Number.isSafeInteger(scene.money)).toBe(true);
  });
  it("matches native interest rounding and wallet saturation for every stack count", () => {
    const coin = generateModifierType(modifierTypes.COIN_CASE)!.newModifier() as MoneyInterestModifier;
    for (let stacks = 0; stacks <= 5; stacks++) {
      coin.stackCount = stacks;
      for (const value of [0, 1, 1000, 9999999, Number.MAX_SAFE_INTEGER - 10, Number.MAX_SAFE_INTEGER]) {
        game.scene.money = value;
        coin.apply();
        expect(compoundMoney(value, stacks)).toBe(game.scene.money);
      }
    }
  });
  it("rejects excess starting money and non-native wallet values", () => {
    expect(() => wallet(1001)).toThrow(/starting money/);
    for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => wallet().observe(amount)).toThrow(/invalid native wallet/);
    }
  });
  it("rejects money without a reward, trainer, event or combat income source", () => {
    const audit = wallet();
    audit.begin(encounterMoneySource(game.scene));
    expect(() => audit.observe(1001)).toThrow(/verified income source/);
  });
  it("does not refill an income budget when money is spent", () => {
    const audit = wallet();
    audit.begin({ income: 100, repeatedCombatIncome: false });
    audit.observe(1050);
    audit.observe(1000);
    audit.observe(1050);
    audit.observe(1000);
    expect(() => audit.observe(1001)).toThrow(/verified income source/);
  });
  it("does not bank an unused money reward into the next wave", () => {
    const audit = wallet();
    audit.begin({ income: 0, repeatedCombatIncome: false });
    audit.reward(1000, () => true);
    audit.finish(1000);
    audit.begin({ income: 0, repeatedCombatIncome: false });
    expect(() => audit.observe(1001)).toThrow(/verified income source/);
  });
  it("does not spend the same reward choice as both money and another item", () => {
    const audit = wallet();
    audit.begin({ income: 0, repeatedCombatIncome: false });
    audit.reward(selectedMoneyReward(game.scene, moneyOffer(), 0), () => false);
    expect(() => audit.observe(1001)).toThrow(/verified income source/);
  });
  it("requires owned Coin Cases and cannot apply interest twice in one wave", () => {
    const audit = wallet();
    audit.begin({ income: 0, repeatedCombatIncome: false });
    audit.finish(1500, 5);
    expect(() => audit.finish(2250, 5)).toThrow(/verified income source/);
    const none = wallet();
    none.begin({ income: 0, repeatedCombatIncome: false });
    expect(() => none.finish(1100, 0)).toThrow(/verified income source/);
  });
  it("requires pre-interest income instead of compounding unearned reward money", () => {
    const audit = wallet();
    audit.begin({ income: 100, repeatedCombatIncome: false });
    audit.finish(1650, 5);
    const insufficient = wallet();
    insufficient.begin({ income: 99, repeatedCombatIncome: false });
    expect(() => insufficient.finish(1650, 5)).toThrow(/verified income source/);
  });
  it.each([false, true])("charges the real reroll handler's fee with tier lock=%s", locked => {
    const scene = game.scene;
    const phase = new SelectModifierPhase();
    phase.start();
    scene.lockModifierTiers = locked;
    scene.money = 1000;
    const fee = phase.getRerollCost(locked);
    expect(fee).toBeGreaterThan(0);
    expect(fee).toBeLessThanOrEqual(scene.money);
    const audit = wallet();
    audit.begin({ income: 0, repeatedCombatIncome: true });
    const ui = vi.spyOn(scene.ui, "setMode").mockImplementation(() => new Promise<void>(() => {}));
    expect(Reflect.get(phase, "rerollModifiers").call(phase)).toBe(true);
    ui.mockRestore();
    expect(scene.money).toBe(1000 - fee);
    expect(() => audit.menu(scene.money, fee)).not.toThrow();
    const unpaid = wallet();
    unpaid.begin({ income: 0, repeatedCombatIncome: true });
    expect(() => unpaid.menu(1000, fee)).toThrow(/fee was not paid/);
    const broke = wallet(0);
    broke.begin({ income: 0, repeatedCombatIncome: true });
    expect(() => broke.menu(0, fee)).toThrow(/exceeds the observed wallet/);
  });
  it("cannot farm combat money while copying the same reward menu", () => {
    const audit = wallet();
    audit.begin({ income: 0, repeatedCombatIncome: true });
    expect(() => audit.menu(1001)).toThrow(/menu money increased/);
    expect(() => audit.menu(1000, -1)).toThrow(/disabled/);
  });
  it("recognizes native enemy money moves without trusting a client phase label", () => {
    game.move.changeMoveset(game.scene.getEnemyParty()[0], [MoveId.PAY_DAY]);
    const source = encounterMoneySource(game.scene);
    expect(source.repeatedCombatIncome).toBe(true);
    const audit = wallet();
    audit.begin(source);
    expect(() => audit.observe(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
  it("does not retroactively use a future Golden Punch for the previous combat", () => {
    const audit = wallet();
    audit.begin(encounterMoneySource(game.scene));
    const gold = generateModifierType(modifierTypes.GOLDEN_PUNCH)!.newModifier(
      game.scene.getPlayerParty()[0],
    ) as PersistentModifier;
    game.scene.addModifier(gold, true);
    expect(() => audit.observe(1001)).toThrow(/verified income source/);
    const next = wallet();
    next.begin(encounterMoneySource(game.scene));
    expect(() => next.observe(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
  it("bounds the actual native trainer payout with owned Amulet Coins", () => {
    // A native config is the same source used by TrainerVictoryPhase.
    game.scene.currentBattle.waveIndex = 5;
    const trainer = game.scene.gameMode.getFixedBattle(5)!.getTrainer();
    game.scene.currentBattle.trainer = trainer;
    const amulet = generateModifierType(modifierTypes.AMULET_COIN)!.newModifier() as PersistentModifier;
    amulet.stackCount = 5;
    game.scene.addModifier(amulet, true);
    const source = encounterMoneySource(game.scene);
    const audit = wallet(0);
    audit.begin(source);
    game.scene.money = 0;
    const phase = new MoneyRewardPhase(trainer.config.moneyMultiplier);
    vi.spyOn(phase, "end").mockImplementation(() => {});
    phase.start();
    expect(game.scene.money).toBeGreaterThan(0);
    expect(() => audit.observe(game.scene.money)).not.toThrow();
    expect(() => audit.observe(source.income + 1)).toThrow(/verified income source/);
  });
  it("bounds the actual native Part Timer encounter income to 4x wave money", () => {
    game.scene.currentBattle.waveIndex = 45;
    game.scene.currentBattle.mysteryEncounter = { encounterType: ME.PART_TIMER } as any;
    const source = encounterMoneySource(game.scene);
    expect(source.income).toBe(game.scene.getWaveMoneyAmount(4));
    const audit = wallet(0);
    audit.begin(source);
    expect(() => audit.observe(source.income)).not.toThrow();
    expect(() => audit.observe(source.income + 1)).toThrow(/verified income source/);
  });
});
