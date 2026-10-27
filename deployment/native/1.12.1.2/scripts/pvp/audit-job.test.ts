// SPDX-License-Identifier: AGPL-3.0-only

import { timedEventManager } from "#app/global-event-manager";
import { activeOverrides } from "#app/overrides";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { version } from "#package.json";
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { it, vi } from "vitest";
import { auditEggs } from "../../src/pvp/audit-eggs";
import { replayGeneration } from "../../src/pvp/audit-engine";
import { AuditInputError } from "../../src/pvp/audit-errors";
import { validateAuditParty } from "../../src/pvp/audit-input";
import { canonicalItem, InventoryAudit } from "../../src/pvp/audit-inventory";
import { auditItemLedger } from "../../src/pvp/audit-item-ledger";
import {
  encounterItemGrants,
  selectedItemGrant,
  selectedTreasureGrants,
  tradeItemGrants,
} from "../../src/pvp/audit-item-sources";
import { MAX_AUDIT_WAVE_BYTES } from "../../src/pvp/audit-limits";
import { findTradeGift, replayAvariceGift, replayGtsTradeGifts } from "../../src/pvp/audit-me-gifts";
import { MoneyAudit } from "../../src/pvp/audit-money";
import { encounterMoneySource, moneyStacks, selectedMoneyReward } from "../../src/pvp/audit-money-sources";
import { PartyAudit } from "../../src/pvp/audit-party";
import auditPolicy from "../../src/pvp/audit-policy.json";
import { type RerollBasis, replayShop } from "../../src/pvp/audit-shop";
import { type GenerationCheckpoint, generatedPokemon, generationResult, serialCopy } from "../../src/pvp/generation";
import manifest from "../../src/pvp/rules-manifest.json";
import { rewardChoice, type ShopOffer } from "../../src/pvp/shop";
import { loadAuditLocale } from "./audit-locale";
import {
  replayClownTypeShuffle,
  replayFieryHeat,
  replayGtsWonderTradeGifts,
  replayWeirdDreamTransformation,
} from "./audit-me-selections";

class Rejected extends AuditInputError {}
it("audits the submitted generation record with the pinned upstream engine", async () => {
  const start = performance.now();
  const input = JSON.parse(readFileSync(process.env.PVP_AUDIT_INPUT!, "utf8"));
  let result: Record<string, unknown>;
  try {
    if (input.kind === "eggs") {
      if (input.manifest?.rulesSHA256 !== manifest.rulesSHA256 || input.manifest?.version !== version) {
        throw new Rejected("egg audit version mismatch");
      }
      const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
      await game.runToTitle();
      Reflect.set(timedEventManager, "disabled", false);
      game.scene.newBattle();
      result = { ok: true, eggs: auditEggs(game.scene, input.eggJob, timestamp => vi.setSystemTime(timestamp)) };
    } else {
      if (input.run.version !== version || input.logs.length !== 200) {
        throw new Rejected("unsupported audit version or incomplete run");
      }
      if (
        input.manifest?.version !== manifest.version
        || input.manifest?.auditSchema !== manifest.auditSchema
        || input.manifest?.rulesSHA256 !== manifest.rulesSHA256
      ) {
        throw new Rejected("audit rules/harness version mismatch");
      }
      const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
      // GameManager defaults make ordinary battle tests easier; generation audits
      // must use the actual shipped rules, including natural mystery encounters.
      vi.spyOn(activeOverrides, "MYSTERY_ENCOUNTER_RATE_OVERRIDE", "get").mockReturnValue(null);
      game.override.disableShinies = false;
      game.override.normalizeIVs = false;
      game.override.normalizeNatures = false;
      game.override.removeEnemyStartingItems = false;
      await game.runToTitle();
      Reflect.set(timedEventManager, "disabled", false);
      if (!input.run.candidate) {
        throw new Rejected("clear candidate missing");
      }
      validateAuditParty(input.run.candidate.party, "candidate.party");
      let actual: ReturnType<typeof generationResult> | undefined;
      const dreamEggMoves: { species: number; moveIndex: number }[] = [];
      const inventoryAudit = new InventoryAudit();
      const moneyAudit = new MoneyAudit();
      const partyAudit = new PartyAudit({
        inventory: id => inventoryAudit.provedItems(id),
        deferResources: true,
        seed: input.run.seed,
        claimReward: (group, choice) => inventoryAudit.claimChoice(group, choice),
        claimEncounter: (group, choice) => inventoryAudit.claimEncounter(group, choice),
      });
      vi.spyOn(GameData.prototype, "saveAll").mockImplementation(async () => {
        actual = generationResult(game.scene);
        // Stop at the pre-combat save boundary. Never simulate campaign combat.
        return new Promise<boolean>(() => {});
      });
      for (let i = 0; i < input.logs.length; i++) {
        const log = input.logs[i];
        const text = log.payload.startsWith("gz:")
          ? gunzipSync(Buffer.from(log.payload.slice(3), "base64"), { maxOutputLength: MAX_AUDIT_WAVE_BYTES }).toString(
              "utf8",
            )
          : log.payload;
        const frame = JSON.parse(text);
        const cp = frame.generation as GenerationCheckpoint;
        if (frame.wave !== i + 1 || cp?.wave !== frame.wave || !frame.generated) {
          throw new Rejected(`wave ${i + 1}: generation proof missing`);
        }
        if (cp.basis.gameVersion !== version) {
          throw new Rejected(`wave ${i + 1}: checkpoint version mismatch`);
        }
        if (!isDeepStrictEqual(cp.identity, input.run.identity)) {
          throw new Rejected(`wave ${i + 1}: trainer identity mismatch`);
        }
        if (i === 0) {
          partyAudit.start(cp.basis.party, true);
        } else {
          partyAudit.observe(cp.basis.party);
        }
        inventoryAudit.bindTransfers(partyAudit.itemTransfers);
        inventoryAudit.observe(cp.basis.party, cp.basis.modifiers);
        partyAudit.finishWave();
        vi.setSystemTime(cp.basis.timestamp);
        await loadAuditLocale(cp.language);
        actual = undefined;
        await replayGeneration(game.scene, cp, input.run.seed, frame.generated);
        await vi.waitUntil(() => actual !== undefined, { timeout: 10000, interval: 1 });
        if (i === 0) {
          moneyAudit.start(cp.basis.money, game.scene.gameMode.getStartingMoney());
        } else {
          moneyAudit.observe(cp.basis.money);
        }
        if (frame.money !== game.scene.money) {
          throw new Rejected(`wave ${frame.wave}: money summary differs from its source checkpoint`);
        }
        const reproduced = serialCopy(actual!);
        if (frame.generated.giftParty === undefined) {
          // Earlier logs do not contain the redundant gift summary. Its source
          // is still obtained from fresh engine generation when auditing gifts.
          Reflect.deleteProperty(reproduced, "giftParty");
        }
        if (!isDeepStrictEqual(reproduced, frame.generated)) {
          throw new Rejected(`wave ${frame.wave}: generated encounter mismatch`);
        }
        partyAudit.beginEncounter(
          actual!.mysteryEncounterType ?? -1,
          game.scene.getMaxExpLevel(),
          (actual!.mysteryEncounterType ?? -1) >= 0 ? 6 : actual!.enemyParty.length,
        );
        partyAudit.setEnvironment({ time: game.scene.arena.getTimeOfDay(), biome: game.scene.arena.biomeId });
        partyAudit.observe(game.scene.gameData.getSessionSaveData().party);
        // Rewards/evolutions and the next pre-generation checkpoint belong to
        // this wave's environment. Replace it only after replaying the next wave.
        inventoryAudit.begin(encounterItemGrants(game.scene));
        if (frame.encounterChoice) {
          if (![ME.CLOWNING_AROUND, ME.FIERY_FALLOUT].some(type => type === actual!.mysteryEncounterType)) {
            throw new Rejected(`wave ${frame.wave}: encounter choice has no reproduced source`);
          }
          const choice = frame.encounterChoice;
          partyAudit.observe(choice.party);
          if (actual!.mysteryEncounterType === ME.CLOWNING_AROUND) {
            const transformed =
              choice.option === 2 ? await replayClownTypeShuffle(game.scene, choice.party) : undefined;
            partyAudit.clownSelection(choice.option, transformed);
            if (choice.option === 0) {
              partyAudit.authorizePermanentAbility(
                game.scene.currentBattle.mysteryEncounter!.misc.ability,
                choice.party.flatMap(p => [
                  { id: p.id, fusion: false },
                  { id: p.id, fusion: true },
                ]),
              );
            }
          } else {
            partyAudit.fierySelection(choice.option);
            if (choice.option === 1) {
              const heat = (await replayFieryHeat(game.scene, choice.party))!;
              if (heat.target) {
                partyAudit.authorizePermanentAbility(heat.target.ability, [heat.target]);
              }
            }
          }
        }
        const summary = (p: Record<string, unknown>) =>
          Object.fromEntries(
            [
              "id",
              "species",
              "formIndex",
              "level",
              "abilityIndex",
              "nature",
              "shiny",
              "variant",
              "fusionSpecies",
              "ivs",
              "moves",
            ].map(key => [key, key === "fusionSpecies" ? (p[key] ?? 0) : p[key]]),
          );
        if (
          !isDeepStrictEqual(
            frame.enemyParty.map(summary),
            actual!.enemyParty.map(p => summary(p as unknown as Record<string, unknown>)),
          )
        ) {
          throw new Rejected(`wave ${frame.wave}: encounter summary differs from generated proof`);
        }
        const partySummary = (p: Record<string, unknown>) =>
          Object.fromEntries(
            [
              "id",
              "species",
              "formIndex",
              "level",
              "abilityIndex",
              "nature",
              "shiny",
              "variant",
              "fusionSpecies",
              "ivs",
              "moves",
            ].map(key => [key, key === "fusionSpecies" ? (p[key] ?? 0) : p[key]]),
          );
        const loadedParty = game.scene.gameData
          .getSessionSaveData()
          .party.map(p => ({ ...p, moves: p.moveset.map(m => m.moveId) }));
        if (
          !isDeepStrictEqual(
            frame.party.map(partySummary),
            loadedParty.map(p => partySummary(p as unknown as Record<string, unknown>)),
          )
        ) {
          const expected = frame.party.map(partySummary);
          const loaded = loadedParty.map(p => partySummary(p as unknown as Record<string, unknown>));
          const changed = expected.flatMap((p, i) =>
            Object.keys(p).filter(key => !isDeepStrictEqual(p[key], loaded[i]?.[key])),
          );
          throw new Rejected(
            `wave ${frame.wave}: party summary differs from its source checkpoint (${[...new Set(changed)].join(",")})`,
          );
        }
        const giftParty = [...actual!.giftParty];
        const trades = replayGtsTradeGifts(game.scene);
        let dream: Awaited<ReturnType<typeof replayWeirdDreamTransformation>>;
        if (
          frame.captures?.some(
            (capture: { source: string }) => capture.source === "MysteryEncounterOptionSelectedPhase",
          )
        ) {
          trades.push(...(await replayGtsWonderTradeGifts(game.scene)));
          const originalGeneration = serialCopy(actual!);
          dream = await replayWeirdDreamTransformation(game.scene);
          if (dream) {
            for (const em of dream.eggMoves ?? []) {
              if (!dreamEggMoves.some(d => d.species === em.species && d.moveIndex === em.moveIndex)) {
                dreamEggMoves.push(em);
              }
            }
            trades.push(...dream.gifts.map(g => ({ outgoing: g.outgoing, pokemon: generatedPokemon(g.pokemon) })));
            actual = undefined;
            vi.setSystemTime(cp.basis.timestamp);
            await replayGeneration(game.scene, cp, input.run.seed, frame.generated);
            await vi.waitUntil(() => actual !== undefined, { timeout: 10000, interval: 1 });
            if (!isDeepStrictEqual(serialCopy(actual!), originalGeneration)) {
              throw new Error("dream replay changed the source generation checkpoint");
            }
          }
        }
        giftParty.push(...trades.map(trade => trade.pokemon));
        if (
          frame.captures?.some(
            (capture: { source: string }) => capture.source === "MysteryEncounterOptionSelectedPhase",
          )
        ) {
          const avariceGift = replayAvariceGift(game.scene);
          if (avariceGift) {
            giftParty.push(avariceGift);
          }
        }
        for (const capture of frame.captures ?? []) {
          const gift = capture.source !== "AttemptCapturePhase";
          const trade = gift ? findTradeGift(trades, capture.pokemon, capture.outgoing) : undefined;
          const generated =
            trade?.pokemon
            ?? (gift ? giftParty : actual!.enemyParty).find(
              p => p.id === capture.pokemon.id && p.species === capture.pokemon.species,
            );
          if (!generated) {
            throw new Rejected(`wave ${frame.wave}: capture has no reproduced individual`);
          }
          const nativeFriendship = gift
            ? dream?.gifts.find(g => g.pokemon.id === capture.pokemon.id)?.pokemon.friendship
            : game.scene.getEnemyParty().find(p => p.id === capture.pokemon.id)?.friendship;
          partyAudit.capture(
            capture.pokemon,
            generated,
            capture.source,
            gift,
            trade ? trade.outgoing : undefined,
            nativeFriendship,
          );
        }
        for (const [outgoing, incoming] of partyAudit.itemTrades) {
          for (const grant of tradeItemGrants(outgoing, incoming, cp.basis.modifiers, !!dream)) {
            inventoryAudit.grant(grant);
          }
        }
        for (const data of dream?.items ?? []) {
          const item = canonicalItem(data);
          if (item.owner == null || data.typeId !== "MYSTERY_ENCOUNTER_OLD_GATEAU") {
            throw new Error("unexpected native dream modifier");
          }
          inventoryAudit.grant({
            base: item.base,
            count: item.count,
            source: "MysteryEncounterOptionSelectedPhase",
            owners: new Set([item.owner]),
          });
        }
        const selectedOption = frame.encounterChoice?.option;
        const noCombat =
          (frame.captures ?? []).some(c => c.source !== "AttemptCapturePhase")
          || (actual!.mysteryEncounterType === ME.CLOWNING_AROUND && selectedOption != null && selectedOption !== 0)
          || (actual!.mysteryEncounterType === ME.FIERY_FALLOUT && selectedOption != null && selectedOption !== 0);
        moneyAudit.begin(
          encounterMoneySource(
            game.scene,
            (frame.captures ?? []).map(c => c.pokemon),
            noCombat,
          ),
        );
        let priorRng: string | undefined;
        let priorReroll: RerollBasis | undefined;
        let prior: ShopOffer | undefined;
        let selectedOffer: ShopOffer | undefined;
        let rewardGroup = 0;
        const selected = new Set<string>();
        if (!Array.isArray(frame.shops) || frame.shops.length > 512) {
          throw new Rejected(`wave ${frame.wave}: invalid shop log`);
        }
        for (const [shopIndex, record] of frame.shops.entries()) {
          if (record.kind !== "offer") {
            if (Number.isInteger(record.rowCursor) && Number.isInteger(record.cursor)) {
              partyAudit.selection(record.rowCursor, record.cursor);
              const key = `${rewardGroup}:${record.cursor}`;
              if (selectedOffer && record.rowCursor === 1 && !selected.has(key)) {
                selected.add(key);
                const group = `reward:${rewardGroup}`;
                const cash = selectedMoneyReward(game.scene, selectedOffer, record.cursor);
                if (cash > 0) {
                  const choice = rewardChoice(selectedOffer.options[record.cursor]);
                  moneyAudit.reward(cash, () => inventoryAudit.claimChoice(group, choice));
                }
                const grant = selectedItemGrant(selectedOffer, record.rowCursor, record.cursor, group);
                if (grant) {
                  inventoryAudit.grant({ ...grant, availableAfterShop: shopIndex });
                }
                for (const treasure of selectedTreasureGrants(selectedOffer, record.rowCursor, record.cursor, group)) {
                  inventoryAudit.grant({ ...treasure, availableAfterShop: shopIndex });
                }
              }
            }
            continue;
          }
          const offer = record as ShopOffer;
          if (offer.session.waveIndex !== frame.wave) {
            throw new Rejected(`wave ${frame.wave}: shop wave mismatch`);
          }
          if (offer.copy) {
            moneyAudit.menu(offer.session.money);
            if (!prior || !isDeepStrictEqual(offer.options, prior.options)) {
              throw new Rejected(`wave ${frame.wave}: shop copy changed`);
            }
            partyAudit.observe(offer.session.party);
            partyAudit.offer(offer);
            selectedOffer = offer;
            continue;
          }
          if (offer.rerolls && (!prior || offer.rerolls !== prior.rerolls + 1)) {
            throw new Rejected(`wave ${frame.wave}: reroll sequence mismatch`);
          }
          partyAudit.observe(offer.session.party);
          const shop = await replayShop(
            game.scene,
            offer,
            input.run.seed,
            priorRng,
            frame.generated.mysteryEncounterType,
            priorReroll,
          );
          if (!isDeepStrictEqual(shop.options, offer.options)) {
            throw new Rejected(`wave ${frame.wave}: generated reward mismatch`);
          }
          if (offer.rerolls) {
            if (shop.rerollCost == null) {
              throw new Error("native reroll cost missing");
            }
            moneyAudit.menu(offer.session.money, shop.rerollCost);
          } else {
            moneyAudit.observe(offer.session.money);
          }
          priorRng = shop.rng;
          priorReroll = shop.nextReroll;
          prior = offer;
          selectedOffer = offer;
          if (!offer.rerolls) {
            rewardGroup++;
          }
          partyAudit.offer(offer);
        }
        // A fusion selected after the last offer must be proved before native
        // item ownership changes in that wave's acquisition/state stream.
        const next = i + 1 < input.logs.length ? input.logs[i + 1] : undefined;
        const nextFrame = next
          ? JSON.parse(
              next.payload.startsWith("gz:")
                ? gunzipSync(Buffer.from(next.payload.slice(3), "base64"), {
                    maxOutputLength: MAX_AUDIT_WAVE_BYTES,
                  }).toString("utf8")
                : next.payload,
            )
          : undefined;
        partyAudit.observe(nextFrame?.generation?.basis?.party ?? input.run.candidate.party);
        inventoryAudit.bindTransfers(partyAudit.itemTransfers);
        auditItemLedger(
          inventoryAudit,
          cp.basis.modifiers,
          frame.items,
          partyAudit.knownIds(),
          actual!.mysteryEncounterType ?? -1,
          frame.shops,
        );
        const nextSession = nextFrame?.generation?.basis ?? input.run.candidate;
        inventoryAudit.observe(nextSession.party, nextSession.modifiers);
        partyAudit.finishWave();
        moneyAudit.finish(
          nextSession.money,
          frame.wave % 10 === 0 && frame.wave < 200 ? moneyStacks(nextSession.modifiers, "COIN_CASE") : 0,
        );
      }
      partyAudit.observe(input.run.candidate.party);
      inventoryAudit.observe(input.run.candidate.party, input.run.candidate.modifiers);
      partyAudit.finishWave();
      result = {
        ok: true,
        policy: auditPolicy.policy,
        waves: 200,
        partyVerified: true,
        inventoryVerified: true,
        formItemsVerified: true,
        levelsVerified: true,
        moneyVerified: true,
        dreamEggMoves: dreamEggMoves.length ? dreamEggMoves : undefined,
      };
    }
  } catch (error) {
    result = {
      ok: false,
      policy: input.kind === "eggs" ? undefined : auditPolicy.policy,
      retry: !(error instanceof AuditInputError),
      reason: String(error instanceof Error ? error.message : error),
    };
  }
  result.elapsedMs = Math.round(performance.now() - start);
  result.maxRSS = process.resourceUsage().maxRSS;
  writeFileSync(process.env.PVP_AUDIT_OUTPUT!, JSON.stringify(result));
});
