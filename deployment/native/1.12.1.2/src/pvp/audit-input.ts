// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { allAbilities, allBiomes, allMoves, modifierTypes } from "#data/data-lists";
// biome-ignore lint/performance/noNamespaceImport: Validate the same serialized constructor lookup used by the upstream loader.
import * as modifiers from "#modifiers/modifier";
import type { GameData } from "#system/game-data";
import type { SessionSaveData } from "#types/save-data";
import { AuditInputError } from "./audit-errors";
import { MAX_AUDIT_ITEMS, MAX_AUDIT_LEVEL, MAX_AUDIT_MONEY } from "./audit-limits";

function invalid(path: string): never {
  throw new AuditInputError(`invalid audit input: ${path}`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path);
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(path);
  }
  return value;
}
function array(value: unknown, min: number, max: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(path);
  }
  return value;
}
function species(value: unknown, form: unknown, path: string): void {
  const id = integer(value, 1, 100000, `${path}.species`);
  if (!Object.hasOwn(speciesDataRegistry.data, id)) {
    invalid(`${path}.species`);
  }
  integer(form, 0, Math.max(0, speciesDataRegistry.getSpecies(id).forms.length - 1), `${path}.formIndex`);
}
function moves(value: unknown, path: string): void {
  for (const [i, entry] of array(value, 0, 4, path).entries()) {
    const move = object(entry, `${path}[${i}]`);
    const id = integer(move.moveId, 0, allMoves.length - 1, `${path}[${i}].moveId`);
    if (!allMoves[id]) {
      invalid(`${path}[${i}].moveId`);
    }
    if (move.ppUp != null) {
      integer(move.ppUp, 0, 3, `${path}[${i}].ppUp`);
    }
    if (move.ppUsed != null) {
      integer(move.ppUsed, 0, 1000, `${path}[${i}].ppUsed`);
    }
    if (move.maxPpOverride != null) {
      integer(move.maxPpOverride, -1, 1000, `${path}[${i}].maxPpOverride`);
    }
  }
}
export function validateAuditParty(value: unknown, path = "party", minimum = 1, uniqueIds = true): void {
  const ids = new Set<number>();
  for (const [i, entry] of array(value, minimum, 6, path).entries()) {
    const name = `${path}[${i}]`;
    const p = object(entry, name);
    const id = integer(p.id, 0, 0xffffffff, `${name}.id`);
    if (uniqueIds && ids.has(id)) {
      invalid(`${name}.duplicate ID`);
    }
    ids.add(id);
    species(p.species, p.formIndex, name);
    integer(p.level, 1, MAX_AUDIT_LEVEL, `${name}.level`);
    integer(p.abilityIndex, 0, 2, `${name}.abilityIndex`);
    integer(p.nature ?? 0, 0, 24, `${name}.nature`);
    integer(p.variant ?? 0, 0, 2, `${name}.variant`);
    for (const field of ["player", "passive", "shiny"]) {
      if (p[field] != null && typeof p[field] !== "boolean") {
        invalid(`${name}.${field}`);
      }
    }
    for (const field of ["ivs", "stats"]) {
      if (p[field] != null) {
        for (const v of array(p[field], 6, 6, `${name}.${field}`)) {
          integer(v, 0, field === "ivs" ? 31 : Number.MAX_SAFE_INTEGER, `${name}.${field}`);
        }
      }
    }
    if (p.fusionSpecies) {
      species(p.fusionSpecies, p.fusionFormIndex, `${name}.fusion`);
      integer(p.fusionAbilityIndex, 0, 2, `${name}.fusionAbilityIndex`);
    }
    moves(p.moveset ?? [], `${name}.moveset`);
    for (const field of ["customPokemonData", "fusionCustomPokemonData"]) {
      if (p[field] == null) {
        continue;
      }
      const custom = object(p[field], `${name}.${field}`);
      for (const key of ["ability", "passive"]) {
        if (custom[key] != null) {
          const ability = integer(custom[key], -1, allAbilities.length - 1, `${name}.${field}.${key}`);
          if (ability >= 0 && !allAbilities[ability]) {
            invalid(`${name}.${field}.${key}`);
          }
        }
      }
      if (custom.types != null) {
        for (const type of array(custom.types, 0, 2, `${name}.${field}.types`)) {
          if (type !== null) {
            integer(type, 0, 17, `${name}.${field}.types`);
          }
        }
      }
    }
    if (p.summonData != null) {
      const summon = object(p.summonData, `${name}.summonData`);
      for (const field of [
        "statStages",
        "moveQueue",
        "tags",
        "abilitiesApplied",
        "stats",
        "types",
        "berriesEatenLast",
        "moveHistory",
      ]) {
        if (summon[field] != null) {
          array(summon[field], 0, 10000, `${name}.summonData.${field}`);
        }
      }
      if (summon.moveset != null) {
        moves(summon.moveset, `${name}.summonData.moveset`);
      }
    }
    if (p.status != null) {
      const status = object(p.status, `${name}.status`);
      integer(status.effect, 0, 7, `${name}.status.effect`);
    }
  }
}
export function validateAuditModifiers(value: unknown, path: string): void {
  for (const [i, entry] of array(value ?? [], 0, MAX_AUDIT_ITEMS, path).entries()) {
    const name = `${path}[${i}]`;
    const item = object(entry, name);
    if (typeof item.typeId !== "string" || !Object.hasOwn(modifierTypes, item.typeId)) {
      invalid(`${name}.typeId`);
    }
    const construct = typeof item.className === "string" && Reflect.get(modifiers, item.className);
    if (typeof construct !== "function" || !(construct.prototype instanceof modifiers.PersistentModifier)) {
      invalid(`${name}.className`);
    }
    integer(item.stackCount, 1, 1000000, `${name}.stackCount`);
    array(item.args ?? [], 0, 32, `${name}.args`);
    array(item.typePregenArgs ?? [], 0, 32, `${name}.typePregenArgs`);
  }
}
/** Validate before upstream constructors dereference registry entries. An invalid
 * receipt is a permanent rejection; worker/environment failures remain retries. */
export function parseAuditSession(gameData: GameData, input: unknown, serverSeed: string): SessionSaveData {
  const data = object(input, "session");
  validateAuditParty(data.party);
  // Some upstream mystery encounters clone an enemy (including its ID).
  // Enemy provenance is matched to replayed generation rather than ID uniqueness.
  validateAuditParty(data.enemyParty ?? [], "enemyParty", 0, false);
  integer(data.waveIndex, 1, 200, "session.waveIndex");
  integer(data.gameMode, 0, 0, "session.gameMode");
  integer(data.money, 0, MAX_AUDIT_MONEY, "session.money");
  integer(data.timestamp, 1, Number.MAX_SAFE_INTEGER, "session.timestamp");
  validateAuditModifiers(data.modifiers, "modifiers");
  validateAuditModifiers(data.enemyModifiers, "enemyModifiers");
  const arena = object(data.arena, "session.arena");
  if (typeof arena.biome !== "number" || !Array.from(allBiomes.keys()).some(id => id === arena.biome)) {
    invalid("session.arena.biome");
  }
  try {
    return gameData.parseSessionData(JSON.stringify({ ...data, seed: serverSeed }));
  } catch (error) {
    throw new AuditInputError(`invalid audit input: session deserialization (${String(error)})`);
  }
}
