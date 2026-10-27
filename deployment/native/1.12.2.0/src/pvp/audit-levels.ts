// SPDX-License-Identifier: AGPL-3.0-only
import { AuditInputError } from "./audit-errors";
import type { InventoryData } from "./inventory-ledger";

interface Candy {
  eligible: Set<number>;
  used: boolean;
  authorize: () => boolean;
}
interface Growth {
  owner: number;
  amount: number;
  candies: Candy[];
}
/** Battle EXP stops at the native wave cap. Candy is applied immediately;
 * unused choices cannot be banked into a later wave or spent on two owners.
 * Reserve the choices visible at each checkpoint before deferring jar checks
 * until the ordered physical inventory stream has been verified. */
export class LevelAudit {
  private cap: number | undefined;
  private candies: Candy[] = [];
  private pending: Growth[] = [];
  constructor(private readonly inventory?: (owner: number) => readonly InventoryData[]) {}
  begin(cap?: number): void {
    this.finish();
    if (cap != null && (!Number.isSafeInteger(cap) || cap < 1)) {
      throw new AuditInputError("party provenance: invalid native experience cap");
    }
    this.cap = cap;
    this.candies = [];
  }
  reward(eligible: ReadonlySet<number>, entireParty: boolean, authorize = () => true): void {
    if (entireParty) {
      for (const id of eligible) {
        this.candies.push({ eligible: new Set([id]), used: false, authorize });
      }
    } else {
      this.candies.push({ eligible: new Set(eligible), used: false, authorize });
    }
  }
  observe(owner: number, before: number, after: number): void {
    if (this.cap == null) {
      return;
    }
    const amount = after - Math.max(before, this.cap);
    if (amount <= 0) {
      return;
    }
    const candies = this.candies.filter(candy => !candy.used && candy.eligible.has(owner));
    if (candies.length === 0) {
      throw new AuditInputError("party provenance: level increase has no certified candy source");
    }
    this.pending.push({ owner, amount, candies });
  }
  finish(): void {
    for (const growth of this.pending) {
      const jars = (this.inventory?.(growth.owner) ?? [])
        .filter(item => item.typeId === "CANDY_JAR" && item.className === "LevelIncrementBoosterModifier")
        .map(item => item.stackCount);
      const boost = 1 + Math.max(0, ...jars);
      let needed = growth.amount;
      for (const candy of growth.candies) {
        if (!candy.used && candy.authorize()) {
          candy.used = true;
          needed -= boost;
          if (needed <= 0) {
            break;
          }
        }
      }
      if (needed > 0) {
        throw new AuditInputError("party provenance: level increase exceeds certified candy and Candy Jar budget");
      }
    }
    this.pending = [];
  }
}
