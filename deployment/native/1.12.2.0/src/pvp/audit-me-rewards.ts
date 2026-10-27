// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import type { ModifierTier } from "#enums/modifier-tier";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import type { PlayerPokemon } from "#field/pokemon";
import { modifierPool } from "#modifiers/modifier-pools";
import { type CustomModifierSettings, ModifierTypeGenerator, ModifierTypeOption } from "#modifiers/modifier-type";
import { AuditInputError } from "./audit-errors";
import { optionData, type SerializedRewardSettings } from "./shop";

type Option = ReturnType<typeof optionData>;
interface OptionBound {
  ids?: string[];
  min: number;
  max: number;
  sequence?: string[];
  args?: unknown[][];
  random?: "trade" | "fight";
}
interface Profile {
  functions?: string[];
  functionPool?: { ids: string[]; count: number };
  options?: OptionBound;
  tiers?: ModifierTier[];
  fill?: boolean;
  reroll?: number;
}
const standard: Profile = { fill: true };
const fixedOptions = (sequence: string[], args?: unknown[][]): OptionBound => ({
  min: sequence.length,
  max: sequence.length,
  sequence,
  ...(args ? { args } : {}),
});
const profiles: Partial<Record<ME, Profile[]>> = {
  [ME.A_TRAINERS_TEST]: [{ functions: ["RELIC_GOLD"], tiers: [3, 3], fill: true }, { reroll: -1 }],
  [ME.ABSOLUTE_AVARICE]: [standard],
  [ME.BERRIES_ABOUND]: [{ options: { min: 0, max: 5, ids: ["BERRY"] } }],
  [ME.BUG_TYPE_SUPERFAN]: [
    standard,
    { functions: ["SUPER_LURE", "GREAT_BALL"] },
    { functions: ["QUICK_CLAW", "MAX_LURE", "ULTRA_BALL"] },
    { functions: ["GRIP_CLAW", "MAX_LURE", "ROGUE_BALL"] },
    {
      options: {
        min: 1,
        max: 4,
        ids: [
          "MASTER_BALL",
          "MEGA_BRACELET",
          "DYNAMAX_BAND",
          "EVOLUTION_ITEM",
          "RARE_EVOLUTION_ITEM",
          "FORM_CHANGE_ITEM",
          "RARE_FORM_CHANGE_ITEM",
        ],
      },
    },
    { options: fixedOptions(["MYSTERY_ENCOUNTER_GOLDEN_BUG_NET"]), functions: ["REVIVER_SEED"] },
  ],
  [ME.CLOWNING_AROUND]: [standard],
  [ME.DANCING_LESSONS]: [{ functions: ["BATON"], fill: true }],
  [ME.DEPARTMENT_STORE_SALE]: [
    { functionPool: { count: 5, ids: ["TM_COMMON", "TM_GREAT", "TM_ULTRA"] } },
    { functionPool: { count: 3, ids: ["PP_UP", "BASE_STAT_BOOSTER"] } },
    { functionPool: { count: 5, ids: ["DIRE_HIT", "TEMP_STAT_STAGE_BOOSTER"] } },
    { functionPool: { count: 4, ids: ["POKEBALL", "GREAT_BALL", "ULTRA_BALL", "ROGUE_BALL"] } },
  ],
  [ME.FIELD_TRIP]: [
    {
      options: fixedOptions(
        ["TEMP_STAT_STAGE_BOOSTER", "TEMP_STAT_STAGE_BOOSTER", "TEMP_STAT_STAGE_BOOSTER", "DIRE_HIT", "RARER_CANDY"],
        [[1], [2], [5], [], []],
      ),
    },
    {
      options: fixedOptions(
        ["TEMP_STAT_STAGE_BOOSTER", "TEMP_STAT_STAGE_BOOSTER", "TEMP_STAT_STAGE_BOOSTER", "DIRE_HIT", "RARER_CANDY"],
        [[3], [4], [5], [], []],
      ),
    },
    {
      options: fixedOptions(
        ["TEMP_STAT_STAGE_BOOSTER", "TEMP_STAT_STAGE_BOOSTER", "GREAT_BALL", "IV_SCANNER", "RARER_CANDY"],
        [[6], [5], [], [], []],
      ),
    },
  ],
  [ME.FIERY_FALLOUT]: [standard],
  [ME.FIGHT_OR_FLIGHT]: [{ options: { min: 1, max: 1, random: "fight" } }],
  [ME.FUN_AND_GAMES]: ["MULTI_LENS", "SCOPE_LENS", "WIDE_LENS"].map(id => ({ functions: [id] })),
  [ME.GLOBAL_TRADE_SYSTEM]: [{ options: { min: 1, max: 1, random: "trade" } }],
  [ME.MYSTERIOUS_CHALLENGERS]: [
    { functions: ["TM_COMMON", "TM_GREAT", "MEMORY_MUSHROOM"], fill: true },
    { tiers: [2, 2, 1, 1], fill: true },
    { tiers: [3, 3, 2, 1], fill: true },
  ],
  [ME.MYSTERIOUS_CHEST]: [{ tiers: [0, 0, 1, 1] }, { tiers: [2, 2, 2] }, { tiers: [3, 3] }, { tiers: [4] }, standard],
  [ME.PART_TIMER]: [standard],
  [ME.SLUMBERING_SNORLAX]: [{ functions: ["LEFTOVERS"], fill: true }, { functions: ["LEFTOVERS"] }],
  [ME.TELEPORTING_HIJINKS]: [
    standard,
    { options: fixedOptions(["ATTACK_TYPE_BOOSTER", "ATTACK_TYPE_BOOSTER"], [[8], [12]]), fill: true },
  ],
  [ME.THE_EXPERT_POKEMON_BREEDER]: [{ functions: ["SOOTHE_BELL"], fill: true }],
  [ME.THE_STRONG_STUFF]: [standard, { functions: ["SOUL_DEW"], fill: true }],
  [ME.THE_WINSTRATE_CHALLENGE]: [
    { functions: ["RARER_CANDY"] },
    { options: fixedOptions(["MYSTERY_ENCOUNTER_MACHO_BRACE"]) },
  ],
  [ME.TRAINING_SESSION]: [standard],
  [ME.TRASH_TO_TREASURE]: [{ functions: ["LEFTOVERS"], tiers: [3, 2, 1], fill: true }],
  [ME.UNCOMMON_BREED]: [standard],
  [ME.WEIRD_DREAM]: [
    { functions: ["MEMORY_MUSHROOM", "ROGUE_BALL", "MINT", "MINT", "MINT", "MINT"] },
    { tiers: [3, 3, 2, 2, 1, 1] },
  ],
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function optionMatches(o: Option, bound: OptionBound, index: number, wave: number): boolean {
  if (bound.sequence && o.id !== bound.sequence[index]) {
    return false;
  }
  if (bound.ids && !bound.ids.includes(o.id)) {
    return false;
  }
  if (bound.args && !equal(o.args, bound.args[index])) {
    return false;
  }
  if (bound.random) {
    if (o.id.includes("TM_") || (bound.random === "fight" && o.id === "CANDY_JAR")) {
      return false;
    }
    const maximumTier = bound.random === "trade" ? 4 : wave > 160 ? 4 : wave > 120 ? 3 : wave > 40 ? 2 : 1;
    if (o.tier == null || o.tier > maximumTier || !modifierPool[o.tier].some(m => m.modifierType.id === o.id)) {
      return false;
    }
  }
  return true;
}
/** ME choices and their random pre-rewards use source-specific bounds, as in
 * multiplan. Once that input is bounded, reward rolls/rerolls use the real engine. */
export function decodeEncounterRewards(
  settings: SerializedRewardSettings,
  encounter: number,
  wave: number,
  party: PlayerPokemon[],
): CustomModifierSettings {
  const fail = (message: string): never => {
    throw new AuditInputError(`encounter reward: ${message}`);
  };
  if (
    !settings
    || !Array.isArray(settings.functions)
    || !Array.isArray(settings.tiers)
    || !Array.isArray(settings.options)
    || settings.functions.length > 16
    || settings.tiers.length > 16
    || settings.options.length > 16
    || settings.luck !== true
  ) {
    fail("settings shape");
  }
  for (const o of settings.options) {
    if (
      !o
      || typeof o.id !== "string"
      || !Object.hasOwn(modifierTypes, o.id)
      || !Number.isInteger(o.tier)
      || o.tier! < 0
      || o.tier! > 4
      || !Number.isInteger(o.upgradeCount)
      || o.upgradeCount !== 0
      || o.cost !== 0
      || !Array.isArray(o.args)
      || o.args.length > 16
      || o.args.some(
        v =>
          !(
            (typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= 100000)
            || (typeof v === "string" && v.length <= 64)
          ),
      )
    ) {
      fail("option shape");
    }
  }
  // The common rewards phase also opens a non-rerollable empty shop after
  // healing in encounters with no explicit reward callback.
  const sourceProfiles =
    Number.isInteger(encounter) && Object.hasOwn(ME, encounter)
      ? [...(profiles[encounter as ME] ?? []), { reroll: -1 }]
      : [];
  const profile = sourceProfiles.find((p: Profile) => {
    const functions = p.functionPool
      ? settings.functions.length === p.functionPool.count
        && settings.functions.every(id => p.functionPool!.ids.includes(id))
      : equal(settings.functions, p.functions ?? []);
    const options = p.options
      ? settings.options.length >= p.options.min
        && settings.options.length <= p.options.max
        && settings.options.every((o, i) => optionMatches(o, p.options!, i, wave))
      : settings.options.length === 0;
    return (
      functions
      && options
      && equal(settings.tiers, p.tiers ?? [])
      && settings.fill === !!p.fill
      && settings.reroll === p.reroll
    );
  });
  if (!profile) {
    fail("source policy mismatch");
  }
  const randomReward = !!profile?.options?.random;
  const functions = settings.functions.map(id => modifierTypes[id] ?? fail("unknown factory"));
  const state = Phaser.Math.RND.state();
  let options: ModifierTypeOption[];
  try {
    options = settings.options.map(o => {
      const factory = modifierTypes[o.id];
      let type = factory().withIdFromFunc(factory).withTierFromPool(ModifierPoolType.PLAYER, party);
      if (!randomReward) {
        const expectedTier =
          o.id === "MYSTERY_ENCOUNTER_GOLDEN_BUG_NET" ? 3 : o.id === "MYSTERY_ENCOUNTER_MACHO_BRACE" ? 4 : type.tier;
        if (o.tier !== expectedTier) {
          fail("pre-generated tier mismatch");
        }
      }
      if (type instanceof ModifierTypeGenerator) {
        type = type.generateType(party, o.args) ?? fail("invalid generated option");
      }
      type.id = o.id;
      type.tier = o.tier!;
      const option = new ModifierTypeOption(type, o.upgradeCount, o.cost);
      if (!equal(optionData(option), o)) {
        fail("generated argument mismatch");
      }
      return option;
    });
  } catch (error) {
    if (error instanceof AuditInputError) {
      throw error;
    }
    fail("option construction failed");
  } finally {
    Phaser.Math.RND.state(state);
  }
  return {
    guaranteedModifierTypeFuncs: functions,
    guaranteedModifierTiers: settings.tiers,
    guaranteedModifierTypeOptions: options!,
    fillRemaining: settings.fill,
    rerollMultiplier: settings.reroll,
    allowLuckUpgrades: settings.luck,
  };
}
