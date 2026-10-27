// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { BiomeId } from "#enums/biome-id";
import { ModifierTier } from "#enums/modifier-tier";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { type CustomModifierSettings, ModifierTypeOption } from "#modifiers/modifier-type";
import { generateModifierTypeOption } from "#mystery-encounters/encounter-phase-utils";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import { getModifierType } from "#utils/modifier-utils";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditInputError } from "../../../src/pvp/audit-errors";
import { decodeEncounterRewards } from "../../../src/pvp/audit-me-rewards";
import { replayShop } from "../../../src/pvp/audit-shop";
import { serialCopy } from "../../../src/pvp/generation";
import { optionData, rewardSettings, type ShopOffer, shopSettings } from "../../../src/pvp/shop";

describe("Mystery encounter reward source policies and real reward replay", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(() => {
    game = new GameManager(phaser);
  });
  const decode = (settings: CustomModifierSettings, encounter: ME) =>
    decodeEncounterRewards(rewardSettings(settings), encounter, 45, game.scene.getPlayerParty());
  describe("preset and roll reproduction", () => {
    beforeEach(async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      game.scene.phaseManager.clearPhaseQueue();
    });
    it("allows the common empty healed-encounter shop without authorizing a reward", () => {
      const settings = { fillRemaining: false, rerollMultiplier: -1 };
      expect(() => decode(settings, ME.DARK_DEAL)).not.toThrow();
      expect(() =>
        decode({ ...settings, guaranteedModifierTypeFuncs: [modifierTypes.MASTER_BALL] }, ME.DARK_DEAL),
      ).toThrow(/source policy/);
    });
    it("accepts every static reward preset in the pinned upstream encounter sources", () => {
      let count = 0;
      const directory = "src/data/mystery-encounters/encounters";
      for (const file of readdirSync(directory).filter(f => f.endsWith(".ts"))) {
        const source = readFileSync(`${directory}/${file}`, "utf8");
        const name = /withEncounterType\(\s*MysteryEncounterType\.(\w+)/.exec(source)?.[1];
        if (!name) {
          continue;
        }
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if (
            ts.isCallExpression(node)
            && node.expression.getText(parsed) === "setEncounterRewards"
            && node.arguments[0]
          ) {
            let settings: CustomModifierSettings | undefined;
            try {
              // Only evaluate object expressions from the trusted pinned source.
              // Dynamic options are covered separately with real generated items.
              settings = new Function(
                "modifierTypes",
                "ModifierTier",
                `return (${node.arguments[0].getText(parsed)});`,
              )(modifierTypes, ModifierTier);
            } catch (error) {
              if (!(error instanceof ReferenceError)) {
                throw error;
              }
            }
            if (settings) {
              expect(() => decode(settings!, Reflect.get(ME, name)), file).not.toThrow();
              count++;
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(parsed);
      }
      expect(count).toBeGreaterThan(30);
    });
    it("accepts all four department store categories and rejects extra or mixed rewards", () => {
      for (const [count, ids] of [
        [5, ["TM_COMMON", "TM_GREAT", "TM_ULTRA"]],
        [3, ["PP_UP", "BASE_STAT_BOOSTER"]],
        [5, ["DIRE_HIT", "TEMP_STAT_STAGE_BOOSTER"]],
        [4, ["POKEBALL", "GREAT_BALL", "ULTRA_BALL", "ROGUE_BALL"]],
      ] as const) {
        const settings = {
          guaranteedModifierTypeFuncs: Array.from({ length: count }, (_, i) => modifierTypes[ids[i % ids.length]]),
        };
        expect(() => decode(settings, ME.DEPARTMENT_STORE_SALE)).not.toThrow();
        settings.guaranteedModifierTypeFuncs.push(modifierTypes.MASTER_BALL);
        expect(() => decode(settings, ME.DEPARTMENT_STORE_SALE)).toThrow(AuditInputError);
      }
    });
    it("bounds pre-generated berries and field trip stat choices", () => {
      const berries = Array.from({ length: 5 }, () => generateModifierTypeOption(modifierTypes.BERRY)!);
      expect(() => decode({ guaranteedModifierTypeOptions: berries }, ME.BERRIES_ABOUND)).not.toThrow();
      const forgedTier = rewardSettings({ guaranteedModifierTypeOptions: berries });
      forgedTier.options[0].tier = ModifierTier.MASTER;
      expect(() => decodeEncounterRewards(forgedTier, ME.BERRIES_ABOUND, 45, game.scene.getPlayerParty())).toThrow(
        /tier mismatch/,
      );
      berries.push(berries[0]);
      expect(() => decode({ guaranteedModifierTypeOptions: berries }, ME.BERRIES_ABOUND)).toThrow(/source policy/);
      for (const stats of [
        [1, 2, 5],
        [3, 4, 5],
      ]) {
        const options = [
          ...stats.map(s => generateModifierTypeOption(modifierTypes.TEMP_STAT_STAGE_BOOSTER, [s])!),
          generateModifierTypeOption(modifierTypes.DIRE_HIT)!,
          generateModifierTypeOption(modifierTypes.RARER_CANDY)!,
        ];
        expect(() => decode({ guaranteedModifierTypeOptions: options }, ME.FIELD_TRIP)).not.toThrow();
      }
    });
    it("replays guaranteed factories, generated arguments, tiers and the next reroll", async () => {
      game.scene.currentBattle.waveIndex = 45;
      const settings = {
        guaranteedModifierTypeFuncs: [modifierTypes.RELIC_GOLD],
        guaranteedModifierTiers: [ModifierTier.ROGUE, ModifierTier.ROGUE],
        fillRemaining: true,
      };
      const makeOffer = (phase: SelectModifierPhase): ShopOffer => {
        phase.start();
        const offer = serialCopy({
          kind: "offer" as const,
          ...shopSettings(phase),
          locked: game.scene.lockModifierTiers,
          session: game.scene.gameData.getSessionSaveData(),
          options: (Reflect.get(phase, "typeOptions") as ModifierTypeOption[]).map(optionData),
        });
        offer.session.mysteryEncounterType = ME.A_TRAINERS_TEST;
        return offer;
      };
      const first = makeOffer(new SelectModifierPhase(0, undefined, settings));
      const rng = Phaser.Math.RND.state();
      const second = makeOffer(new SelectModifierPhase(1, undefined, settings));
      const seed = game.scene.seed;
      const actual = await replayShop(game.scene, first, seed, undefined, ME.A_TRAINERS_TEST);
      expect(actual.options).toEqual(first.options);
      expect(actual.rng).toBe(rng);
      expect((await replayShop(game.scene, second, seed, actual.rng, ME.A_TRAINERS_TEST)).options).toEqual(
        second.options,
      );
      await expect(replayShop(game.scene, first, seed, undefined, ME.DANCING_LESSONS)).rejects.toThrow(
        /encounter source/,
      );
      first.custom!.functions = ["MASTER_BALL"];
      await expect(replayShop(game.scene, first, seed, undefined, ME.A_TRAINERS_TEST)).rejects.toThrow(/source policy/);
    });
    it("restores the RNG while decoding a pre-generated item and rejects invented item arguments", () => {
      const item = new ModifierTypeOption(getModifierType(modifierTypes.LEFTOVERS).withTierFromPool(), 0);
      const state = Phaser.Math.RND.state();
      expect(() => decode({ guaranteedModifierTypeOptions: [item] }, ME.GLOBAL_TRADE_SYSTEM)).not.toThrow();
      expect(Phaser.Math.RND.state()).toBe(state);
      const forged = rewardSettings({ guaranteedModifierTypeOptions: [item] });
      forged.options[0].args = [999999];
      expect(() => decodeEncounterRewards(forged, ME.GLOBAL_TRADE_SYSTEM, 45, game.scene.getPlayerParty())).toThrow(
        AuditInputError,
      );
    });
    it("enforces boundary caps and rejects forged rewards for Bug Superfan, Weird Dream, Fight or Flight, Winstrate, Chest and Teleport", () => {
      // 1. BUG_TYPE_SUPERFAN
      const makeOpt = (func: any, defaultTier = ModifierTier.ROGUE) => {
        const t = getModifierType(func);
        t.tier = t.tier ?? defaultTier;
        return new ModifierTypeOption(t, 0);
      };
      const superfanValid = [
        makeOpt(modifierTypes.MASTER_BALL, ModifierTier.MASTER),
        makeOpt(modifierTypes.MEGA_BRACELET, ModifierTier.ROGUE),
      ];
      expect(() => decode({ guaranteedModifierTypeOptions: superfanValid }, ME.BUG_TYPE_SUPERFAN)).not.toThrow();

      // Over 4 items (bound min: 1, max: 4)
      const superfanOver = [
        makeOpt(modifierTypes.MASTER_BALL, ModifierTier.MASTER),
        makeOpt(modifierTypes.MEGA_BRACELET, ModifierTier.ROGUE),
        makeOpt(modifierTypes.MASTER_BALL, ModifierTier.MASTER),
        makeOpt(modifierTypes.MEGA_BRACELET, ModifierTier.ROGUE),
        makeOpt(modifierTypes.MASTER_BALL, ModifierTier.MASTER),
      ];
      expect(() => decode({ guaranteedModifierTypeOptions: superfanOver }, ME.BUG_TYPE_SUPERFAN)).toThrow(/source policy/);

      // Disallowed item id: CANDY_JAR
      const superfanDisallowed = [makeOpt(modifierTypes.CANDY_JAR, ModifierTier.GREAT)];
      expect(() => decode({ guaranteedModifierTypeOptions: superfanDisallowed }, ME.BUG_TYPE_SUPERFAN)).toThrow(/source policy/);

      // Golden Bug Net with forged tier (e.g. MASTER tier instead of ROGUE 3)
      const netOption = makeOpt(modifierTypes.MYSTERY_ENCOUNTER_GOLDEN_BUG_NET, ModifierTier.ROGUE);
      const forgedNet = rewardSettings({
        guaranteedModifierTypeOptions: [netOption],
        guaranteedModifierTypeFuncs: [modifierTypes.REVIVER_SEED],
      });
      forgedNet.options[0].tier = ModifierTier.MASTER;
      expect(() => decodeEncounterRewards(forgedNet, ME.BUG_TYPE_SUPERFAN, 45, game.scene.getPlayerParty())).toThrow(
        /tier mismatch/,
      );

      // 2. WEIRD_DREAM
      // Option 0: 4 mints + rogue ball + memory mushroom is valid
      const dreamOption0 = {
        guaranteedModifierTypeFuncs: [
          modifierTypes.MEMORY_MUSHROOM,
          modifierTypes.ROGUE_BALL,
          modifierTypes.MINT,
          modifierTypes.MINT,
          modifierTypes.MINT,
          modifierTypes.MINT,
        ],
      };
      expect(() => decode(dreamOption0, ME.WEIRD_DREAM)).not.toThrow();

      // Forged with 5 mints (> 4 mints)
      const dream5Mints = {
        guaranteedModifierTypeFuncs: [
          modifierTypes.MEMORY_MUSHROOM,
          modifierTypes.ROGUE_BALL,
          modifierTypes.MINT,
          modifierTypes.MINT,
          modifierTypes.MINT,
          modifierTypes.MINT,
          modifierTypes.MINT,
        ],
      };
      expect(() => decode(dream5Mints, ME.WEIRD_DREAM)).toThrow(/source policy/);

      // Forged with Master Ball instead of Mint
      const dreamMasterBall = {
        guaranteedModifierTypeFuncs: [
          modifierTypes.MEMORY_MUSHROOM,
          modifierTypes.ROGUE_BALL,
          modifierTypes.MASTER_BALL,
          modifierTypes.MINT,
          modifierTypes.MINT,
          modifierTypes.MINT,
        ],
      };
      expect(() => decode(dreamMasterBall, ME.WEIRD_DREAM)).toThrow(/source policy/);

      // Option 1: tiers [3, 3, 2, 2, 1, 1] is valid
      expect(() => decode({ guaranteedModifierTiers: [3, 3, 2, 2, 1, 1] }, ME.WEIRD_DREAM)).not.toThrow();
      // Forged with Tier 4 (Master) in tiers
      expect(() => decode({ guaranteedModifierTiers: [4, 3, 2, 2, 1, 1] }, ME.WEIRD_DREAM)).toThrow(/source policy/);

      // 3. FIGHT_OR_FLIGHT
      const fightGreat = new ModifierTypeOption(getModifierType(modifierTypes.GREAT_BALL).withTierFromPool(), 0);
      fightGreat.type.tier = ModifierTier.GREAT;
      const fightUltra = new ModifierTypeOption(getModifierType(modifierTypes.ULTRA_BALL).withTierFromPool(), 0);
      fightUltra.type.tier = ModifierTier.ULTRA;
      const fightRogue = new ModifierTypeOption(getModifierType(modifierTypes.ROGUE_BALL).withTierFromPool(), 0);
      fightRogue.type.tier = ModifierTier.ROGUE;
      const fightJar = new ModifierTypeOption(getModifierType(modifierTypes.CANDY_JAR).withTierFromPool(), 0);
      fightJar.type.tier = ModifierTier.GREAT;

      // Tier 1 and 2 at wave 45 are accepted (wave > 40 allows up to tier 2)
      expect(() => decode({ guaranteedModifierTypeOptions: [fightGreat] }, ME.FIGHT_OR_FLIGHT)).not.toThrow();
      expect(() => decode({ guaranteedModifierTypeOptions: [fightUltra] }, ME.FIGHT_OR_FLIGHT)).not.toThrow();
      // Tier 3 (Rogue) at wave 45 is rejected (requires wave > 120)
      expect(() => decode({ guaranteedModifierTypeOptions: [fightRogue] }, ME.FIGHT_OR_FLIGHT)).toThrow(/source policy/);
      // CANDY_JAR disallowed in fight random rewards
      expect(() => decode({ guaranteedModifierTypeOptions: [fightJar] }, ME.FIGHT_OR_FLIGHT)).toThrow(/source policy/);
      // More than 1 item (min: 1, max: 1 bound)
      expect(() => decode({ guaranteedModifierTypeOptions: [fightGreat, fightGreat] }, ME.FIGHT_OR_FLIGHT)).toThrow(/source policy/);

      // 4. THE_WINSTRATE_CHALLENGE
      expect(() => decode({ guaranteedModifierTypeFuncs: [modifierTypes.RARER_CANDY] }, ME.THE_WINSTRATE_CHALLENGE)).not.toThrow();
      const machoOpt = new ModifierTypeOption(getModifierType(modifierTypes.MYSTERY_ENCOUNTER_MACHO_BRACE), 0);
      machoOpt.type.tier = ModifierTier.MASTER;
      expect(() =>
        decode(
          { guaranteedModifierTypeOptions: [machoOpt] },
          ME.THE_WINSTRATE_CHALLENGE,
        ),
      ).not.toThrow();
      expect(() => decode({ guaranteedModifierTypeFuncs: [modifierTypes.MASTER_BALL] }, ME.THE_WINSTRATE_CHALLENGE)).toThrow(/source policy/);
      expect(() => decode({ guaranteedModifierTypeFuncs: [modifierTypes.CANDY_JAR] }, ME.THE_WINSTRATE_CHALLENGE)).toThrow(/source policy/);

      // 5. MYSTERIOUS_CHEST
      expect(() => decode({ guaranteedModifierTiers: [0, 0, 1, 1] }, ME.MYSTERIOUS_CHEST)).not.toThrow();
      expect(() => decode({ guaranteedModifierTiers: [0, 0, 1, 4] }, ME.MYSTERIOUS_CHEST)).toThrow(/source policy/);

      // 6. TELEPORTING_HIJINKS
      const validTeleport = [
        generateModifierTypeOption(modifierTypes.ATTACK_TYPE_BOOSTER, [8])!,
        generateModifierTypeOption(modifierTypes.ATTACK_TYPE_BOOSTER, [12])!,
      ];
      expect(() => decode({ guaranteedModifierTypeOptions: validTeleport, fillRemaining: true }, ME.TELEPORTING_HIJINKS)).not.toThrow();
      const forgedTeleport = [
        generateModifierTypeOption(modifierTypes.ATTACK_TYPE_BOOSTER, [9])!,
        generateModifierTypeOption(modifierTypes.ATTACK_TYPE_BOOSTER, [12])!,
      ];
      expect(() => decode({ guaranteedModifierTypeOptions: forgedTeleport, fillRemaining: true }, ME.TELEPORTING_HIJINKS)).toThrow(/source policy/);
    });
  });
  it("replays the shop reached by an actual department store encounter option", async () => {
    game.override.mysteryEncounterChance(100).startingWave(37).startingBiome(BiomeId.PLAINS).disableTrainerWaves();
    await game.runToMysteryEncounter(ME.DEPARTMENT_STORE_SALE, [SpeciesId.BULBASAUR]);
    expect(game.scene.currentBattle.mysteryEncounter?.encounterType).toBe(ME.DEPARTMENT_STORE_SALE);
    await runMysteryEncounterToEnd(game, 2);
    await game.phaseInterceptor.to("SelectModifierPhase");
    const phase = game.scene.phaseManager.getCurrentPhase() as SelectModifierPhase;
    const data: ShopOffer = serialCopy({
      kind: "offer",
      ...shopSettings(phase),
      locked: game.scene.lockModifierTiers,
      session: game.scene.gameData.getSessionSaveData(),
      options: (Reflect.get(phase, "typeOptions") as ModifierTypeOption[]).map(optionData),
    });
    expect(data.options).toHaveLength(3);
    expect((await replayShop(game.scene, data, game.scene.seed, undefined, ME.DEPARTMENT_STORE_SALE)).options).toEqual(
      data.options,
    );
  });
});
