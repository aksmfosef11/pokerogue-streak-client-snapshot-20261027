// SPDX-License-Identifier: AGPL-3.0-only
import { BattleScene } from "#app/battle-scene";
import { timedEventManager } from "#app/global-event-manager";
import { globalScene } from "#app/global-scene";
import { activeOverrides } from "#app/overrides";
import { modifierTypes } from "#data/data-lists";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import type { EnemyPokemon } from "#field/pokemon";
import { BerryModifier, PersistentModifier } from "#modifiers/modifier";
import type { ModifierTypeOption } from "#modifiers/modifier-type";
import { PokemonMove } from "#moves/pokemon-move";
// biome-ignore lint/performance/noNamespaceImport: Suppress only trade dialogue while the original option executes.
import * as encounterDialogue from "#mystery-encounters/encounter-dialogue-utils";
// biome-ignore lint/performance/noNamespaceImport: Select the real outgoing party member at the native callback boundary.
import * as encounterPhases from "#mystery-encounters/encounter-phase-utils";
// biome-ignore lint/performance/noNamespaceImport: Skip only the capture UI while preserving native party insertion.
import * as encounterPokemon from "#mystery-encounters/encounter-pokemon-utils";
import { BattleEndPhase } from "#phases/battle-end-phase";
import { MoneyRewardPhase } from "#phases/money-reward-phase";
import { MysteryEncounterOptionSelectedPhase } from "#phases/mystery-encounter-phases";
import { NewBiomeEncounterPhase } from "#phases/new-biome-encounter-phase";
import { NextEncounterPhase } from "#phases/next-encounter-phase";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { GameData } from "#system/game-data";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import i18next from "i18next";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAuditLocale } from "../../../scripts/pvp/audit-locale";
import { applyClownAbilityChoice, replayWeirdDreamTransformation } from "../../../scripts/pvp/audit-me-selections";
import { replayGeneration } from "../../../src/pvp/audit-engine";
import { rewardInventoryItem } from "../../../src/pvp/audit-inventory";
import {
  type GenerationCheckpoint,
  generatedPokemon,
  generationAfter,
  generationBefore,
  generationResult,
  serialCopy,
} from "../../../src/pvp/generation";
import { type ItemRecord, inventoryDelta } from "../../../src/pvp/inventory-ledger";
import manifest from "../../../src/pvp/rules-manifest.json";
import { optionData, type ShopOffer, shopSettings } from "../../../src/pvp/shop";

type GenerationCase = readonly [
  string,
  boolean,
  boolean | "normal",
  boolean,
  boolean,
  false | "clown" | "fiery",
  boolean?,
  (false | "gift" | "return")?,
];
/** Split long native samples across files so Vitest can schedule them
 * independently while preserving the same generator and every sample. */
export function registerGenerationReplayTests(cases: readonly GenerationCase[], smoke = true) {
  describe("Registration generation replay", () => {
    let phaser: Phaser.Game;
    let game: GameManager;
    let checkpoint: GenerationCheckpoint;
    let naturalRules = false;
    let naturalSeed: string | undefined;
    let moneyRules = false;
    beforeAll(() => {
      phaser = new Phaser.Game({ type: Phaser.HEADLESS });
    });
    afterAll(async () => {
      timedEventManager.disable();
      Reflect.set(timedEventManager, "cachedReplacementMap", null);
      await loadAuditLocale("en");
      // The final case has no following beforeEach to release its headless
      // sprite roots. Do not retain an entire 200-wave scene across files.
      phaser.anims.removeAllListeners(Phaser.Animations.Events.REMOVE_ANIMATION);
      phaser.events.removeAllListeners();
    });
    beforeEach(() => {
      // GameWrapper stubs rendering. Temporary sprites from the previous
      // headless case otherwise remain rooted by AnimationState's global
      // removal listeners, making Sprite.destroy progressively quadratic.
      globalScene?.anims.removeAllListeners(Phaser.Animations.Events.REMOVE_ANIMATION);
      game = new GameManager(phaser);
      naturalRules = false;
      naturalSeed = undefined;
      moneyRules = false;
      timedEventManager.disable();
      game.override.disableShinies = false;
      game.override.normalizeIVs = false;
      game.override.normalizeNatures = false;
      game.override.removeEnemyStartingItems = false;
      const original = BattleScene.prototype.newBattle;
      vi.spyOn(game.scene, "newBattle").mockImplementation(function (this: BattleScene, data) {
        // Upstream generateStarters assigns scene.seed directly. Ranked starts use
        // setSeed, which also derives the time-of-day and gym offsets.
        if (!data) {
          this.setSeed(naturalSeed ?? this.seed);
          if (moneyRules && !this.currentBattle) {
            this.money = this.gameMode.getStartingMoney();
          }
        }
        if (!data && naturalRules) {
          Reflect.set(timedEventManager, "disabled", false);
        }
        const previous = data ? undefined : generationBefore(this);
        const result = original.call(this, data);
        if (!data) {
          checkpoint = generationAfter(this, previous);
        }
        return result;
      });
    });

    async function checkReplay() {
      const expected = generationResult(game.scene);
      const input = serialCopy(checkpoint);
      const seed = game.scene.seed;
      const oldCycle = game.scene.waveCycleOffset;
      game.scene.setSeed(seed);
      expect(game.scene.waveCycleOffset, `inconsistent original cycle for ${seed}`).toEqual(oldCycle);
      let actual: ReturnType<typeof generationResult> | undefined;
      vi.spyOn(game.scene.gameData, "saveAll").mockRestore();
      // reset(clearData) creates a fresh GameData, so intercept its prototype.
      const { GameData } = await import("#system/game-data");
      vi.spyOn(GameData.prototype, "saveAll").mockImplementation(async () => {
        actual = generationResult(game.scene);
        return true;
      });
      await replayGeneration(game.scene, input, seed, expected);
      await vi.waitUntil(() => !!actual, { timeout: 10000, interval: 5 });
      expect(actual).toEqual(expected);
      return { input, seed, actual };
    }

    if (smoke) {
      it("regenerates wild species, IDs, IVs, moves, items and weather without simulating combat", async () => {
        await game.classicMode.startBattle(SpeciesId.BULBASAUR);
        await checkReplay();
      });

      it.each([2, 5, 10, 11, 25, 145, 195, 200])(
        "replays wave %i from the pre-generation save checkpoint",
        async wave => {
          await game.classicMode.startBattle(SpeciesId.BULBASAUR);
          game.scene.phaseManager.clearPhaseQueue();
          game.scene.currentBattle.waveIndex = wave - 1;
          if (wave > 190) {
            game.scene.newArena(BiomeId.END);
          } else if (wave === 11) {
            game.scene.newArena(BiomeId.PLAINS);
          }
          game.scene.arena.init();
          game.scene.newBattle();
          const { GameData } = await import("#system/game-data");
          let saved = false;
          vi.spyOn(game.scene.gameData, "saveAll").mockRestore();
          vi.spyOn(GameData.prototype, "saveAll").mockImplementation(async () => {
            saved = true;
            return true;
          });
          const Phase = wave % 10 === 1 ? NewBiomeEncounterPhase : NextEncounterPhase;
          new Phase(false).start();
          await vi.waitUntil(() => saved, { timeout: 10000, interval: 5 });
          await checkReplay();
        },
      );
    }
    it.each(cases.map(c => [c[0], c[1], c[2], c[3], c[4], c[5], c[6] ?? false, c[7] ?? false] as const))(
      "records and replays every classic wave using natural encounter rules (%s, candy history=%s, trade history=%s, dream history=%s, clown history=%s, ability history=%s, money history=%s, avarice history=%s)",
      async (
        language,
        growLevels,
        tradeHistory,
        dreamHistory,
        clownHistory,
        abilityHistory,
        moneyHistory = false,
        avariceHistory = false,
      ) => {
        await loadAuditLocale(language);
        expect(i18next.hasResourceBundle(language, "trainersCommon")).toBe(true);
        vi.spyOn(activeOverrides, "MYSTERY_ENCOUNTER_RATE_OVERRIDE", "get").mockReturnValue(null);
        naturalRules = true;
        moneyRules = moneyHistory;
        naturalSeed = avariceHistory
          ? (process.env.PVP_AVARICE_FIXTURE_SEED ?? "pvp-avarice-v1")
          : dreamHistory
            ? (process.env.PVP_DREAM_FIXTURE_SEED ?? "pvp-weird-dream-v2")
            : tradeHistory || clownHistory || abilityHistory === "clown"
              ? "pvp-wonder-trade-v1"
              : abilityHistory === "fiery"
                ? (process.env.PVP_FIERY_FIXTURE_SEED ?? "pvp-fiery-fallout-v1")
                : moneyHistory
                  ? (process.env.PVP_MONEY_FIXTURE_SEED ?? "pvp-money-v2")
                  : undefined;
        game.override.moveset([MoveId.TACKLE, MoveId.GROWL]);
        await game.classicMode.startBattle(
          ...(dreamHistory ? [SpeciesId.BULBASAUR, SpeciesId.CHIKORITA] : [SpeciesId.BULBASAUR]),
        );
        // Apply the legal selected starter moves once. Leaving the test override
        // active would rewrite a captured Pokemon's moves whenever it is loaded.
        game.override.moveset([]);
        const seed = game.scene.seed;
        const starters = game.scene.getPlayerParty().map(p => ({
          speciesId: p.species.speciesId,
          formIndex: p.formIndex,
          passive: p.passive,
          moveset: p.getMoveset().map(m => m.moveId),
        }));
        const logs: { wave: number; payload: string; head: string }[] = [];
        let head = "";
        let encounterRewardRecorded = false;
        let encounterGiftRecorded = false;
        let persistentRewardRecorded = false;
        let encounterTradeRecorded = false;
        let relocatedItemRecorded = false;
        let dreamRecorded = false;
        let ppBoostRecorded = false;
        let clownRecorded = false;
        let abilityRecorded = false;
        let cashRewardRecorded = false;
        let paidRerollRecorded = false;
        let avariceRecorded = false;
        for (let wave = 1; wave <= 200; wave++) {
          const data = game.scene.gameData.getSessionSaveData();
          const generated = generationResult(game.scene);
          const frame = {
            wave,
            party: data.party.map(generatedPokemon),
            enemyParty: data.enemyParty.map(generatedPokemon),
            money: data.money,
            items: [] as ItemRecord[],
            shops: [] as (ShopOffer | { rowCursor: number; cursor: number; rerolls: number })[],
            captures: [] as { pokemon: PokemonData; source: string; outgoing?: number }[],
            encounterChoice: undefined as { option: number; party: PokemonData[] } | undefined,
            generation: serialCopy(checkpoint),
            generated,
          };
          await checkReplay();
          // Avarice's real visual callback already removes the saved berries
          // after replay's save boundary. Start its ledger before that callback.
          let inventory = serialCopy(
            generated.mysteryEncounterType === MysteryEncounterType.ABSOLUTE_AVARICE
              ? checkpoint.basis.modifiers
              : game.scene.gameData.getSessionSaveData().modifiers,
          );
          let source = "AttemptCapturePhase";
          const state = (force = false) => {
            const next = serialCopy(game.scene.gameData.getSessionSaveData().modifiers);
            const changes = inventoryDelta(inventory, next);
            if (changes.length > 0 || force) {
              frame.items.push({ kind: "state", changes, source });
            }
            inventory = next;
          };
          const shop = (record: (typeof frame.shops)[number]) => {
            state();
            frame.items.push({ kind: "shop", index: frame.shops.length, source: "SelectModifierPhase" });
            frame.shops.push(serialCopy(record));
          };
          const originalAdd = game.scene.addModifier;
          const addSpy = vi.spyOn(game.scene, "addModifier").mockImplementation((...args) => {
            const persistent = args[0] instanceof PersistentModifier && !args[3];
            if (persistent) {
              state();
              frame.items.push({ kind: "acquire", data: serialCopy(new ModifierData(args[0], true)), source });
            }
            const result = originalAdd.apply(game.scene, args);
            if (persistent) {
              state(true);
            }
            return result;
          });
          if (
            !encounterRewardRecorded
            && generated.mysteryEncounterType === MysteryEncounterType.MYSTERIOUS_CHALLENGERS
          ) {
            // One real generated ME source includes its bounded upstream TM
            // reward preset. The fixture skips combat and chooses no reward.
            const phase = new SelectModifierPhase(0, undefined, {
              guaranteedModifierTypeFuncs: [
                modifierTypes.TM_COMMON,
                modifierTypes.TM_GREAT,
                modifierTypes.MEMORY_MUSHROOM,
              ],
              fillRemaining: true,
            });
            phase.start();
            shop(
              serialCopy({
                kind: "offer",
                ...shopSettings(phase),
                locked: game.scene.lockModifierTiers,
                session: game.scene.gameData.getSessionSaveData(),
                options: (Reflect.get(phase, "typeOptions") as ModifierTypeOption[]).map(optionData),
              }),
            );
            encounterRewardRecorded = true;
          }
          if (wave === 1) {
            const caught = game.scene.getEnemyParty()[0].addToParty(PokeballType.POKEBALL);
            expect(caught).not.toBeNull();
            frame.captures.push({ pokemon: serialCopy(new PokemonData(caught!)), source: "AttemptCapturePhase" });
          }
          if (growLevels) {
            for (const pokemon of game.scene.getPlayerParty()) {
              // Native battle EXP can saturate, but never exceed, this wave's cap.
              pokemon.addExp(1e12);
              pokemon.calculateStats();
            }
            const starter = game.scene.getPlayerParty()[0];
            if (
              starter.getLevelMoves().some(([level, move]) => move === MoveId.SWEET_SCENT && level <= starter.level)
              && !starter.moveset.some(m => m.moveId === MoveId.SWEET_SCENT)
            ) {
              starter.moveset.push(new PokemonMove(MoveId.SWEET_SCENT));
            }
          } else if (
            !tradeHistory
            && !dreamHistory
            && !clownHistory
            && !abilityHistory
            && !moneyHistory
            && !avariceHistory
            && wave === 124
          ) {
            // A possible level-up history gives the party Sweet Scent, satisfying
            // Uncommon Breed's special recruitment requirement at the next ME.
            const starter = game.scene.getPlayerParty()[0];
            starter.level = 30;
            starter.moveset.push(new PokemonMove(MoveId.SWEET_SCENT));
            starter.calculateStats();
          }
          if (
            !tradeHistory
            && !dreamHistory
            && !clownHistory
            && !abilityHistory
            && !moneyHistory
            && !avariceHistory
            && !encounterGiftRecorded
            && generated.giftParty.length > 0
            && generated.mysteryEncounterType === MysteryEncounterType.UNCOMMON_BREED
          ) {
            const gift = game.scene.currentBattle.mysteryEncounter!.misc.pokemon;
            const extra = gift
              .getEggMoves()
              .find(move => move !== game.scene.currentBattle.mysteryEncounter!.misc.eggMove);
            gift.moveset[Math.min(2, gift.moveset.length)] = new PokemonMove(extra);
            const data = new PokemonData(gift);
            data.player = false;
            const caught = (data.toPokemon() as EnemyPokemon).addToParty(PokeballType.POKEBALL)!;
            frame.captures.push({
              pokemon: serialCopy(new PokemonData(caught)),
              source: "MysteryEncounterOptionSelectedPhase",
            });
            encounterGiftRecorded = true;
          }
          if (
            tradeHistory
            && !encounterTradeRecorded
            && generated.mysteryEncounterType === MysteryEncounterType.GLOBAL_TRADE_SYSTEM
          ) {
            const encounter = game.scene.currentBattle.mysteryEncounter!;
            const outgoing = game.scene.getPlayerParty()[0];
            // EncounterPhase resets this RNG after the pre-combat save. The
            // original asynchronous party callback runs outside its seed scope.
            game.scene.resetSeed();
            const selection = vi.spyOn(encounterPhases, "selectPokemonForOption").mockImplementation(callback => {
              const choices = callback(outgoing);
              if (tradeHistory === "normal") {
                expect(choices).toHaveLength(3);
                choices[0].handler();
              }
              return Promise.resolve(true);
            });
            const option = tradeHistory === "normal" ? 0 : 1;
            await encounter.options[option].onPreOptionPhase!();
            selection.mockRestore();
            encounter.selectedOption = encounter.options[option];
            encounter.updateSeedOffset();
            const phase = new MysteryEncounterOptionSelectedPhase();
            let finished = false;
            vi.spyOn(phase, "end").mockImplementation(() => {
              finished = true;
            });
            const dialogue = vi.spyOn(encounterDialogue, "showEncounterText").mockResolvedValue();
            source = phase.phaseName;
            phase.start();
            await vi.waitUntil(() => finished, { timeout: 15000, interval: 1 });
            dialogue.mockRestore();
            const caught = game.scene.getPlayerParty().find(p => p.id === encounter.misc.receivedPokemon.id)!;
            expect(caught).toBeDefined();
            frame.captures.push({ pokemon: serialCopy(new PokemonData(caught)), source, outgoing: outgoing.id });
            state(true);
            relocatedItemRecorded = inventory.some(m => m.args[0] === caught.id);
            encounterTradeRecorded = true;
          }
          if (
            avariceHistory
            && !avariceRecorded
            && generated.mysteryEncounterType === MysteryEncounterType.ABSOLUTE_AVARICE
          ) {
            const encounter = game.scene.currentBattle.mysteryEncounter!;
            source = "MysteryEncounterOptionSelectedPhase";
            const stolen = [...(encounter.misc.berryItemsMap as Map<number, BerryModifier[]>).values()].flat();
            expect(stolen.reduce((sum, m) => sum + m.stackCount, 0)).toBeGreaterThanOrEqual(6);
            expect(game.scene.modifiers.some(m => m instanceof BerryModifier)).toBe(false);
            state(true);
            game.scene.resetSeed();
            const option = avariceHistory === "gift" ? 2 : 1;
            encounter.selectedOption = encounter.options[option];
            encounter.updateSeedOffset();
            const transition = vi
              .spyOn(encounterPhases, "transitionMysteryEncounterIntroVisuals")
              .mockResolvedValue(true);
            const leave = vi.spyOn(encounterPhases, "leaveEncounterWithoutBattle").mockImplementation(() => {});
            const capture = vi.spyOn(encounterPokemon, "catchPokemon").mockImplementation(async pokemon => {
              const caught = pokemon.addToParty(PokeballType.POKEBALL)!;
              frame.captures.push({ pokemon: serialCopy(new PokemonData(caught)), source });
            });
            try {
              let done: Promise<void | boolean> | undefined;
              game.scene.executeWithSeedOffset(() => {
                done = encounter.options[option].onOptionPhase();
              }, encounter.getSeedOffset() * 500);
              await done;
            } finally {
              transition.mockRestore();
              leave.mockRestore();
              capture.mockRestore();
            }
            state(true);
            expect(
              avariceHistory === "gift"
                ? frame.captures.length
                : inventory.filter(m => m.className === "BerryModifier").length,
            ).toBeGreaterThan(0);
            avariceRecorded = true;
          }
          if (dreamHistory && !dreamRecorded && generated.mysteryEncounterType === MysteryEncounterType.WEIRD_DREAM) {
            source = "MysteryEncounterOptionSelectedPhase";
            const dream = (await replayWeirdDreamTransformation(game.scene))!;
            for (const gift of dream.gifts) {
              frame.captures.push({ ...gift, source });
            }
            expect(dream.gifts.some(g => g.pokemon.moveset.some(m => (m.ppUp ?? 0) > 0))).toBe(true);
            state(true);
            dreamRecorded = true;
          }
          if (
            clownHistory
            && !clownRecorded
            && generated.mysteryEncounterType === MysteryEncounterType.CLOWNING_AROUND
          ) {
            frame.encounterChoice = {
              option: 2,
              party: game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p))),
            };
            const encounter = game.scene.currentBattle.mysteryEncounter!;
            source = "MysteryEncounterOptionSelectedPhase";
            game.scene.resetSeed();
            encounter.updateSeedOffset();
            let done: Promise<void | boolean> | undefined;
            game.scene.executeWithSeedOffset(() => {
              done = encounter.options[2].onPreOptionPhase!();
            }, encounter.getSeedOffset());
            await done;
            expect(game.scene.getPlayerParty().every(p => p.customPokemonData.types[1] != null)).toBe(true);
            clownRecorded = true;
          }
          if (
            abilityHistory
            && !abilityRecorded
            && ((abilityHistory === "clown" && generated.mysteryEncounterType === MysteryEncounterType.CLOWNING_AROUND)
              || (abilityHistory === "fiery" && generated.mysteryEncounterType === MysteryEncounterType.FIERY_FALLOUT))
          ) {
            const encounter = game.scene.currentBattle.mysteryEncounter!;
            frame.encounterChoice = {
              option: abilityHistory === "clown" ? 0 : 1,
              party: game.scene.getPlayerParty().map(p => serialCopy(new PokemonData(p))),
            };
            if (abilityHistory === "clown") {
              await applyClownAbilityChoice(game.scene, game.scene.getPlayerParty()[0]);
            } else {
              game.scene.resetSeed();
              encounter.updateSeedOffset();
              let done: Promise<void | boolean> | undefined;
              const messages = vi.spyOn(encounterDialogue, "queueEncounterMessage").mockImplementation(() => {});
              const leave = vi.spyOn(encounterPhases, "leaveEncounterWithoutBattle").mockImplementation(() => {});
              try {
                game.scene.executeWithSeedOffset(() => {
                  done = encounter.options[1].onOptionPhase();
                }, encounter.getSeedOffset() * 500);
                await done;
              } finally {
                messages.mockRestore();
                leave.mockRestore();
              }
            }
            expect(
              game.scene
                .getPlayerParty()
                .some(p => p.customPokemonData.ability >= 0 || (p.fusionCustomPokemonData?.ability ?? -1) >= 0),
            ).toBe(true);
            abilityRecorded = true;
          }
          if ((generated.mysteryEncounterType ?? -1) < 0) {
            if (moneyHistory && game.scene.currentBattle.trainer) {
              const payout = new MoneyRewardPhase(game.scene.currentBattle.trainer.config.moneyMultiplier);
              const text = vi.spyOn(game.scene.ui, "showText").mockImplementation(() => {});
              payout.start();
              text.mockRestore();
            }
            source = "BattleEndPhase";
            const end = new BattleEndPhase(true);
            vi.spyOn(end, "end").mockImplementation(() => {
              frame.items.push({ kind: "battle-end", source: "BattleEndPhase" });
              state(true);
            });
            end.start();
            if (
              (!persistentRewardRecorded && wave % 10 !== 0)
              || (growLevels && wave < 200)
              || (tradeHistory && !encounterTradeRecorded)
              || (dreamHistory && !dreamRecorded)
              || (moneyHistory && wave < 200)
              || (avariceHistory && !avariceRecorded)
            ) {
              let phase = new SelectModifierPhase(
                0,
                undefined,
                game.scene.gameMode.getFixedBattle(wave)?.customModifierRewardSettings,
              );
              phase.start();
              let options = Reflect.get(phase, "typeOptions") as ModifierTypeOption[];
              if (
                moneyHistory
                && !paidRerollRecorded
                && wave >= 20
                && !game.scene.gameMode.getFixedBattle(wave)
                && game.scene.money >= phase.getRerollCost(false)
                && phase.getRerollCost(false) > 0
              ) {
                game.scene.lockModifierTiers = false;
                shop(
                  serialCopy({
                    kind: "offer",
                    ...shopSettings(phase),
                    locked: false,
                    session: game.scene.gameData.getSessionSaveData(),
                    options: options.map(optionData),
                  }),
                );
                const beforeMoney = game.scene.money;
                const cost = phase.getRerollCost(false);
                const ui = vi.spyOn(game.scene.ui, "setMode").mockImplementation(() => new Promise<void>(() => {}));
                expect(Reflect.get(phase, "rerollModifiers").call(phase)).toBe(true);
                ui.mockRestore();
                expect(game.scene.money).toBe(beforeMoney - cost);
                game.scene.phaseManager.clearPhaseQueue();
                phase = new SelectModifierPhase(
                  1,
                  options.map(o => o.type.tier!),
                );
                phase.start();
                options = Reflect.get(phase, "typeOptions") as ModifierTypeOption[];
                paidRerollRecorded = true;
              }
              const persistent = options.findIndex(option => {
                const item = rewardInventoryItem(optionData(option));
                return item && !item.lifetime;
              });
              const candy =
                ["CANDY_JAR", "RARER_CANDY", "RARE_CANDY"]
                  .map(id => options.findIndex(option => option.type.id === id))
                  .find(index => index >= 0) ?? -1;
              const berry = options.findIndex(option => option.type.id === "BERRY");
              const pp = options.findIndex(option => ["PP_UP", "PP_MAX"].includes(option.type.id));
              const amulet = options.findIndex(option => option.type.id === "AMULET_COIN");
              const cash =
                ["RELIC_GOLD", "BIG_NUGGET", "NUGGET"]
                  .map(id => options.findIndex(o => o.type.id === id))
                  .find(i => i >= 0) ?? -1;
              const stacks = (id: string) =>
                game.scene.modifiers.filter(m => m.type.id === id).reduce((sum, m) => sum + m.stackCount, 0);
              const cursor = moneyHistory
                ? amulet >= 0 && stacks("AMULET_COIN") < 5
                  ? amulet
                  : cash
                : !persistentRewardRecorded && persistent >= 0
                  ? persistent
                  : dreamHistory && !ppBoostRecorded && pp >= 0
                    ? pp
                    : tradeHistory || dreamHistory || avariceHistory
                      ? berry
                      : growLevels
                        ? candy
                        : -1;
              if (cursor >= 0 || growLevels || tradeHistory || dreamHistory || moneyHistory || avariceHistory) {
                shop(
                  serialCopy({
                    kind: "offer",
                    ...shopSettings(phase),
                    locked: game.scene.lockModifierTiers,
                    session: game.scene.gameData.getSessionSaveData(),
                    options: options.map(optionData),
                  }),
                );
                if (cursor >= 0) {
                  shop({ rowCursor: 1, cursor, rerolls: shopSettings(phase).rerolls });
                  source = "SelectModifierPhase";
                  const selected = options[cursor].type;
                  const isPp = ["PP_UP", "PP_MAX"].includes(selected.id);
                  const pokemon = game.scene.getPlayerParty()[0];
                  game.scene.addModifier(isPp ? selected.newModifier(pokemon, 0) : selected.newModifier(pokemon), true);
                  ppBoostRecorded ||= isPp;
                  cashRewardRecorded ||= ["NUGGET", "BIG_NUGGET", "RELIC_GOLD"].includes(selected.id);
                  persistentRewardRecorded ||= !!rewardInventoryItem(optionData(options[cursor]));
                }
              }
            }
          }
          addSpy.mockRestore();
          const payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
          head = createHash("sha256").update(`${head}\n${payload}`).digest("hex");
          logs.push({ wave, payload, head });
          if (wave === 200) {
            break;
          }
          game.scene.phaseManager.clearPhaseQueue();
          // BattleEndPhase clears held items before NewBattlePhase; this fixture
          // skips combat but preserves that generation boundary.
          game.scene.clearEnemyHeldItemModifiers();
          if (wave % 10 === 0) {
            game.scene.newArena(
              wave >= 190
                ? BiomeId.END
                : abilityHistory === "fiery"
                  ? BiomeId.VOLCANO
                  : tradeHistory || clownHistory || abilityHistory === "clown" || avariceHistory
                    ? BiomeId.GRASS
                    : BiomeId.PLAINS,
            );
          }
          game.scene.newBattle();
          let saved = false;
          vi.spyOn(GameData.prototype, "saveAll").mockImplementation(async () => {
            saved = true;
            return new Promise<boolean>(() => {});
          });
          const Phase = wave % 10 === 0 ? NewBiomeEncounterPhase : NextEncounterPhase;
          new Phase(false).start();
          await vi.waitUntil(() => saved, { timeout: 10000, interval: 1 });
        }
        expect(logs).toHaveLength(200);
        if (avariceHistory) {
          expect(avariceRecorded).toBe(true);
        } else if (moneyHistory) {
          expect(cashRewardRecorded).toBe(true);
          expect(game.scene.modifiers.some(m => m.type.id === "AMULET_COIN")).toBe(true);
          expect(paidRerollRecorded).toBe(true);
        } else if (abilityHistory) {
          expect(abilityRecorded).toBe(true);
        } else if (clownHistory) {
          expect(clownRecorded).toBe(true);
        } else if (dreamHistory) {
          expect(dreamRecorded).toBe(true);
          expect(ppBoostRecorded).toBe(true);
        } else if (tradeHistory) {
          expect(encounterTradeRecorded).toBe(true);
          expect(relocatedItemRecorded).toBe(true);
        } else {
          expect(encounterRewardRecorded).toBe(true);
          expect(encounterGiftRecorded).toBe(true);
        }
        expect(persistentRewardRecorded).toBe(true);
        const bytes = Buffer.byteLength(JSON.stringify(logs));
        expect(bytes).toBeLessThan(2 * 1024 * 1024);
        const fixturePath = avariceHistory
          ? avariceHistory === "gift"
            ? process.env.PVP_AUDIT_AVARICE_GIFT_FIXTURE
            : process.env.PVP_AUDIT_AVARICE_RETURN_FIXTURE
          : tradeHistory === "normal"
            ? process.env.PVP_AUDIT_NORMAL_TRADE_FIXTURE
            : moneyHistory
              ? process.env.PVP_AUDIT_MONEY_FIXTURE
              : abilityHistory
                ? abilityHistory === "clown"
                  ? process.env.PVP_AUDIT_CLOWN_ABILITY_FIXTURE
                  : process.env.PVP_AUDIT_FIERY_FIXTURE
                : clownHistory
                  ? process.env.PVP_AUDIT_CLOWN_FIXTURE
                  : dreamHistory
                    ? process.env.PVP_AUDIT_DREAM_FIXTURE
                    : tradeHistory
                      ? process.env.PVP_AUDIT_TRADE_FIXTURE
                      : growLevels
                        ? process.env.PVP_AUDIT_LEVEL_FIXTURE
                        : process.env.PVP_AUDIT_FIXTURE;
        if (fixturePath) {
          writeFileSync(
            fixturePath,
            JSON.stringify({
              run: {
                seed,
                version: manifest.version,
                identity: checkpoint.identity,
                starters,
                candidate: serialCopy(game.scene.gameData.getSessionSaveData()),
              },
              manifest,
              logs,
              bytes,
            }),
          );
        }
      },
      180000,
    );
  });
}
