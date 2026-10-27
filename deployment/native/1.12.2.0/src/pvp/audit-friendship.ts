// SPDX-License-Identifier: AGPL-3.0-only
import { RARE_CANDY_FRIENDSHIP_CAP } from "#app/constants";
import { FRIENDSHIP_GAIN_FROM_BATTLE, FRIENDSHIP_GAIN_FROM_RARE_CANDY } from "#balance/starters";
import { AuditInputError } from "./audit-errors";

interface Candy {
  eligible: Set<number>;
  used: boolean;
  authorize: () => boolean;
}
interface Budget {
  battle: number;
  gained: number;
  capacity: number;
  allocated: number;
  candidates: Set<Candy>;
}
interface Checkpoint {
  budget: Budget;
  needed: number;
  capacity: number;
  candidates: Candy[];
}
const boosted = (value: number) => Math.floor(value * 2.5); // native three-bell maximum
const fail = () => {
  throw new AuditInputError("party provenance: friendship increase has no certified source budget");
};

/** A finite upper bound; campaign combat is not replayed. Event multipliers
 * increase starter candy progress, not this Pokemon's friendship value. */
export class FriendshipAudit {
  private budgets = new Map<number, Budget>();
  private candies: Candy[] = [];
  private checkpoints: Checkpoint[] = [];
  private battle = 0;
  begin(victories: number, breeder: boolean): void {
    this.finish();
    if (!Number.isSafeInteger(victories) || victories < 0 || victories > 6) {
      fail();
    }
    this.battle = boosted(FRIENDSHIP_GAIN_FROM_BATTLE) * victories + (breeder ? boosted(20) : 0);
    this.budgets.clear();
    this.candies = [];
  }
  private budget(owner: number): Budget {
    let value = this.budgets.get(owner);
    if (!value) {
      value = { battle: this.battle, gained: 0, capacity: 0, allocated: 0, candidates: new Set() };
      this.budgets.set(owner, value);
    }
    return value;
  }
  reward(eligible: ReadonlySet<number>, entireParty: boolean, authorize: () => boolean): void {
    if (entireParty) {
      for (const id of eligible) {
        this.candies.push({ eligible: new Set([id]), used: false, authorize });
      }
    } else {
      this.candies.push({ eligible: new Set(eligible), used: false, authorize });
    }
  }
  observe(owner: number, before: number | undefined, after: number | undefined): void {
    if (after == null) {
      return; // old partial component fixtures; native snapshots contain the value
    }
    if (!Number.isSafeInteger(after) || after < 0 || after > 255) {
      fail();
    }
    const gain = Math.max(0, after - (before ?? 0));
    if (gain === 0) {
      return;
    }
    const budget = this.budget(owner);
    budget.gained += gain;
    budget.capacity += Math.min(gain, Math.max(0, RARE_CANDY_FRIENDSHIP_CAP - (before ?? 0)));
    for (const candy of this.candies) {
      if (!candy.used && candy.eligible.has(owner)) {
        budget.candidates.add(candy);
      }
    }
    const needed = Math.max(0, budget.gained - budget.battle);
    const candidates = [...budget.candidates];
    if (
      needed > budget.capacity
      || needed > budget.allocated + candidates.filter(c => !c.used).length * boosted(FRIENDSHIP_GAIN_FROM_RARE_CANDY)
    ) {
      fail();
    }
    this.checkpoints.push({ budget, needed, capacity: budget.capacity, candidates });
  }
  finish(): void {
    for (const point of this.checkpoints) {
      for (const candy of [...point.candidates].sort((a, b) => a.eligible.size - b.eligible.size)) {
        if (point.budget.allocated >= point.needed) {
          break;
        }
        if (!candy.used && candy.authorize()) {
          candy.used = true;
          point.budget.allocated += Math.min(
            boosted(FRIENDSHIP_GAIN_FROM_RARE_CANDY),
            point.capacity - point.budget.allocated,
          );
        }
      }
      if (point.budget.allocated < point.needed) {
        fail();
      }
    }
    this.checkpoints = [];
  }
}
