// SPDX-License-Identifier: AGPL-3.0-only
import type { ModifierData } from "#system/modifier-data";
import { AuditInputError } from "./audit-errors";
import { serialCopy } from "./generation";
export type InventoryData = Omit<ModifierData, "toModifier">;

export interface InventoryDelta {
  data: InventoryData;
  delta: number;
}
export type ItemRecord =
  | { kind?: "acquire"; data: InventoryData; source: string }
  | { kind: "state"; changes: InventoryDelta[]; source: string }
  | { kind: "battle-end"; source: "BattleEndPhase" }
  | { kind: "shop"; index: number; source: "SelectModifierPhase" };

const key = (m: InventoryData) =>
  JSON.stringify([m.player, m.typeId, m.className, m.typePregenArgs ?? [], m.args ?? []]);
function stocks(items: InventoryData[]): Map<string, InventoryData> {
  const result = new Map<string, InventoryData>();
  for (const item of items) {
    const id = key(item);
    const old = result.get(id);
    result.set(id, { ...serialCopy(item), stackCount: item.stackCount + (old?.stackCount ?? 0) });
  }
  return result;
}
/** Raw saved representations are deliberately kept here: a lifetime tick or a
 * form-item toggle is a replacement, and the audit validates its semantics. */
export function inventoryDelta(before: InventoryData[], after: InventoryData[]): InventoryDelta[] {
  const old = stocks(before);
  const next = stocks(after);
  const result: InventoryDelta[] = [];
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const delta = (next.get(id)?.stackCount ?? 0) - (old.get(id)?.stackCount ?? 0);
    if (delta) {
      result.push({ data: { ...(next.get(id) ?? old.get(id))!, stackCount: 1 }, delta });
    }
  }
  return result;
}
export function applyInventoryDelta(before: InventoryData[], changes: InventoryDelta[]): InventoryData[] {
  if (!Array.isArray(changes) || changes.length > 400) {
    throw new AuditInputError("invalid inventory delta count");
  }
  const result = stocks(before);
  for (const change of changes) {
    if (
      !change?.data
      || !Number.isSafeInteger(change.delta)
      || change.delta === 0
      || Math.abs(change.delta) > 1000000
    ) {
      throw new AuditInputError("invalid inventory delta");
    }
    const id = key(change.data);
    const count = (result.get(id)?.stackCount ?? 0) + change.delta;
    if (count < 0 || count > 1000000) {
      throw new AuditInputError("inventory delta removes nonexistent stock");
    }
    if (count === 0) {
      result.delete(id);
    } else {
      result.set(id, { ...serialCopy(change.data), stackCount: count });
    }
  }
  if (result.size > 200) {
    throw new AuditInputError("inventory delta exceeds stock limit");
  }
  return [...result.values()];
}
