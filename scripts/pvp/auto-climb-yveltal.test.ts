// SPDX-License-Identifier: AGPL-3.0-only
import { BattleScene } from "#app/battle-scene";
// biome-ignore lint/performance/noNamespaceImport: test the real account-bound registration helper.
import * as account from "#app/account";
import { timedEventManager } from "#app/global-event-manager";
import { globalScene } from "#app/global-scene";
import { activeOverrides } from "#app/overrides";
import { BiomeId } from "#enums/biome-id";
import { BattleType } from "#enums/battle-type";
import { MockFetch } from "#test/mocks/mock-fetch";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { BattleEndPhase } from "#phases/battle-end-phase";
import { NewBiomeEncounterPhase } from "#phases/new-biome-encounter-phase";
import { NextEncounterPhase } from "#phases/next-encounter-phase";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import { GameData } from "#system/game-data";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { PokemonMove } from "#moves/pokemon-move";
import { PersistentModifier } from "#modifiers/modifier";
import {
  BaseStatBoosterModifierType,
  FormChangeItemModifierType,
  FusePokemonModifierType,
  type ModifierTypeOption,
  PokemonModifierType,
} from "#modifiers/modifier-type";
import { GameManager } from "#test/framework/game-manager";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { loadAuditLocale } from "./audit-locale";
import { rewardInventoryItem } from "../../src/pvp/audit-inventory";
import {
  type GenerationCheckpoint,
  generatedPokemon,
  generationAfter,
  generationBefore,
  generationResult,
  serialCopy,
} from "../../src/pvp/generation";
import { type ItemRecord, inventoryDelta } from "../../src/pvp/inventory-ledger";
import { optionData, type ShopOffer, shopSettings } from "../../src/pvp/shop";
import { runContract } from "../../src/pvp/run-contract";
import rulesManifest from "../../src/pvp/rules-manifest.json";
import { pvpApi } from "../../src/pvp/api";
import { registerClearedRun, retryPendingRegistrations } from "../../src/pvp/log";
// biome-ignore lint/performance/noNamespaceImport: Exercise the shipped registration feature gate.
import * as pvpState from "../../src/pvp/state";

const gameVersion = rulesManifest.version;
const serverUrl = process.env.PVP_SERVER_URL || "http://server:8001";
const token = process.env.PVP_ACCOUNT_TOKEN;
const targetUsername = process.env.PVP_CLIMB_USER || "yveltal200";

describe.runIf(!!token)("Yveltal 200 Wave Automated Climb & PvP Registration", () => {
  it("climbs 200 waves with Yveltal, swaps Sludge Wave to Oblivion Wing at level 70, and registers", async () => {
    expect(token, "PVP_ACCOUNT_TOKEN is required").toBeTruthy();
    expect(process.env.PVP_AUTOMATION_VERIFY_URL, "The guarded automation runner is required").toBeTruthy();
    expect(process.env.PVP_CLIENT_SESSION_ID, "The current client session is required").toBeTruthy();
    console.info(`[Climb] Starting 200 wave climb for user '${targetUsername}' at ${serverUrl}`);

    await loadAuditLocale("ko");
    timedEventManager.disable();

    // Disable MSW mock server so real HTTP requests to the pokerogue server go through
    if (global.server) {
      global.server.close();
    }

    // 1. Request a ranked run from the server
    // 타오르는분노(822), 파멸의빛(617), 오물웨이브(482), 오라윙(840)
    const starterMoves = [MoveId.FIERY_WRATH, MoveId.LIGHT_OF_RUIN, MoveId.SLUDGE_WAVE, MoveId.ESPER_WING];

    const runRes = await fetch(`${serverUrl}/pvp/runs`, {
      method: "POST",
      headers: {
        Authorization: token!,
        "Content-Type": "application/json",
        "PKR-Client-Version": gameVersion,
      },
      body: JSON.stringify({
        version: gameVersion,
        starters: [
          {
            speciesId: SpeciesId.YVELTAL,
            formIndex: 0,
            passive: true,
            moveset: starterMoves,
          },
        ],
        contract: runContract,
      }),
    });

    const runData = await runRes.json();
    if (!runRes.ok) {
      throw new Error(`Failed to start run: ${JSON.stringify(runData)}`);
    }

    const runId = runData.id;
    const runSeed = runData.seed;
    console.info(`[Climb] Obtained ranked run ID: ${runId}, seed: ${runSeed}`);

    const realFetch = globalThis.fetch;

    // 2. Setup Headless GameManager
    const phaser = new Phaser.Game({ type: Phaser.HEADLESS });
    const game = new GameManager(phaser);
    let checkpoint!: GenerationCheckpoint;

    // Route real server requests through realFetch
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/pvp/") || url.includes("/savedata/") || url.startsWith(serverUrl)) {
        return realFetch(input, init);
      }
      return MockFetch(input, init);
    };

    vi.spyOn(activeOverrides, "MYSTERY_ENCOUNTER_RATE_OVERRIDE", "get").mockReturnValue(null);
    game.override.disableShinies = false;
    game.override.normalizeIVs = false;
    game.override.normalizeNatures = false;
    game.override.removeEnemyStartingItems = false;

    const originalNewBattle = BattleScene.prototype.newBattle;
    vi.spyOn(game.scene, "newBattle").mockImplementation(function (this: BattleScene, data) {
      if (!data) {
        this.setSeed(runSeed ?? this.seed);
        Reflect.set(timedEventManager, "disabled", false);
        if (runData.identity) {
          this.gameData.trainerId = runData.identity.trainerId;
          this.gameData.secretId = runData.identity.secretId;
        }
      }
      const previous = data ? undefined : generationBefore(this);
      const result = originalNewBattle.call(this, data);
      if (!data) {
        checkpoint = generationAfter(this, previous);
      }
      return result;
    });

    // Start with Yveltal having passive = true
    const originalInitBattle = SelectStarterPhase.prototype.initBattle;
    vi.spyOn(SelectStarterPhase.prototype, "initBattle").mockImplementation(function (
      this: SelectStarterPhase,
      starters,
    ) {
      for (const s of starters) {
        if (s.speciesId === SpeciesId.YVELTAL) {
          s.passive = true;
        }
      }
      return originalInitBattle.call(this, starters);
    });

    game.override.moveset(starterMoves);
    await game.classicMode.startBattle(SpeciesId.YVELTAL);
    game.override.moveset([]);

    const yveltal = game.scene.getPlayerParty()[0];
    console.info(
      `[Climb] Starter summoned: ${yveltal.species.name}, moves: ${yveltal.moveset.map(m => m.moveId).join(", ")}, passive: ${yveltal.passive}`,
    );

    const logs: { wave: number; payload: string; head: string }[] = [];
    let head = "";
    let oblivionWingLearned = false;
    let itemCounter = 0;

    // Helper for anchor submission
    async function sendAnchor(wave: number, headHash: string) {
      const res = await realFetch(`${serverUrl}/pvp/anchors`, {
        method: "POST",
        headers: {
          Authorization: token!,
          "Content-Type": "application/json",
          "PKR-Client-Version": gameVersion,
        },
        body: JSON.stringify({
          runId,
          wave,
          head: headHash,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Anchor failed wave ${wave}: ${err}`);
      } else {
        console.info(`[Climb] Anchor sent wave ${wave} (head: ${headHash.slice(0, 10)}...)`);
      }
    }

    // 3. 1..200 Wave Loop
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

      let inventory = serialCopy(game.scene.gameData.getSessionSaveData().modifiers);
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

      // Dynamic Party Building & Upgrade:
      // Fill party up to 6 members, and dynamically swap out weaker members for stronger wild Pokemon!
      const currentParty = game.scene.getPlayerParty();
      if (
        wave > 1
        && (generated.battleType ?? 0) === 0
        && (generated.mysteryEncounterType ?? -1) < 0
        && game.scene.getEnemyParty().length > 0
      ) {
        const enemy = game.scene.getEnemyParty()[0];
        const enemyBst = enemy.species.baseTotal;

        if (currentParty.length < 6) {
          const caught = enemy.addToParty(PokeballType.POKEBALL);
          if (caught) {
            frame.captures.push({
              pokemon: serialCopy(new PokemonData(caught)),
              source: "AttemptCapturePhase",
            });
            console.info(
              `[Capture] Wave ${wave}: Caught wild ${caught.species.name} (BST ${caught.species.baseTotal}, Lv.${caught.level})! Party size: ${game.scene.getPlayerParty().length}/6`,
            );
          }
        } else {
          // Party has 6 members. Find weakest member in slots 1..5 (exclude Yveltal at slot 0)
          let lowestIdx = 1;
          let lowestBst = currentParty[1].species.baseTotal;
          for (let i = 2; i < currentParty.length; i++) {
            if (currentParty[i].species.baseTotal < lowestBst) {
              lowestBst = currentParty[i].species.baseTotal;
              lowestIdx = i;
            }
          }

          // If wild enemy is notably stronger (at least 20 BST higher, or >= 480 BST and higher than weakest)
          if (enemyBst > lowestBst + 20 || (enemyBst >= 480 && enemyBst > lowestBst)) {
            const released = currentParty[lowestIdx];
            game.scene.removePartyMemberModifiers(lowestIdx);
            game.scene.getPlayerParty().splice(lowestIdx, 1);
            released.destroy();

            const caught = enemy.addToParty(PokeballType.POKEBALL);
            if (caught) {
              frame.captures.push({
                pokemon: serialCopy(new PokemonData(caught)),
                source: "AttemptCapturePhase",
              });
              console.info(
                `[Party Upgrade] Wave ${wave}: Upgraded! Replaced ${released.species.name} (BST ${lowestBst}) -> ${caught.species.name} (BST ${enemyBst}, Lv.${caught.level})!`,
              );
            }
          }
        }
      }

      // Level up all party members within current wave's legal cap
      for (const member of game.scene.getPlayerParty()) {
        member.addExp(1e12);
        member.calculateStats();
      }

      // Check level-up move replacement: Sludge Wave (482) -> Oblivion Wing (613) at level >= 70
      if (!oblivionWingLearned && yveltal.level >= 70) {
        const sludgeIdx = yveltal.moveset.findIndex(m => m.moveId === MoveId.SLUDGE_WAVE);
        if (sludgeIdx !== -1) {
          yveltal.moveset[sludgeIdx] = new PokemonMove(MoveId.OBLIVION_WING);
          oblivionWingLearned = true;
          console.info(
            `[Climb] Wave ${wave} (Lv.${yveltal.level}): Replaced Sludge Wave (482) with Oblivion Wing (613)! Current moves: ${yveltal.moveset.map(m => m.moveId).join(", ")}`,
          );
        }
      }

      // Non-mystery encounter battle resolution & shop
      if ((generated.mysteryEncounterType ?? -1) < 0) {
        // This harness skips campaign combat. Do not manufacture a trainer
        // payout for a battle that was not played; free rewards remain usable.

        source = "BattleEndPhase";
        const end = new BattleEndPhase(true);
        vi.spyOn(end, "end").mockImplementation(() => {
          frame.items.push({ kind: "battle-end", source: "BattleEndPhase" });
          state(true);
        });
        end.start();

        if (wave % 10 !== 0) {
          const phase = new SelectModifierPhase(
            0,
            undefined,
            game.scene.gameMode.getFixedBattle(wave)?.customModifierRewardSettings,
          );
          phase.start();
          const options = Reflect.get(phase, "typeOptions") as ModifierTypeOption[];

          const getOptionPriority = (option: ModifierTypeOption): number => {
            const type = option.type;
            const id = type.id ?? "";

            // Top Priority: Dynamax, Mega Evolution, DNA Splicers
            if (id === "DNA_SPLICERS") {
              return game.scene.getPlayerParty().length >= 3 ? 10000 : -1;
            }
            if (id === "MEGA_BRACELET" || id === "DYNAMAX_BAND") {
              return 10000;
            }
            if (type instanceof FormChangeItemModifierType) {
              return 10000;
            }
            if (id === "TERA_ORB") {
              return 9000;
            }

            // High Priority: Stat Boosters / Vitamins
            if (
              id === "CALCIUM"
              || id === "CARBOS"
              || id === "PROTEIN"
              || id === "HP_UP"
              || id === "ZINC"
              || id === "IRON"
              || id === "PP_UP"
              || id === "PP_MAX"
              || type instanceof BaseStatBoosterModifierType
            ) {
              return 5000;
            }

            // High Priority: Battle Held Items
            if (
              id === "FOCUS_BAND"
              || id === "KINGS_ROCK"
              || id === "MULTI_LENS"
              || id === "WIDE_LENS"
              || id === "LEFTOVERS"
              || id === "SHELL_BELL"
              || id === "SOUL_DEW"
              || id === "GOLDEN_PUNCH"
              || id === "AMULET_COIN"
            ) {
              return 3500;
            }

            // Medium Priority: Berries / Other persistent modifiers
            const item = rewardInventoryItem(optionData(option));
            if (item && !item.lifetime) {
              return 1000;
            }

            return -1;
          };

          let bestIdx = -1;
          let bestPriority = -1;
          for (let i = 0; i < options.length; i++) {
            const prio = getOptionPriority(options[i]);
            if (prio > bestPriority) {
              bestPriority = prio;
              bestIdx = i;
            }
          }

          if (bestIdx >= 0) {
            shop(
              serialCopy({
                kind: "offer",
                ...shopSettings(phase),
                locked: game.scene.lockModifierTiers,
                session: game.scene.gameData.getSessionSaveData(),
                options: options.map(optionData),
              }),
            );
            shop({ rowCursor: 1, cursor: bestIdx, rerolls: shopSettings(phase).rerolls });
            source = "SelectModifierPhase";
            const selected = options[bestIdx].type;
            const party = game.scene.getPlayerParty();

            if (selected instanceof FusePokemonModifierType) {
              if (party.length >= 3) {
                const p1 = party[1];
                const p2 = party[2];
                await p1.fuse(p2);
                game.scene.phaseManager.clearPhaseQueue();
                console.info(
                  `[DNA Splicers] Fused ${p1.species.name} with ${p2.species.name}! (Party size: ${game.scene.getPlayerParty().length})`,
                );
              }
            } else if (selected instanceof FormChangeItemModifierType) {
              const target = party.find(p => !selected.selectFilter || selected.selectFilter(p) === null) ?? party[0];
              game.scene.addModifier(selected.newModifier(target), true);
              console.info(`[Form Change] Acquired ${selected.name} for ${target.species.name}!`);
            } else if (
              selected.id === "MEGA_BRACELET"
              || selected.id === "DYNAMAX_BAND"
              || selected.id === "TERA_ORB"
              || !(selected instanceof PokemonModifierType)
            ) {
              game.scene.addModifier(selected.newModifier(), true);
              console.info(`[Transformation/Key Item] Acquired ${selected.name} (${selected.id})!`);
            } else {
              const eligibleTarget =
                party.find(p => !selected.selectFilter || selected.selectFilter(p) === null)
                ?? party[itemCounter++ % party.length];
              game.scene.addModifier(selected.newModifier(eligibleTarget), true);
              console.info(`[Item] Wave ${wave}: Acquired ${selected.name} for ${eligibleTarget.species.name}`);
            }
          }
        }
      }

      addSpy.mockRestore();

      // Compress and chain hash
      const payload = `gz:${gzipSync(JSON.stringify(frame)).toString("base64")}`;
      head = createHash("sha256").update(`${head}\n${payload}`).digest("hex");
      logs.push({ wave, payload, head });

      // Anchor pacing: 100ms per wave rate limit on Go server
      if (wave % 5 === 0 || wave === 200) {
        // Sleep 550ms for 5 waves to comfortably satisfy wave arrival quota
        await new Promise(r => setTimeout(r, 550));
        await sendAnchor(wave, head);
      }

      if (wave === 200) {
        break;
      }

      // Next wave transition
      game.scene.phaseManager.clearPhaseQueue();
      game.scene.clearEnemyHeldItemModifiers();
      if (wave % 10 === 0) {
        game.scene.newArena(wave >= 190 ? BiomeId.END : BiomeId.PLAINS);
      }
      game.scene.newBattle();

      let saved = false;
      vi.spyOn(game.scene.gameData, "saveAll").mockRestore();
      vi.spyOn(GameData.prototype, "saveAll").mockImplementation(async () => {
        saved = true;
        return new Promise<boolean>(() => {});
      });
      const Phase = wave % 10 === 0 ? NewBiomeEncounterPhase : NextEncounterPhase;
      new Phase(false).start();
      await vi.waitUntil(() => saved, { timeout: 10000, interval: 1 });
    }

    expect(logs).toHaveLength(200);
    expect(oblivionWingLearned).toBe(true);
    console.info(`[Climb] All 200 waves completed. Oblivion Wing learned: ${oblivionWingLearned}`);

    // 4. Submit session clear to trigger ObserveClear on server
    const sessionCandidate = { ...serialCopy(game.scene.gameData.getSessionSaveData()), battleType: BattleType.CLEAR };
    sessionCandidate.seed = runSeed;
    sessionCandidate.gameVersion = gameVersion;
    sessionCandidate.gameMode = 0;
    sessionCandidate.waveIndex = 200;
    sessionCandidate.battleType = BattleType.CLEAR; // 2 (Clear sentinel required by ObserveClear)
    if (process.env.PVP_AUTOMATION_SEED_OUTPUT) {
      writeFileSync(
        process.env.PVP_AUTOMATION_SEED_OUTPUT.replace(/seed\.json$/, `climb-${targetUsername}-${process.env.PVP_AUTOMATION_RUN_ID || "1"}.local.json`),
        JSON.stringify({
          manifest: rulesManifest,
          run: { ...runData, version: gameVersion, candidate: sessionCandidate },
          logs,
        }),
      );
    }

    // Preflight the generated party with the real verifier before submitting
    // a registration. No campaign save is changed.
    const verifyUrl = process.env.PVP_AUTOMATION_VERIFY_URL;
    if (!verifyUrl) throw new Error("PVP_AUTOMATION_VERIFY_URL is required");
    const preflightStatus = await realFetch(`${serverUrl}/pvp/status`, { headers: { Authorization: token!, "PKR-Client-Version": gameVersion } });
    expect(preflightStatus.ok).toBe(true);
    const preflightState = await preflightStatus.json();
    const persistedRun = preflightState.runs?.[runId];
    expect(persistedRun, "ranked run missing before audit").toBeTruthy();
    const auditKey = readFileSync(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
    const auditToken = createHmac("sha256", auditKey).update("pvp-audit-v1").digest("hex");
    const preflightResponse = await realFetch(`${verifyUrl}/verify`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auditToken}` },
      body: JSON.stringify({ run: { ...persistedRun, candidate: sessionCandidate }, logs, manifest: rulesManifest }),
      signal: AbortSignal.timeout(180000),
    });
    expect(preflightResponse.ok, `Verifier unavailable: HTTP ${preflightResponse.status}`).toBe(true);
    const preflight = await preflightResponse.json();
    if (process.env.PVP_AUTOMATION_PREFLIGHT_OUTPUT) {
      writeFileSync(process.env.PVP_AUTOMATION_PREFLIGHT_OUTPUT, JSON.stringify({ ok: preflight.ok, reason: preflight.reason, runId }));
    }
    if (!preflight.ok) throw new Error(`PREFLIGHT_REJECTED: ${preflight.reason}`);
    expect(preflight.policy).toBe(runContract.auditPolicy);
    expect([preflight.partyVerified, preflight.inventoryVerified, preflight.formItemsVerified, preflight.levelsVerified, preflight.moneyVerified].every(Boolean)).toBe(true);
    console.info("[Climb] Full audit preflight passed; submitting automatic registration.");

    const clearRes = await realFetch(
      `${serverUrl}/savedata/session/clear?${new URLSearchParams({ slot: process.env.PVP_SAFE_SLOT || "4", clientSessionId: process.env.PVP_CLIENT_SESSION_ID || "auto-climb", pvpCandidateOnly: "1" })}`,
      {
        method: "POST",
        headers: {
          Authorization: token!,
          "Content-Type": "application/json",
          "PKR-Client-Version": gameVersion,
        },
        body: JSON.stringify(sessionCandidate),
      },
    );
    const clearText = await clearRes.text();
    expect(clearRes.ok, `Session clear failed: ${clearText}`).toBe(true);
    console.info(`[Climb] Candidate saved without changing an ordinary save slot: ${clearText}`);

    // Use the same automatic registration helper as the game's clear flow.
    vi.spyOn(account, "loggedInUser", "get").mockReturnValue({ username: targetUsername } as NonNullable<typeof account.loggedInUser>);
    vi.spyOn(pvpState, "pvpEnabled", "get").mockReturnValue(true);
    vi.spyOn(pvpApi, "request").mockImplementation(async (path, body, source) => {
      const headers: Record<string, string> = { Authorization: token!, "Content-Type": "application/json", "PKR-Client-Version": gameVersion };
      if (source) headers["PKR-PVP-Source-Version"] = source;
      const res = await realFetch(`${serverUrl}/pvp/${path}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    });
    const key = `pvp:run:${targetUsername}:${runId}`;
    localStorage.setItem(key, JSON.stringify({ id: runId, seed: runSeed, logs, anchored: 200 }));
    Object.defineProperty(localStorage, key, { value: true, enumerable: true, configurable: true });
    registerClearedRun(sessionCandidate as unknown as Parameters<typeof registerClearedRun>[0], targetUsername);
    console.info(`[Climb] Automatic registration submitted. Waiting for this party's audit...`);

    // 6. Poll status until registered
    let registered = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const statusRes = await realFetch(`${serverUrl}/pvp/status`, {
        headers: { Authorization: token!, "PKR-Client-Version": gameVersion },
      });
      const status = await statusRes.json();
      if (status.audit?.runId === runId && status.audit.status === "approved") {
        const teamRes = await realFetch(`${serverUrl}/pvp/teams`, { headers: { Authorization: token!, "PKR-Client-Version": gameVersion } });
        expect(teamRes.ok).toBe(true);
        const teams = await teamRes.json();
        expect(teams.some((team: { id: string }) => team.id === runId), "approved run missing from registered parties").toBe(true);
        registered = true;
        console.info(`[SUCCESS] Account '${targetUsername}' is now fully registered in PvP streak!`);
        const finalPartyInfo = sessionCandidate.party
          .map(
            (p: any, idx: number) =>
              `${idx + 1}. #${p.species} (Lv.${p.level}${p.fusionSpecies ? ` [Fused with #${p.fusionSpecies}]` : ""})`,
          )
          .join(", ");
        console.info(`[SUCCESS] Final Party (${sessionCandidate.party.length} members): ${finalPartyInfo}`);
        console.info(`[SUCCESS] Equipped Modifiers: ${sessionCandidate.modifiers.length} total items`);
        break;
      }
      if (status.audit?.runId === runId && status.audit.status === "rejected") {
        throw new Error(`Audit rejected: ${status.audit.reason}`);
      }
      if (status.flags && status.flags.length > 0) {
        throw new Error(`Account flagged during audit: ${JSON.stringify(status.flags)}`);
      }
      console.info(`[Climb] Waiting for audit approval... (${i + 1}/60) status: ${status.audit?.status ?? "waiting"}`);
      if (i % 10 === 9) retryPendingRegistrations();
    }

    expect(registered).toBe(true);
    if (process.env.PVP_AUTOMATION_RUN_OUTPUT) {
      writeFileSync(process.env.PVP_AUTOMATION_RUN_OUTPUT, JSON.stringify({ username: targetUsername, runId, registered: true, partySize: sessionCandidate.party.length }));
    }
  }, 180000);
});
