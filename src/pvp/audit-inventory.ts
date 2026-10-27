// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import type { Pokemon } from "#field/pokemon";
import {
  LapsingPersistentModifier,
  PersistentModifier,
  PokemonFormChangeItemModifier,
  PokemonHeldItemModifier,
  TempExtraModifierModifier,
} from "#modifiers/modifier";
import { FusePokemonModifierType, ModifierTypeGenerator } from "#modifiers/modifier-type";
import { ModifierData } from "#system/modifier-data";
import type { PokemonData } from "#system/pokemon-data";
import { AuditInputError } from "./audit-errors";
import { validateAuditModifiers } from "./audit-input";
import { serialCopy } from "./generation";
import type { InventoryData } from "./inventory-ledger";
import type { optionData } from "./shop";

type Option = ReturnType<typeof optionData>;
export interface InventoryItem {
  base: string;
  owner?: number | undefined;
  transferable: boolean;
  maximum: number;
  count: number;
  data: InventoryData;
  lifetime?: { maximum: number; remaining: number; extends: boolean; nativeMaximum: number } | undefined;
}
interface Stock {
  item: InventoryItem;
  count: number;
  remaining?: number | undefined;
}
export interface InventoryGrant {
  base?: string | undefined;
  bases?: string[] | undefined;
  typeId?: string | undefined;
  typeIds?: string[] | undefined;
  count: number;
  owners?: Set<number> | undefined;
  source: string;
  claim?: boolean | undefined;
  availableAfterShop?: number | undefined;
  lifetime?: number | "native" | undefined;
  remaining?: number | undefined;
  group?: string | undefined;
  choice?: string | undefined;
  portion?: string | undefined;
  sharedChoice?: boolean | undefined;
  escrow?: { key: string; entries: { owner: number; base: string; count: number }[] } | undefined;
  debit?: { owner: number; bases: string[] } | undefined;
}
function fail(message: string): never {
  throw new AuditInputError(`item provenance: ${message}`);
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Rebuild from the trusted factory, never from the submitted constructor or
 * numeric effect arguments. Inspecting a receipt must not consume game RNG. */
export function canonicalItem(input: InventoryData): InventoryItem {
  validateAuditModifiers([input], "inventory");
  const savedRng = Phaser.Math.RND.state();
  try {
    const factory = modifierTypes[input.typeId];
    let type = factory().withIdFromFunc(factory);
    if (type instanceof ModifierTypeGenerator) {
      // Black Sludge's native type omits getPregenArgs and always defaults to
      // the encounter's fixed 2.5 multiplier. Other generators need a receipt.
      if (!input.typePregenArgs?.length && input.typeId !== "MYSTERY_ENCOUNTER_BLACK_SLUDGE") {
        fail("generated item has no generation arguments");
      }
      type = type.generateType([], input.typePregenArgs) ?? fail("invalid generated item");
      type.id = input.typeId;
    }
    const target = { id: input.args?.[0], ivs: [31, 31, 31, 31, 31, 31] } as Pokemon;
    const expected = type.newModifier(target);
    if (!(expected instanceof PersistentModifier) || expected.constructor.name !== input.className) {
      fail("constructor does not match its item factory");
    }
    if (!equal(new ModifierData(expected, true).typePregenArgs ?? [], input.typePregenArgs ?? [])) {
      fail("generation arguments do not round-trip");
    }
    const held = expected instanceof PokemonHeldItemModifier;
    if (held && (!Number.isSafeInteger(target.id) || target.id < 0 || target.id > 0xffffffff)) {
      fail("invalid held item owner");
    }
    let args = [...(input.args ?? [])];
    let expectedArgs = expected.getArgs();
    let lifetime: InventoryItem["lifetime"];
    if (expected instanceof PokemonFormChangeItemModifier) {
      if (typeof args[2] !== "boolean") {
        fail("invalid form item switch");
      }
      expected.active = args[2];
      expectedArgs = expected.getArgs();
    }
    if (expected instanceof LapsingPersistentModifier) {
      const max = expected.getMaxBattles();
      const remaining = args.at(-1);
      const maximum = args.at(-2);
      const extendsLifetime = expected instanceof TempExtraModifierModifier;
      if (
        !Number.isSafeInteger(maximum)
        || maximum < max
        || maximum > (extendsLifetime ? 1000000 : max)
        || !Number.isSafeInteger(remaining)
        || remaining < 0
        || remaining > maximum
      ) {
        fail("invalid item lifetime");
      }
      lifetime = { maximum, remaining, extends: extendsLifetime, nativeMaximum: max };
      args = args.slice(0, -2);
      expectedArgs = expectedArgs.slice(0, -2);
    }
    if (!equal(args, expectedArgs)) {
      fail("effect arguments do not match the factory");
    }
    const maximum = held ? expected.getMaxHeldItemCount(target) : expected.getMaxStackCount();
    if (input.stackCount > maximum || (input.player !== true && input.player !== false)) {
      fail("stack count exceeds the native item limit");
    }
    if (held) {
      expectedArgs[0] = 0;
    }
    if (expected instanceof PokemonFormChangeItemModifier) {
      expectedArgs[2] = true;
    }
    return {
      base: JSON.stringify([input.typeId, input.typePregenArgs ?? [], input.className, expectedArgs]),
      owner: held ? target.id : undefined,
      transferable: held && expected.isTransferable,
      maximum,
      count: input.stackCount,
      data: serialCopy(input),
      lifetime,
    };
  } catch (error) {
    if (error instanceof AuditInputError) {
      throw error;
    }
    fail(`item construction failed (${String(error)})`);
  } finally {
    Phaser.Math.RND.state(savedRng);
  }
}

export function rewardInventoryItem(option: Option): InventoryItem | undefined {
  const savedRng = Phaser.Math.RND.state();
  try {
    const factory = modifierTypes[option.id];
    if (!factory) {
      fail("unknown reward factory");
    }
    let type = factory().withIdFromFunc(factory);
    if (type instanceof ModifierTypeGenerator) {
      type = type.generateType([], option.args) ?? fail("invalid reward generation arguments");
      type.id = option.id;
    }
    if (type instanceof FusePokemonModifierType) {
      return undefined;
    }
    const value = type.newModifier({ id: 0 } as Pokemon);
    return value instanceof PersistentModifier ? canonicalItem(new ModifierData(value, true)) : undefined;
  } finally {
    Phaser.Math.RND.state(savedRng);
  }
}

/** A checkpoint is allowed to discard or consume stock, but the next checkpoint
 * cannot recreate it. Freely transferable held items share a pool; vitamins and
 * form items stay with their owner, except for an independently proved fusion. */
export class InventoryAudit {
  private stock = new Map<string, Stock>();
  private readonly history = new Map<string, InventoryItem>();
  private readonly aliases = new Map<number, number>();
  private grants: InventoryGrant[] = [];
  private usedGroups = new Map<string, string>();
  private usedPortions = new Set<string>();
  private verifiedEscrows = new Set<string>();
  private observed: InventoryData[] = [];
  private removed = new Map<string, number>();
  private shopIndex = -1;
  reachShop(index: number): void {
    this.shopIndex = index;
  }
  claimChoice(group: string, choice: string): boolean {
    const previous = this.usedGroups.get(group);
    if (previous != null && previous !== choice) {
      return false;
    }
    this.usedGroups.set(group, choice);
    return true;
  }
  claimEncounter(group: string, choice: string): boolean {
    const grant = this.grants.find(g => g.claim && g.count > 0 && g.group === group && g.choice === choice);
    if (!grant) {
      return false;
    }
    this.verifyEscrow(grant);
    if (!this.claimChoice(group, choice)) {
      return false;
    }
    grant.count--;
    return true;
  }
  private verifyEscrow(grant: InventoryGrant): void {
    if (grant.escrow && !this.verifiedEscrows.has(grant.escrow.key)) {
      for (const entry of grant.escrow.entries) {
        if ((this.removed.get(`${entry.base}:${this.origin(entry.owner)}`) ?? 0) < entry.count) {
          fail("reward requires the original stolen inventory to be removed");
        }
      }
      this.verifiedEscrows.add(grant.escrow.key);
    }
  }
  private origin(owner: number): number {
    const seen = new Set<number>();
    while (this.aliases.has(owner)) {
      if (seen.has(owner)) {
        fail("cyclic fusion item ownership");
      }
      seen.add(owner);
      owner = this.aliases.get(owner)!;
    }
    return owner;
  }
  private key(item: InventoryItem): string {
    return `${item.base}:${item.owner == null || item.transferable ? "*" : this.origin(item.owner)}`;
  }
  /** Only physical checkpoints in this wave establish ownership. A receipt for
   * a failed acquisition, or an item discarded in an earlier wave, grants none. */
  provedItems(owner: number): InventoryData[] {
    return [...this.history.values()]
      .filter(item => item.owner == null || this.origin(item.owner) === this.origin(owner))
      .map(item => serialCopy(item.data));
  }
  bindTransfers(transfers: ReadonlyMap<number, number>): void {
    for (const [from, to] of transfers) {
      this.aliases.set(from, to);
    }
    const next = new Map<string, Stock>();
    for (const stock of this.stock.values()) {
      const key = this.key(stock.item);
      const old = next.get(key);
      next.set(key, { item: stock.item, count: stock.count + (old?.count ?? 0), remaining: stock.remaining });
    }
    this.stock = next;
  }
  observe(party: Pick<PokemonData, "id">[], modifiers: InventoryData[], reset = true): void {
    validateAuditModifiers(modifiers, "inventory");
    const ids = new Set(party.map(p => p.id));
    const next = new Map<string, Stock>();
    const perOwner = new Map<string, number>();
    for (const raw of modifiers) {
      const item = canonicalItem(raw);
      if (!raw.player || (item.owner != null && !ids.has(item.owner))) {
        fail("item is not owned by this party");
      }
      const key = this.key(item);
      const holderKey = `${item.base}:${item.owner ?? "global"}`;
      const total = item.count + (perOwner.get(holderKey) ?? 0);
      if (total > item.maximum) {
        fail("split stacks exceed a holder's native limit");
      }
      perOwner.set(holderKey, total);
      if (item.lifetime && item.lifetime.remaining > (this.stock.get(key)?.remaining ?? 0)) {
        fail("item lifetime increased without a certified acquisition");
      }
      next.set(key, { item, count: item.count + (next.get(key)?.count ?? 0), remaining: item.lifetime?.remaining });
    }
    for (const [key, value] of next) {
      const previous = this.stock.get(key)?.count ?? 0;
      const extra = value.count - previous;
      if (extra > 0) {
        const growth =
          previous > 0
          && this.grants.find(
            g =>
              g.source === "growth"
              && g.typeId === value.item.data.typeId
              && g.count >= extra
              && value.item.owner != null
              && g.owners?.has(value.item.owner)
              && (!g.group || this.claimChoice(g.group, g.choice ?? "")),
          );
        if (!growth) {
          fail("inventory increased without a certified acquisition");
        }
        if (reset) {
          growth.count -= extra;
        }
      }
    }
    if (reset) {
      this.recordRemovals(modifiers);
      this.remember(modifiers);
      this.observed = serialCopy(modifiers);
      this.stock = next;
    }
  }
  begin(grants: InventoryGrant[]): void {
    this.shopIndex = -1;
    this.history.clear();
    this.remember(this.observed);
    this.grants = grants.map(g => ({ ...g, owners: g.owners && new Set(g.owners) }));
    this.usedGroups.clear();
    this.usedPortions.clear();
    this.verifiedEscrows.clear();
    this.removed.clear();
  }
  private remember(modifiers: InventoryData[]): void {
    for (const raw of modifiers) {
      const item = canonicalItem(raw);
      const key = `${item.base}:${item.owner ?? "global"}`;
      const previous = this.history.get(key);
      if (!previous || item.count > previous.count) {
        this.history.set(key, item);
      }
    }
  }
  private recordRemovals(next: InventoryData[]): void {
    const totals = (rows: InventoryData[]) => {
      const global = new Map<string, number>();
      const holders = new Map<string, number>();
      for (const row of rows) {
        const item = canonicalItem(row);
        if (item.owner == null) {
          continue;
        }
        global.set(item.base, (global.get(item.base) ?? 0) + item.count);
        const holder = `${item.base}:${this.origin(item.owner)}`;
        holders.set(holder, (holders.get(holder) ?? 0) + item.count);
      }
      return { global, holders };
    };
    const old = totals(this.observed);
    const current = totals(next);
    const reductions = new Map(
      [...old.global].map(([base, count]) => [base, Math.max(0, count - (current.global.get(base) ?? 0))]),
    );
    for (const [holder, count] of old.holders) {
      const base = holder.slice(0, holder.lastIndexOf(":"));
      const lost = Math.min(Math.max(0, count - (current.holders.get(holder) ?? 0)), reductions.get(base) ?? 0);
      if (lost) {
        this.removed.set(holder, (this.removed.get(holder) ?? 0) + lost);
        reductions.set(base, reductions.get(base)! - lost);
      }
    }
  }
  battleEnd(): void {
    for (const [key, stock] of this.stock) {
      if (stock.remaining != null) {
        stock.remaining = Math.max(0, stock.remaining - 1);
        if (stock.remaining === 0) {
          this.stock.delete(key);
        }
      }
    }
  }
  grant(grant: InventoryGrant): void {
    this.grants.push({ ...grant, owners: grant.owners && new Set(grant.owners) });
  }
  acquire(data: InventoryData, source: string, knownIds: ReadonlySet<number>): void {
    if (typeof source !== "string" || !source.endsWith("Phase") || source.length > 80) {
      fail("invalid acquisition phase");
    }
    const item = canonicalItem(data);
    if (!data.player || (item.owner != null && !knownIds.has(item.owner))) {
      fail("unknown acquisition owner");
    }
    const grant = this.grants.find(
      g =>
        !g.claim
        && g.count > 0
        && (g.availableAfterShop == null || g.availableAfterShop <= this.shopIndex)
        && (g.source === source
          || (g.source === "battle"
            && ![
              "SelectModifierPhase",
              "MysteryEncounterOptionSelectedPhase",
              "MysteryEncounterRewardsPhase",
              "ModifierRewardPhase",
            ].includes(source))
          || (g.source === "mystery"
            && ["MysteryEncounterOptionSelectedPhase", "MysteryEncounterRewardsPhase", "ModifierRewardPhase"].includes(
              source,
            )))
        && (g.bases
          ? g.bases.includes(item.base)
          : g.base
            ? g.base === item.base
            : g.typeIds
              ? g.typeIds.includes(item.data.typeId)
              : g.typeId === item.data.typeId)
        && (!g.group
          || !this.usedGroups.has(g.group)
          || (g.choice
            && this.usedGroups.get(g.group) === g.choice
            && (g.sharedChoice || !this.usedPortions.has(`${g.group}:${g.portion}`))))
        && (!g.owners || (item.owner != null && g.owners.has(item.owner))),
    );
    if (grant) {
      const count = Math.min(item.count, grant.count);
      this.verifyEscrow(grant);
      if (grant.debit) {
        let needed = count;
        const keys = grant.debit.bases.map(base => `${base}:${this.origin(grant.debit!.owner)}`);
        if (keys.reduce((sum, key) => sum + (this.removed.get(key) ?? 0), 0) < needed) {
          fail("exchange reward has no discarded source items");
        }
        for (const key of keys) {
          const spent = Math.min(needed, this.removed.get(key) ?? 0);
          this.removed.set(key, (this.removed.get(key) ?? 0) - spent);
          needed -= spent;
        }
      }
      const lifetimeLimit = grant.lifetime === "native" ? item.lifetime?.nativeMaximum : grant.lifetime;
      if (item.lifetime && item.lifetime.maximum > (lifetimeLimit ?? 0)) {
        fail("acquired lifetime exceeds its source");
      }
      if (item.lifetime && grant.remaining != null && item.lifetime.remaining > grant.remaining) {
        fail("transferred item lifetime increased");
      }
      grant.count -= count;
      if (grant.group) {
        this.usedGroups.set(grant.group, grant.choice ?? "");
        this.usedPortions.add(`${grant.group}:${grant.portion}`);
      }
      const key = this.key(item);
      const previous = this.stock.get(key);
      const remaining = item.lifetime
        ? item.lifetime.extends
          ? (previous?.remaining ?? 0) + item.lifetime.remaining
          : Math.max(previous?.remaining ?? 0, item.lifetime.remaining)
        : undefined;
      this.stock.set(key, {
        item,
        count: item.lifetime ? Math.max(count, previous?.count ?? 0) : count + (previous?.count ?? 0),
        remaining,
      });
      return;
    }
    // A transfer has no net creation. Nontransferable items only match after
    // bindTransfers has received a certified fusion ownership mapping.
    if ((this.stock.get(this.key(item))?.count ?? 0) > 0) {
      return;
    }
    fail("acquisition has no certified source");
  }
}
