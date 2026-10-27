// SPDX-License-Identifier: AGPL-3.0-only
import { loggedInUser } from "#app/account";
import { globalScene } from "#app/global-scene";
import { GameModes } from "#enums/game-modes";
import { BattleType } from "#enums/battle-type";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { PersistentModifier } from "#modifiers/modifier";
import type { ModifierTypeOption } from "#modifiers/modifier-type";
import { version } from "#package.json";
import type { SelectModifierPhase } from "#phases/select-modifier-phase";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import type { SessionSaveData, Starter } from "#types/save-data";
import CryptoJS from "crypto-js";
import { pvpApi } from "./api";
import { isBattleClient } from "./battle-route";
import {
  type GenerationCheckpoint,
  generationAfter,
  generationBefore,
  generationResult,
  serialCopy,
} from "./generation";
import { type InventoryData, type ItemRecord, inventoryDelta } from "./inventory-ledger";
import { matchesRunContract, type RunContract, runContract } from "./run-contract";
import { optionData, shopSettings } from "./shop";
import { isPvpMatchActive, pvpEnabled } from "./state";

export interface WaveLog {
  wave: number;
  payload: string;
  head: string;
}
interface Frame {
  wave: number;
  party: unknown[];
  enemyParty: unknown[];
  money: number;
  items: ItemRecord[];
  shops: unknown[];
  captures: { pokemon: PokemonData; source: string; outgoing?: number }[];
  encounterChoice?: { option: number; party: PokemonData[] } | undefined;
  generation?: GenerationCheckpoint | undefined;
  generated?: ReturnType<typeof generationResult> | undefined;
}
interface LocalRun {
  id: string;
  seed: string;
  contract?: RunContract | undefined;
  logs: WaveLog[];
  frame?: Frame | undefined;
  anchored: number;
  inventory?: InventoryData[] | undefined;
  ineligible?: string | undefined;
  autoRegistrationSource?: string | undefined;
}
const prefix = () => `pvp:run:${loggedInUser?.username}:`;
const hash = (text: string) => CryptoJS.SHA256(text).toString();
const summary = (p: PokemonData) => ({
  id: p.id,
  species: p.species,
  formIndex: p.formIndex,
  level: p.level,
  abilityIndex: p.abilityIndex,
  nature: p.nature,
  shiny: p.shiny,
  variant: p.variant,
  fusionSpecies: p.fusionSpecies,
  ivs: p.ivs,
  moves: p.moveset.map(m => m.moveId),
});
let current: LocalRun | undefined;
let owner = "";
let pendingGeneration: GenerationCheckpoint | undefined;
const capturedScenes = new WeakSet<typeof globalScene>();
let loadInstalled = false;
let loading = 0;
export function recording(): boolean {
  return (
    pvpEnabled
    && !loading
    && !current?.ineligible
    && owner === prefix()
    && current?.seed === globalScene.seed
    && globalScene.gameMode.modeId === GameModes.CLASSIC
    && !isPvpMatchActive()
  );
}
/** Installed once at title boot; ordinary and synthetic battles pass through. */
export function installGenerationCapture(): void {
  installJournalLoadHooks();
  if (capturedScenes.has(globalScene) || !pvpEnabled) {
    return;
  }
  const scene = globalScene;
  capturedScenes.add(scene);
  const original = scene.newBattle;
  scene.newBattle = function (data) {
    const recording =
      !loading && !data && !isPvpMatchActive() && this.gameMode.modeId === GameModes.CLASSIC && !!findRun(this.seed);
    const previous = recording ? generationBefore(this) : undefined;
    const result = original.call(this, data);
    if (recording) {
      pendingGeneration = generationAfter(this, previous);
    }
    return result;
  };
  const addPlayer = scene.addPlayerPokemon;
  scene.addPlayerPokemon = function (...args) {
    const pokemon = addPlayer.apply(this, args);
    const source = this.phaseManager.getCurrentPhase().phaseName;
    const encounter = this.currentBattle?.mysteryEncounter;
    const outgoing =
      source === "MysteryEncounterOptionSelectedPhase" && encounter?.encounterType === ME.GLOBAL_TRADE_SYSTEM
        ? encounter.misc.tradedPokemon?.id
        : undefined;
    if (
      current?.seed === this.seed
      && current.frame
      && owner === prefix()
      && !isPvpMatchActive()
      && (source === "AttemptCapturePhase"
        || (this.currentBattle?.isBattleMysteryEncounter()
          && !["TitlePhase", "EncounterPhase", "NextEncounterPhase", "NewBiomeEncounterPhase"].includes(source)))
    ) {
      const frame = current.frame;
      // addPlayerPokemon also constructs summary previews and ME candidates.
      // Their caller inserts real acquisitions into the party synchronously.
      queueMicrotask(() => {
        if (
          !recording()
          || current?.frame !== frame
          || !this.getPlayerParty().includes(pokemon)
          || frame.captures.some(c => c.pokemon.id === pokemon.id)
        ) {
          return;
        }
        frame.captures.push({ pokemon: serialCopy(new PokemonData(pokemon)), source, outgoing });
        persist();
      });
    }
    return pokemon;
  };
  const addModifier = scene.addModifier;
  scene.addModifier = function (...args) {
    try {
      return addModifier.apply(this, args);
    } finally {
      if (args[0] instanceof PersistentModifier && !args[3]) {
        logInventoryState(true);
      }
    }
  };
}
/** Public campaign loads pass here; synthetic PvP/audit sessions use the private
 * loader directly. Never journal the loader's reconstruction as new loot. */
export function installJournalLoadHooks(): void {
  if (loadInstalled || !pvpEnabled) {
    return;
  }
  loadInstalled = true;
  const prototype = Object.getPrototypeOf(globalScene.gameData) as Pick<typeof globalScene.gameData, "loadSession">;
  const original = prototype.loadSession;
  prototype.loadSession = async function (...args) {
    if (!pvpEnabled || isPvpMatchActive()) {
      return original.apply(this, args);
    }
    const account = prefix();
    const scene = globalScene;
    let loaded: boolean;
    loading++;
    try {
      loaded = await original.apply(this, args);
    } finally {
      loading--;
    }
    if (loaded && account === prefix() && scene === globalScene && scene.gameMode.modeId === GameModes.CLASSIC) {
      await restoreJournal(scene.gameData.getSessionSaveData(), account);
    }
    return loaded;
  };
}
async function restoreJournal(data: SessionSaveData, account: string): Promise<void> {
  const run = findRun(data.seed);
  if (!run) {
    return;
  }
  const sameContext = () =>
    prefix() === account
    && globalScene.seed === data.seed
    && globalScene.gameMode.modeId === GameModes.CLASSIC
    && !isPvpMatchActive();
  const reject = (reason: string) => {
    run.ineligible = reason;
    persistRun(run, account);
  };
  try {
    await finalizing.get(run);
    if (!sameContext()) {
      return;
    }
    let frame = run.frame;
    if ((run.logs.at(-1)?.wave ?? 0) >= data.waveIndex) {
      if (run.anchored >= data.waveIndex) {
        reject("이미 서버에 고정된 웨이브보다 이전 세이브를 불러온 런입니다.");
        return;
      }
      const sealed = run.logs.find(log => log.wave === data.waveIndex);
      if (!sealed) {
        throw new Error("reload checkpoint missing");
      }
      const payload = sealed.payload;
      const decoded = payload.startsWith("gz:")
        ? await new Response(
            new Blob([Uint8Array.from(atob(payload.slice(3)), c => c.charCodeAt(0))])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).text()
        : payload;
      if (!sameContext()) {
        return;
      }
      frame = JSON.parse(decoded) as Frame;
      run.logs = run.logs.filter(log => log.wave < data.waveIndex);
    }
    if (!frame?.generation || frame.wave !== data.waveIndex) {
      reject("이 웨이브의 원본 생성 기록을 복원할 수 없습니다.");
      return;
    }
    // A campaign reload rewinds the uncommitted wave, including discarded shop
    // choices and loot. Preserve the original pre-generation proof and chain.
    run.frame = {
      ...frame,
      party: data.party.map(summary),
      enemyParty: data.enemyParty.map(summary),
      money: data.money,
      items: [],
      shops: [],
      captures: [],
    };
    run.inventory = serialCopy(data.modifiers);
    current = run;
    owner = account;
    pendingGeneration = frame.generation;
    persistRun(run, account);
  } catch (error) {
    if (sameContext()) {
      reject(`로컬 기록 복원 실패: ${String(error)}`);
    }
  }
}
const unavailableSeeds = new Set<string>();
const finalizing = new WeakMap<LocalRun, Promise<void>>();
function persistRun(run: LocalRun, account: string): void {
  try {
    localStorage.setItem(account + run.id, JSON.stringify(run));
  } catch (err) {
    unavailableSeeds.add(account + run.seed);
    if (current === run) {
      current = undefined;
    }
    console.warn("연승전 로컬 기록을 저장할 수 없어 이 런은 등록할 수 없습니다.", err);
  }
}
const persist = () => {
  if (current && owner === prefix()) {
    persistRun(current, owner);
  }
};
/** Native type/ability choices depend on selection-time party state and order. */
export function logEncounterChoice(option: number): void {
  if (
    recording()
    && current?.frame
    && [ME.CLOWNING_AROUND, ME.FIERY_FALLOUT].some(
      type => type === globalScene.currentBattle.mysteryEncounter?.encounterType,
    )
  ) {
    current.frame.encounterChoice = {
      option,
      party: globalScene.getPlayerParty().map(p => serialCopy(new PokemonData(p))),
    };
    persist();
  }
}
/** Weird Dream constructs previews during onInit, inserts them in pre-option,
 * then changes their moves/types/nature asynchronously. Journal only the final
 * acquired party when the native option has completed. */
export function logDreamTransformations(): void {
  const encounter = globalScene.currentBattle?.mysteryEncounter;
  if (
    !recording()
    || !current?.frame
    || encounter?.encounterType !== ME.WEIRD_DREAM
    || encounter.selectedOption !== encounter.options[0]
  ) {
    return;
  }
  for (const transformation of encounter.misc.teamTransformations) {
    const pokemon = transformation.newPokemon;
    if (
      globalScene.getPlayerParty().includes(pokemon)
      && !current.frame.captures.some(c => c.pokemon.id === pokemon.id)
    ) {
      current.frame.captures.push({
        pokemon: serialCopy(new PokemonData(pokemon)),
        source: "MysteryEncounterOptionSelectedPhase",
        outgoing: transformation.previousPokemon.id,
      });
    }
  }
  logInventoryState();
  persist();
}
function findRun(seed: string): LocalRun | undefined {
  if (unavailableSeeds.has(prefix() + seed)) {
    return undefined;
  }
  if (current?.seed === seed && owner === prefix() && !current.ineligible) {
    return current;
  }
  for (const key of Object.keys(localStorage).filter(k => k.startsWith(prefix()))) {
    try {
      const r = JSON.parse(localStorage.getItem(key)!) as LocalRun;
      if (r.seed === seed && !r.ineligible) {
        owner = prefix();
        return r;
      }
    } catch {
      /* unavailable local log */
    }
  }
  return undefined;
}
export async function prepareRankedRun(starters: Starter[]): Promise<void> {
  const account = prefix();
  const scene = globalScene;
  const seed = scene.seed;
  const sameContext = () =>
    prefix() === account
    && globalScene === scene
    && scene.seed === seed
    && scene.gameMode.modeId === GameModes.CLASSIC
    && !isPvpMatchActive();
  current = undefined;
  if (!pvpEnabled || globalScene.gameMode.modeId !== GameModes.CLASSIC || isPvpMatchActive()) {
    return;
  }
  try {
    if (!(await globalScene.gameData.saveSystem())) {
      throw new Error("시스템 동기화 실패");
    }
    if (!sameContext()) {
      return;
    }
    const run = await pvpApi.request<{ id: string; seed: string; contract?: unknown }>("runs", {
      version,
      starters,
      contract: runContract,
    });
    if (!sameContext()) {
      return;
    }
    if (!matchesRunContract(run.contract)) {
      throw new Error("연승전 검증 규칙이 변경되었습니다. 게임 화면을 새로고침하세요");
    }
    current = { ...run, contract: run.contract, logs: [], anchored: 0 };
    owner = account;
    persist();
    globalScene.setSeed(run.seed);
    globalScene.resetSeed();
    console.info("연승전 등록 가능한 클래식 런:", run.id);
  } catch (err) {
    if (!sameContext()) {
      return;
    }
    console.warn("비랭크 클래식으로 진행합니다:", err);
    globalScene.ui.showText(`비랭크 클래식: ${String(err)}`, 0);
  }
}
async function finalizeFrame(run: LocalRun, account: string): Promise<void> {
  const pending = finalizing.get(run);
  if (pending) {
    return pending;
  }
  if (!run.frame) {
    return;
  }
  const write = writeFrame(run, account);
  finalizing.set(run, write);
  try {
    await write;
  } finally {
    finalizing.delete(run);
  }
}
async function writeFrame(run: LocalRun, account: string): Promise<void> {
  const frame = run.frame!;
  const stream = new Blob([JSON.stringify(frame)]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const payload = `gz:${btoa(binary)}`;
  run.logs.push({ wave: frame.wave, payload, head: hash(`${run.logs.at(-1)?.head ?? ""}\n${payload}`) });
  if (run.frame === frame) {
    run.frame = undefined;
  }
  persistRun(run, account);
}
export async function recordWave(data: SessionSaveData, sync: boolean): Promise<void> {
  if (!pvpEnabled || isPvpMatchActive() || data.gameMode !== GameModes.CLASSIC) {
    return;
  }
  current = findRun(data.seed);
  if (!current) {
    return;
  }
  const run = current;
  const account = owner;
  if (run.frame && run.frame.wave < data.waveIndex) {
    await finalizeFrame(run, account);
    if (current !== run || prefix() !== account) {
      return;
    }
  }
  if (!current.frame && (current.logs.at(-1)?.wave ?? 0) < data.waveIndex) {
    current.inventory = serialCopy(data.modifiers);
    current.frame = {
      wave: data.waveIndex,
      party: data.party.map(summary),
      enemyParty: data.enemyParty.map(summary),
      money: data.money,
      items: [],
      shops: [],
      captures: [],
      generation: pendingGeneration?.wave === data.waveIndex ? pendingGeneration : undefined,
      generated: generationResult(globalScene),
    };
    persist();
  }
  if (sync) {
    await sendAnchor(run, account);
  }
}
async function sendAnchor(run: LocalRun, account: string, native = false): Promise<void> {
  const last = run.logs.at(-1);
  if (prefix() !== account || !last || run.anchored >= last.wave) {
    return;
  }
  await pvpApi.request("anchors", { runId: run.id, wave: last.wave, head: last.head }, native ? null : undefined);
  run.anchored = Math.max(run.anchored, last.wave);
  persistRun(run, account);
}
function logInventoryState(force = false): void {
  if (!current?.frame || !recording()) {
    return;
  }
  const source = globalScene.phaseManager.getCurrentPhase().phaseName;
  if (source === "TitlePhase" || source === "GameOverPhase") {
    return;
  }
  const next = globalScene.modifiers.filter(m => m.stackCount > 0).map(m => serialCopy(new ModifierData(m, true)));
  const changes = inventoryDelta(current.inventory ?? current.frame.generation?.basis.modifiers ?? [], next);
  if (changes.length > 0 || force) {
    current.frame.items.push({ kind: "state", changes, source });
    current.inventory = next;
    persist();
  }
}
export function logItem(data: ModifierData, source: string, virtual?: boolean): void {
  if (virtual || !current?.frame || !recording() || source === "TitlePhase" || source === "GameOverPhase") {
    return;
  }
  const frame = current.frame;
  logInventoryState();
  if (current?.frame !== frame || !recording()) {
    return;
  }
  // Copy before addModifier merges or mutates stack counts.
  frame.items.push({ kind: "acquire", data: JSON.parse(JSON.stringify(data)), source });
  persist();
}
/** BattleEnd.start applies Pickup before it lapses temporary items. Record this
 * boundary after both, so replay credits the pickup before deducting duration. */
export function logBattleEnd(): void {
  if (!current?.frame || !recording()) {
    return;
  }
  current.frame.items.push({ kind: "battle-end", source: "BattleEndPhase" });
  logInventoryState(true);
}
export function logShop(data: unknown): void {
  if (current?.frame && recording()) {
    const frame = current.frame;
    logInventoryState();
    if (current?.frame !== frame || !recording()) {
      return;
    }
    frame.items.push({ kind: "shop", index: frame.shops.length, source: "SelectModifierPhase" });
    frame.shops.push(data);
    persist();
  }
}
export function logShopOffer(phase: SelectModifierPhase, options: ModifierTypeOption[]): void {
  if (!current?.frame || !recording()) {
    return;
  }
  logShop({
    kind: "offer",
    ...shopSettings(phase),
    locked: globalScene.lockModifierTiers,
    options: options.map(optionData),
    session: globalScene.gameData.getSessionSaveData(),
  });
}
export async function finalizeRun(seed: string): Promise<void> {
  current = findRun(seed);
  if (!current) {
    return;
  }
  const run = current;
  const account = owner;
  await finalizeFrame(run, account);
  await sendAnchor(run, account);
}
export function registrationLogs(id: string): WaveLog[] {
  const raw = localStorage.getItem(prefix() + id);
  if (!raw) {
    throw new Error("이 브라우저에 런 기록이 없습니다. 브라우저 데이터를 지우면 등록할 수 없습니다.");
  }
  const run = JSON.parse(raw) as LocalRun;
  if (run.ineligible) {
    throw new Error(run.ineligible);
  }
  return run.logs;
}

const registering = new Map<string, Promise<boolean>>();
let retryTimer: ReturnType<typeof setInterval> | undefined;

/** Mark a successfully cleared classic run before attempting any network call. */
export function registerClearedRun(data: SessionSaveData, account: string | undefined): void {
  if (!pvpEnabled || !account || loggedInUser?.username !== account || data.gameMode !== GameModes.CLASSIC
    || data.waveIndex !== 200 || !Object.is(data.battleType, BattleType.CLEAR)) return;
  const run = findRun(data.seed);
  if (!run || owner !== prefix()) return;
  run.autoRegistrationSource = data.gameVersion;
  persistRun(run, owner);
  void retryRegistration(run.id, data.gameVersion);
}

/** Queue a previously cleared run only when its journal is present on this device. */
export function queueRegistrationCandidate(id: string, source: string): boolean {
  try {
    const account = prefix();
    const raw = localStorage.getItem(account + id);
    if (!loggedInUser?.username || !raw) return false;
    const run = JSON.parse(raw) as LocalRun;
    if (run.ineligible || run.logs.length !== 200 || run.logs.at(-1)?.wave !== 200) return false;
    run.autoRegistrationSource = source;
    persistRun(run, account);
    void retryRegistration(id, source);
    return true;
  } catch (error) {
    console.warn("클리어 파티 자동 등록 준비 실패:", error);
    return false;
  }
}

function retryRegistration(id: string, source: string): Promise<boolean> {
  const account = prefix(), key = account + id;
  const existing = registering.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw || prefix() !== account) return false;
      const run = JSON.parse(raw) as LocalRun;
      if (run.ineligible || run.autoRegistrationSource !== source) return false;
      if (run.frame?.wave === 200) await finalizeFrame(run, account);
      if (prefix() !== account || run.logs.length !== 200 || run.logs.at(-1)?.wave !== 200) return false;
      if (run.anchored < 200) {
        if (source !== version || isBattleClient()) return false;
        await sendAnchor(run, account, true);
      }
      if (prefix() !== account || run.anchored < 200) return false;
      const status = await pvpApi.request<{ audit?: { status: string; runId?: string }; streakAttempt?: { runId: string } }>("status", undefined, source);
      if (prefix() !== account) return false;
      if (status.audit?.runId === id || status.streakAttempt?.runId === id) {
        run.autoRegistrationSource = undefined;
        persistRun(run, account);
        return true;
      }
      if (status.audit?.status === "pending") return false;
      await pvpApi.request("register", { runId: id, logs: run.logs }, source);
      if (prefix() === account) {
        run.autoRegistrationSource = undefined;
        persistRun(run, account);
      }
      return true;
    } catch (error) {
      console.warn("클리어 파티 자동 등록을 다시 시도합니다:", error);
      return false;
    }
  })();
  registering.set(key, promise);
  void promise.finally(() => registering.delete(key));
  return promise;
}

export function retryPendingRegistrations(): void {
  if (!pvpEnabled || !loggedInUser?.username) return;
  const account = prefix();
  for (const key of Object.keys(localStorage).filter(k => k.startsWith(account))) {
    try {
      const run = JSON.parse(localStorage.getItem(key)!) as LocalRun;
      if (run.autoRegistrationSource) void retryRegistration(run.id, run.autoRegistrationSource);
    } catch { /* A malformed journal must not interrupt the ordinary game. */ }
  }
}

export function installAutoRegistrationRetry(): void {
  retryPendingRegistrations();
  if (retryTimer) return;
  retryTimer = setInterval(retryPendingRegistrations, 30_000);
  window.addEventListener("online", retryPendingRegistrations);
}
