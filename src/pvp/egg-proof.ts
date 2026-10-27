// SPDX-License-Identifier: AGPL-3.0-only
import { loggedInUser } from "#app/account";
import { globalScene } from "#app/global-scene";
import type { Egg, IEggOptions } from "#data/egg";
import { version } from "#package.json";
import type { GameData } from "#system/game-data";
import { randomString } from "#utils/common";
import { pvpApi } from "./api";
import { isPvpMatchActive, pvpEnabled } from "./state";
import { pvpT } from "./i18n";

export interface EggTicket {
  id: string;
  sequence: number;
  seed: string;
  issued: number;
}
export interface EggContext {
  starterPity?: Record<number, number[]>;
  caughtAttrs?: Record<number, string>;
  eggPity: number[];
  unlockPity: number[];
  caught: number[];
  eggs: { id: number; species: number; variantTier?: number }[];
}
export interface EggReceipt {
  id: string;
  ticketId?: string;
  sequence?: number;
  seed?: string;
  options: Omit<IEggOptions, "scene" | "eggDescriptor" | "id">;
  context: EggContext;
  batch?: { id: string; size: number; index: number };
  egg?: Record<string, unknown>;
}
interface ProofStore {
  epoch: number;
  spentThrough: number;
  tickets: EggTicket[];
  receipts: EggReceipt[];
  marks: Record<number, string>;
}
export interface EggRoll {
  seed: string;
  certified: boolean;
  receipt: EggReceipt;
}
let batch: { id: string; size: number; index: number } | undefined;
let refreshing: Promise<void> | undefined;
let replay: EggRoll | undefined;
export function withEggProofReplay<T>(roll: EggRoll, generate: () => T): T {
  const previous = replay;
  replay = roll;
  try {
    return generate();
  } finally {
    replay = previous;
  }
}
const key = () => `pvp:eggs:${Number(version.split(".")[2]) >= 2 ? version + ":" : ""}${loggedInUser?.username}`;
const empty = (): ProofStore => ({ epoch: -1, spentThrough: 0, tickets: [], receipts: [], marks: {} });
function read(): ProofStore {
  try {
    return JSON.parse(localStorage.getItem(key()) ?? "null") ?? empty();
  } catch {
    return empty();
  }
}
function write(value: ProofStore): boolean {
  try {
    localStorage.setItem(key(), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
const enabled = () => pvpEnabled && !!loggedInUser && !isPvpMatchActive();
export function eggContext(data: GameData): EggContext {
  const nativePity = Number(version.split(".")[2]) >= 2;
  return {
    ...(nativePity
      ? {
          starterPity: Object.fromEntries(
            Object.entries(data.starterData).map(([id, entry]) => [id, [...(Reflect.get(entry, "pity") ?? [0, 0])]]),
          ),
          caughtAttrs: Object.fromEntries(
            Object.entries(data.dexData)
              .filter(([, entry]) => !!entry.caughtAttr)
              .map(([id, entry]) => [id, entry.caughtAttr.toString()]),
          ),
        }
      : {}),
    eggPity: [...data.eggPity],
    unlockPity: [...data.unlockPity],
    caught: Object.entries(data.dexData)
      .filter(([, v]) => !!v.caughtAttr)
      .map(([k]) => Number(k))
      .sort((a, b) => a - b),
    eggs: data.eggs.map(e => ({ id: e.id, species: e.species, ...(nativePity ? { variantTier: e.variantTier } : {}) })),
  };
}
export async function refreshEggTickets(reconcile = false): Promise<void> {
  if (!enabled()) {
    return;
  }
  if (refreshing) {
    return refreshing;
  }
  const owner = key();
  refreshing = (async () => {
    const response = await pvpApi.request<{
      epoch: number;
      usedThrough: number;
      tickets: EggTicket[];
      certifiedIds: number[];
    }>("egg-tickets", {});
    if (!enabled() || owner !== key()) {
      return;
    }
    let state = read();
    if (state.epoch !== response.epoch) {
      state = empty();
    }
    state.epoch = response.epoch;
    state.receipts = state.receipts.filter(r => (r.sequence ?? Number.POSITIVE_INFINITY) > response.usedThrough);
    if (reconcile) {
      const stock = new Set(globalScene.gameData.eggs.map(e => e.id));
      state.receipts = state.receipts.filter(r => !!r.egg && stock.has(r.egg.id as number));
      state.spentThrough = Math.max(response.usedThrough, ...state.receipts.map(r => r.sequence ?? 0));
    } else {
      state.spentThrough = Math.max(state.spentThrough, response.usedThrough);
    }
    state.tickets = response.tickets.filter(t => t.sequence > state.spentThrough);
    for (const id of response.certifiedIds) {
      state.marks[id] = pvpT("certified");
    }
    write(state);
  })()
    .catch(error => console.warn("Egg seed ticket: continuing with uncertified local RNG", error))
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}
export function beginEggProof(options: IEggOptions | undefined): EggRoll | undefined {
  if (replay) {
    return replay;
  }
  if (!enabled() || options?.id != null) {
    return;
  }
  const state = read();
  if (state.receipts.length >= 128) {
    return;
  }
  const safe =
    options?.isShiny == null
    && options?.variantTier == null
    && options?.eggMoveIndex == null
    && options?.hatchWaves == null
    && !options?.overrideHiddenAbility;
  const ticket = safe ? state.tickets.shift() : undefined;
  const { scene: _scene, eggDescriptor: _descriptor, id: _id, ...plainOptions } = options ?? {};
  const receipt: EggReceipt = {
    id: crypto.randomUUID(),
    options: { ...plainOptions, timestamp: options?.timestamp ?? Date.now() },
    context: eggContext(globalScene.gameData),
    ...(batch ? { batch: { ...batch, index: batch.index++ } } : {}),
  };
  const seed = ticket?.seed ?? randomString(24);
  if (ticket) {
    receipt.ticketId = ticket.id;
    receipt.sequence = ticket.sequence;
    state.spentThrough = ticket.sequence;
  } else {
    receipt.seed = seed;
  }
  // Reserve the slot before the synchronous constructor runs. No network call.
  state.receipts.push(receipt);
  if (!write(state)) {
    return;
  }
  if (state.tickets.length < 32) {
    void refreshEggTickets();
  }
  return { seed, certified: !!ticket, receipt };
}
export function eggEntropy<T>(proof: EggRoll | undefined, stream: string, generate: () => T): T {
  if (!proof) {
    return generate();
  }
  const original = Math.random;
  let value: T;
  globalScene.executeWithSeedOffset(
    () => {
      Math.random = () => Phaser.Math.RND.frac();
      try {
        value = generate();
      } finally {
        Math.random = original;
      }
    },
    0,
    `${proof.seed}:${stream}`,
  );
  return value!;
}
export function finishEggProof(egg: Egg, proof: EggRoll | undefined): void {
  if (!proof || replay) {
    return;
  }
  const state = read();
  const record = state.receipts.find(r => r.id === proof.receipt.id);
  if (!record) {
    return;
  }
  record.egg = {
    id: egg.id,
    tier: egg.tier,
    sourceType: egg.sourceType,
    hatchWaves: egg.hatchWaves,
    timestamp: egg.timestamp,
    variantTier: egg.variantTier,
    isShiny: egg.isShiny,
    species: egg.species,
    eggMoveIndex: egg.eggMoveIndex,
    overrideHiddenAbility: egg.overrideHiddenAbility,
  };
  state.marks[egg.id] = proof.certified ? pvpT("certified") : pvpT("uncertified");
  write(state);
}
const hookedPrototypes = new WeakSet<object>();
export function installEggProofHooks(gameData: GameData, gachaPrototype: object, eggPrototype: object): void {
  if (!pvpEnabled) {
    return;
  }
  const dataPrototype = Object.getPrototypeOf(gameData);
  if (!hookedPrototypes.has(dataPrototype)) {
    hookedPrototypes.add(dataPrototype);
    const saveData = Reflect.get(dataPrototype, "getSystemSaveData");
    Reflect.set(dataPrototype, "getSystemSaveData", function (this: GameData) {
      const result = saveData.call(this);
      return enabled() ? { ...result, pvpEggProofs: read().receipts.filter(r => r.egg) } : result;
    });
    for (const name of ["saveSystem", "saveAll"]) {
      const save = Reflect.get(dataPrototype, name);
      Reflect.set(dataPrototype, name, async function (this: GameData, ...args: unknown[]) {
        const ids = enabled()
          ? new Set(
              read()
                .receipts.filter(r => r.egg)
                .map(r => r.id),
            )
          : new Set<string>();
        const success = await save.apply(this, args);
        if (success && ids.size > 0) {
          const state = read();
          state.receipts = state.receipts.filter(r => !ids.has(r.id));
          write(state);
          void refreshEggTickets();
        }
        return success;
      });
    }
  }
  if (!hookedPrototypes.has(gachaPrototype)) {
    hookedPrototypes.add(gachaPrototype);
    const pull = Reflect.get(gachaPrototype, "pullEggs");
    Reflect.set(gachaPrototype, "pullEggs", function (this: object, ...args: unknown[]) {
      const previous = batch;
      batch = { id: crypto.randomUUID(), size: Number(args[0]), index: 0 };
      try {
        return pull.apply(this, args);
      } finally {
        batch = previous;
      }
    });
  }
  if (!hookedPrototypes.has(eggPrototype)) {
    hookedPrototypes.add(eggPrototype);
    const descriptor = Reflect.get(eggPrototype, "getEggTypeDescriptor");
    Reflect.set(eggPrototype, "getEggTypeDescriptor", function (this: Egg) {
      const value = descriptor.call(this);
      return enabled() ? `${value} · ${read().marks[this.id] ?? pvpT("uncertified")}` : value;
    });
  }
}
