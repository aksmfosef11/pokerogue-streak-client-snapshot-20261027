// SPDX-License-Identifier: AGPL-3.0-only

import { modifierTypes } from "#data/data-lists";
import type { ModifierTier } from "#enums/modifier-tier";
import type { CustomModifierSettings, ModifierTypeOption } from "#modifiers/modifier-type";
import type { SelectModifierPhase } from "#phases/select-modifier-phase";
import type { SessionSaveData } from "#types/save-data";

export function optionData(option: ModifierTypeOption) {
  const type = option.type;
  // These consumable types omit getPregenArgs(), but the generated move/nature
  // is still part of the reward being certified.
  const args =
    type.id?.startsWith("TM_") && "moveId" in type
      ? [Reflect.get(type, "moveId")]
      : type.id === "MINT"
        ? [Reflect.get(type, "nature")]
        : "getPregenArgs" in type
          ? (type as { getPregenArgs(): unknown[] }).getPregenArgs()
          : [];
  return {
    id: type.id,
    tier: type.tier,
    cost: option.cost,
    upgradeCount: option.upgradeCount,
    args,
  };
}
export interface ShopOffer {
  kind: "offer";
  session: SessionSaveData;
  rerolls: number;
  tiers?: ModifierTier[] | undefined;
  special: boolean;
  copy: boolean;
  locked: boolean;
  options: ReturnType<typeof optionData>[];
  custom?: SerializedRewardSettings | undefined;
}
export type ShopRecord = ShopOffer | { rowCursor: number; cursor: number; rerolls: number };
export function rewardChoice(option: ReturnType<typeof optionData>): string {
  return JSON.stringify([option.id, option.args]);
}
export interface SerializedRewardSettings {
  tiers: ModifierTier[];
  functions: string[];
  options: ReturnType<typeof optionData>[];
  fill: boolean;
  reroll?: number | undefined;
  luck: boolean;
}
export function rewardSettings(settings: CustomModifierSettings): SerializedRewardSettings {
  return {
    tiers: settings.guaranteedModifierTiers ?? [],
    functions: (settings.guaranteedModifierTypeFuncs ?? []).map(
      fn => Object.keys(modifierTypes).find(id => modifierTypes[id] === fn) ?? "UNSUPPORTED",
    ),
    options: (settings.guaranteedModifierTypeOptions ?? []).map(optionData),
    fill: !!settings.fillRemaining,
    reroll: settings.rerollMultiplier,
    luck: settings.allowLuckUpgrades ?? true,
  };
}
export function shopSettings(phase: SelectModifierPhase) {
  const custom = Reflect.get(phase, "customModifierSettings") as CustomModifierSettings | undefined;
  return {
    rerolls: Reflect.get(phase, "rerollCount") as number,
    tiers: Reflect.get(phase, "modifierTiers") as ModifierTier[] | undefined,
    special: !!custom,
    custom: custom ? rewardSettings(custom) : undefined,
    copy: !!Reflect.get(phase, "isCopy"),
  };
}
