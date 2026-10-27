// SPDX-License-Identifier: AGPL-3.0-only
// biome-ignore lint/performance/noNamespaceImport: Exercise account changes through the live exported binding.
import * as account from "#app/account";
import { getGameMode } from "#app/game-mode";
import { modifierTypes } from "#data/data-lists";
import { GameModes } from "#enums/game-modes";
import { BattleType } from "#enums/battle-type";
import { SpeciesId } from "#enums/species-id";
import type { PersistentModifier } from "#modifiers/modifier";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { ModifierData } from "#system/modifier-data";
import { GameManager } from "#test/framework/game-manager";
import { initSceneWithoutEncounterPhase } from "#test/utils/game-manager-utils";
import { getModifierType } from "#utils/modifier-utils";
import { Blob as NodeBlob } from "node:buffer";
import {
  CompressionStream as NodeCompressionStream,
  DecompressionStream as NodeDecompressionStream,
} from "node:stream/web";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pvpApi } from "../../../src/pvp/api";
import auditPolicy from "../../../src/pvp/audit-policy.json";
import { generationAfter } from "../../../src/pvp/generation";
import {
  finalizeRun,
  installJournalLoadHooks,
  logItem,
  logShop,
  prepareRankedRun,
  recordWave,
  registrationLogs,
  registerClearedRun,
  retryPendingRegistrations,
} from "../../../src/pvp/log";
import rulesManifest from "../../../src/pvp/rules-manifest.json";
// biome-ignore lint/performance/noNamespaceImport: Same feature gate as the shipped logger.
import * as state from "../../../src/pvp/state";

describe("Ranked journal async account isolation", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let username: string;
  const keys = new Set<string>();
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(() => {
    game = new GameManager(phaser);
    initSceneWithoutEncounterPhase(game.scene, [SpeciesId.BULBASAUR]);
    game.scene.currentBattle.waveIndex = 1;
    username = "journal-alice";
    vi.spyOn(account, "loggedInUser", "get").mockImplementation(
      () => ({ username }) as NonNullable<typeof account.loggedInUser>,
    );
    vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(true);
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("CompressionStream", NodeCompressionStream);
    vi.stubGlobal("DecompressionStream", NodeDecompressionStream);
  });
  afterEach(() => {
    for (const key of keys) {
      localStorage.removeItem(key);
      Reflect.deleteProperty(localStorage, key);
    }
    keys.clear();
    vi.unstubAllGlobals();
  });
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => {
      resolve = r;
    });
    return { promise, resolve };
  };
  async function start(id: string, seed: string) {
    game.scene.setSeed(seed);
    const key = `pvp:run:${username}:${id}`;
    localStorage.setItem(key, JSON.stringify({ id, seed, logs: [], anchored: 0 }));
    // The upstream mock does not expose get/set keys through Object.keys.
    Object.defineProperty(localStorage, key, { value: true, enumerable: true, configurable: true });
    keys.add(key);
    await recordWave(game.scene.gameData.getSessionSaveData(), false);
    return key;
  }
  const read = (key: string) => JSON.parse(localStorage.getItem(key)!);
  function completedJournal(id: string, seed: string) {
    const key = `pvp:run:${username}:${id}`;
    const logs = Array.from({ length: 200 }, (_, i) => ({ wave: i + 1, payload: "proof", head: "a".repeat(64) }));
    localStorage.setItem(key, JSON.stringify({ id, seed, logs, anchored: 200 }));
    Object.defineProperty(localStorage, key, { value: true, enumerable: true, configurable: true });
    keys.add(key);
    const data = game.scene.gameData.getSessionSaveData();
    data.seed = seed;
    data.gameMode = GameModes.CLASSIC;
    data.waveIndex = 200;
    data.battleType = BattleType.CLEAR as typeof data.battleType;
    return { key, data };
  }
  it("automatically submits a confirmed classic clear without manual registration", async () => {
    const { key, data } = completedJournal("auto-clear", "auto-clear-seed");
    const request = vi.spyOn(pvpApi, "request").mockResolvedValue({});
    registerClearedRun(data, username);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("register", expect.objectContaining({ runId: "auto-clear" }), data.gameVersion));
    await vi.waitFor(() => expect(read(key).autoRegistrationSource).toBeUndefined());
  });
  it("retries a completed clear after an offline failure", async () => {
    const { key, data } = completedJournal("auto-retry", "auto-retry-seed");
    let offline = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.spyOn(pvpApi, "request").mockImplementation(async path => {
      if (offline) throw new Error("offline");
      return {};
    });
    registerClearedRun(data, username);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(read(key).autoRegistrationSource).toBe(data.gameVersion);
    offline = false;
    retryPendingRegistrations();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("register", expect.objectContaining({ runId: "auto-retry" }), data.gameVersion));
    await vi.waitFor(() => expect(read(key).autoRegistrationSource).toBeUndefined());
  });
  it("does not submit a previous account's journal after switching accounts", async () => {
    const { data } = completedJournal("auto-account", "auto-account-seed");
    const barrier = deferred<unknown>();
    const request = vi.spyOn(pvpApi, "request").mockImplementation(async path => path === "status" ? barrier.promise : {});
    registerClearedRun(data, username);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    username = "journal-bob";
    barrier.resolve({});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(request.mock.calls.some(([path]) => path === "register")).toBe(false);
  });
  const contract = {
    auditPolicy: auditPolicy.policy,
    rulesSHA256: rulesManifest.rulesSHA256,
    auditSchema: rulesManifest.auditSchema,
    harness: rulesManifest.harness,
  };
  it("binds the issued ranked seed to the bundled audit policy and rules", async () => {
    const scene = game.scene;
    const key = `pvp:run:${username}:contract-current`;
    keys.add(key);
    vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(true);
    const request = vi.spyOn(pvpApi, "request").mockResolvedValue({
      id: "contract-current",
      seed: "contract-seed",
      contract,
    });
    await prepareRankedRun([]);
    expect(request).toHaveBeenCalledExactlyOnceWith("runs", { version: rulesManifest.version, starters: [], contract });
    expect(scene.seed).toBe("contract-seed");
    expect(read(key).contract).toEqual(contract);
  });
  it.each([
    ["missing", undefined],
    ["old policy", { ...contract, auditPolicy: "1.12.1.3:generation-v14" }],
    ["other rules", { ...contract, rulesSHA256: "0".repeat(64) }],
    ["other harness", { ...contract, harness: "other/audit.ts" }],
    ["other schema", { ...contract, auditSchema: contract.auditSchema + 1 }],
  ])("keeps the ordinary classic seed when the server returns %s contract", async (_label, returnedContract) => {
    const scene = game.scene;
    const seed = scene.seed;
    const party = scene.getPlayerParty();
    const key = `pvp:run:${username}:contract-incompatible`;
    keys.add(key);
    vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(true);
    vi.spyOn(pvpApi, "request").mockResolvedValue({
      id: "contract-incompatible",
      seed: "incompatible-seed",
      contract: returnedContract,
    });
    const message = vi.spyOn(scene.ui, "showText");
    await expect(prepareRankedRun([])).resolves.toBeUndefined();
    expect(scene.seed).toBe(seed);
    expect(scene.getPlayerParty()).toBe(party);
    expect(localStorage.getItem(key)).toBeFalsy();
    expect(message.mock.calls.some(([text]) => String(text).includes("비랭크 클래식:"))).toBe(true);
  });
  async function coldJournal(key: string) {
    const run = read(key);
    run.frame.generation = generationAfter(game.scene);
    run.frame.items.push({ kind: "acquire", source: "SelectModifierPhase", data: { typeId: "old-reward" } });
    run.frame.shops.push({ rowCursor: 1, cursor: 0 });
    localStorage.setItem(key, JSON.stringify(run));
    const gate = vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(false);
    await prepareRankedRun([]); // Clear only the in-memory journal, as a fresh page would.
    gate.mockReturnValue(true);
    installJournalLoadHooks();
    return run;
  }
  it("finishes a pending compression in its original account without overwriting the new run", async () => {
    const alice = await start("async-alice", "async-alice-seed");
    const barrier = deferred<void>();
    const ResponseClass = Response;
    vi.stubGlobal(
      "Response",
      class extends ResponseClass {
        override async arrayBuffer() {
          await barrier.promise;
          return super.arrayBuffer();
        }
      },
    );
    const request = vi.spyOn(pvpApi, "request").mockResolvedValue({});
    const pending = finalizeRun("async-alice-seed");
    username = "journal-bob";
    const bob = await start("async-bob", "async-bob-seed");
    const before = localStorage.getItem(bob);
    barrier.resolve();
    await pending;
    expect(read(alice).logs).toHaveLength(1);
    expect(read(alice).frame).toBeUndefined();
    expect(localStorage.getItem(bob)).toBe(before);
    expect(request).not.toHaveBeenCalled();
  });
  it("coalesces concurrent finalization into one gzip frame and one chain entry", async () => {
    const key = await start("async-coalesce", "async-coalesce-seed");
    vi.spyOn(pvpApi, "request").mockResolvedValue({});
    await Promise.all([finalizeRun("async-coalesce-seed"), finalizeRun("async-coalesce-seed")]);
    const run = read(key);
    expect(run.logs).toHaveLength(1);
    expect(run.anchored).toBe(1);
    const frame = JSON.parse(gunzipSync(Buffer.from(run.logs[0].payload.slice(3), "base64")).toString());
    expect(frame.wave).toBe(1);
    expect(frame.party).toHaveLength(1);
    expect(run.logs[0].head).toMatch(/^[a-f0-9]{64}$/);
  });
  it("acknowledges a delayed anchor only in the run that sent it", async () => {
    const alice = await start("async-anchor-alice", "async-anchor-seed");
    const barrier = deferred<object>();
    const request = vi.spyOn(pvpApi, "request").mockImplementation(() => barrier.promise as Promise<any>);
    const pending = finalizeRun("async-anchor-seed");
    await vi.waitUntil(() => request.mock.calls.length === 1);
    username = "journal-bob";
    const bob = await start("async-anchor-bob", "async-bob-anchor-seed");
    const before = localStorage.getItem(bob);
    barrier.resolve({});
    await pending;
    expect(read(alice).anchored).toBe(1);
    expect(localStorage.getItem(bob)).toBe(before);
    expect(request.mock.calls[0][1]).toMatchObject({ runId: "async-anchor-alice", wave: 1 });
  });
  it("ignores a seed issued after the account and ordinary session changed", async () => {
    const barrier = deferred<object>();
    vi.spyOn(game.scene.gameData, "saveSystem").mockResolvedValue(true);
    const request = vi.spyOn(pvpApi, "request").mockImplementation(() => barrier.promise as Promise<any>);
    const pending = prepareRankedRun([]);
    await vi.waitUntil(() => request.mock.calls.length === 1);
    username = "journal-bob";
    game.scene.setSeed("ordinary-bob-session");
    barrier.resolve({ id: "stale-server-run", seed: "stale-server-seed" });
    await pending;
    expect(game.scene.seed).toBe("ordinary-bob-session");
    expect(localStorage.getItem("pvp:run:journal-bob:stale-server-run")).toBeFalsy();
    expect(localStorage.getItem("pvp:run:journal-alice:stale-server-run")).toBeFalsy();
  });
  it("restores an uncommitted campaign wave after a native load and excludes reconstruction loot", async () => {
    const scene = game.scene;
    scene.addModifier(getModifierType(modifierTypes.MAP).newModifier(), true);
    const key = await start("reload-current", "reload-current-seed");
    const saved = scene.gameData.getSessionSaveData();
    const before = await coldJournal(key);
    vi.spyOn(scene.gameData, "getSession").mockResolvedValue(saved);
    expect(await scene.gameData.loadSession(0)).toBe(true);
    const restored = read(key);
    expect(restored.frame.generation).toEqual(before.frame.generation);
    expect(restored.logs).toEqual(before.logs);
    expect(restored.frame.items).toEqual([]);
    expect(restored.frame.shops).toEqual([]);
    expect(restored.inventory).toEqual(JSON.parse(JSON.stringify(saved.modifiers)));
    logItem(new ModifierData(getModifierType(modifierTypes.SHINY_CHARM).newModifier(), true), "SelectModifierPhase");
    expect(read(key).frame.items).toHaveLength(1);
    expect(read(key).frame.items[0].data.typeId).toBe("SHINY_CHARM");
  });
  it("rewinds locally sealed waves after a failed anchor without changing earlier chain entries", async () => {
    const key = await start("reload-unanchored", "reload-unanchored-seed");
    const saved = game.scene.gameData.getSessionSaveData();
    const before = await coldJournal(key);
    await recordWave(saved, false);
    vi.spyOn(pvpApi, "request").mockRejectedValue(new Error("offline anchor"));
    await expect(finalizeRun(saved.seed)).rejects.toThrow("offline anchor");
    expect(read(key).logs).toHaveLength(1);
    vi.spyOn(game.scene.gameData, "getSession").mockResolvedValue(saved);
    expect(await game.scene.gameData.loadSession(0)).toBe(true);
    expect(read(key).logs).toEqual([]);
    expect(read(key).frame.generation).toEqual(before.frame.generation);
    expect(read(key).frame.items).toEqual([]);
  });
  it("keeps ordinary loads playable while refusing to rewrite a server-anchored wave", async () => {
    const key = await start("reload-anchored", "reload-anchored-seed");
    const saved = game.scene.gameData.getSessionSaveData();
    await coldJournal(key);
    await recordWave(saved, false);
    vi.spyOn(pvpApi, "request").mockResolvedValue({});
    await finalizeRun(saved.seed);
    const before = read(key).logs;
    vi.spyOn(game.scene.gameData, "getSession").mockResolvedValue(saved);
    expect(await game.scene.gameData.loadSession(0)).toBe(true);
    expect(read(key).logs).toEqual(before);
    expect(() => registrationLogs("reload-anchored")).toThrow(/서버에 고정된 웨이브/);
    expect(game.scene.getPlayerParty()).toHaveLength(1);
  });
  it.each([GameModes.CHALLENGE, GameModes.ENDLESS, GameModes.SPLICED_ENDLESS, GameModes.DAILY])(
    "does not seed, journal or rewind non-classic mode %i",
    async mode => {
      const key = await start(`mode-${mode}`, `mode-seed-${mode}`);
      await coldJournal(key);
      const before = localStorage.getItem(key);
      const scene = game.scene;
      const data = scene.gameData.getSessionSaveData();
      data.gameMode = mode;
      scene.gameMode = getGameMode(mode);
      // Challenge deliberately shares upstream's isClassic flag. Only its modeId
      // distinguishes it from the campaign mode eligible for ranked registration.
      if (mode === GameModes.CHALLENGE) {
        expect(scene.gameMode.isClassic).toBe(true);
      }
      const request = vi.spyOn(pvpApi, "request").mockResolvedValue({});
      const save = vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(true);
      await prepareRankedRun([]);
      await recordWave(data, true);
      vi.spyOn(scene.gameData, "getSession").mockResolvedValue(data);
      expect(await scene.gameData.loadSession(0)).toBe(true);
      expect(scene.gameMode.modeId).toBe(mode);
      expect(scene.seed).toBe(data.seed);
      expect(request).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(localStorage.getItem(key)).toBe(before);
    },
  );
  it.each(["system", "seed"])("continues the ordinary classic session after %s service failure", async service => {
    const scene = game.scene;
    const seed = scene.seed;
    const save = vi.spyOn(scene.gameData, "saveSystem").mockResolvedValue(service !== "system");
    const request = vi.spyOn(pvpApi, "request").mockRejectedValue(new Error("seed service unavailable"));
    const message = vi.spyOn(scene.ui, "showText");
    await expect(prepareRankedRun([])).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
    if (service === "system") {
      expect(request).not.toHaveBeenCalled();
    } else {
      expect(request).toHaveBeenCalledOnce();
    }
    expect(scene.seed).toBe(seed);
    expect(scene.gameMode.modeId).toBe(GameModes.CLASSIC);
    expect(scene.getPlayerParty()).toHaveLength(1);
    expect(message.mock.calls.some(([text]) => String(text).startsWith("비랭크 클래식:"))).toBe(true);
  });
  it.each(["item", "shop"])(
    "does not interrupt ordinary %s handling when an inventory checkpoint exhausts storage",
    async kind => {
      const scene = game.scene;
      const modifier = getModifierType(modifierTypes.MAP).newModifier() as PersistentModifier;
      scene.addModifier(modifier, true);
      await start(`quota-${kind}`, `quota-seed-${kind}`);
      scene.removeModifier(modifier);
      vi.spyOn(scene.phaseManager, "getCurrentPhase").mockReturnValue(new SelectModifierPhase());
      const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
      expect(() => {
        if (kind === "item") {
          logItem(
            new ModifierData(getModifierType(modifierTypes.SHINY_CHARM).newModifier(), true),
            "SelectModifierPhase",
          );
        } else {
          logShop({ rowCursor: 1, cursor: 0, rerolls: 0 });
        }
      }).not.toThrow();
      expect(write).toHaveBeenCalledOnce();
      expect(scene.getPlayerParty()).toHaveLength(1);
      expect(scene.currentBattle.waveIndex).toBe(1);
      expect(scene.modifiers).toEqual([]);
    },
  );
});
