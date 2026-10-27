// SPDX-License-Identifier: AGPL-3.0-only
import { AuditInputError } from "./audit-errors";
import { MAX_AUDIT_MONEY } from "./audit-limits";

interface Income {
  remaining: number;
  authorize: () => boolean;
}
export interface MoneySource {
  income: number;
  repeatedCombatIncome: boolean;
}
function fail(message: string): never {
  throw new AuditInputError(`money provenance: ${message}`);
}
export function validateMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AUDIT_MONEY) {
    fail("invalid native wallet amount");
  }
}
/** Same arithmetic and saturation as native MoneyInterestModifier + addMoney.
 * Actual ownership is supplied by the independently verified item ledger. */
export function compoundMoney(value: number, stacks: number): number {
  validateMoney(value);
  if (!Number.isInteger(stacks) || stacks < 0 || stacks > 5) {
    fail("invalid Coin Case stack count");
  }
  return Math.min(MAX_AUDIT_MONEY, value + Math.floor(value * 0.1 * stacks));
}
/** Source bounds, without replaying campaign combat. Repeating money moves or
 * Golden Punch can farm during combat; only a reproduced/owned source opens
 * that branch. Other increases consume native trainer/event/reward budgets.
 * Spending never replenishes an income budget or an unused reward choice. */
export class MoneyAudit {
  private balance = 0;
  private income: Income[] = [];
  private repeating = false;
  private open = false;
  start(value: number, nativeStartingMoney: number): void {
    validateMoney(value);
    validateMoney(nativeStartingMoney);
    if (value > nativeStartingMoney) {
      fail("starting money exceeds the native classic allowance");
    }
    this.balance = value;
    this.income = [];
    this.repeating = false;
    this.open = false;
  }
  begin(source: MoneySource): void {
    if (this.open) {
      fail("previous wave money was not finalized");
    }
    validateMoney(source.income);
    this.income = [{ remaining: source.income, authorize: () => true }];
    this.repeating = source.repeatedCombatIncome;
    this.open = true;
  }
  reward(amount: number, authorize: () => boolean): void {
    validateMoney(amount);
    this.income.push({ remaining: amount, authorize });
  }
  private earn(amount: number): void {
    if (amount <= 0 || this.repeating) {
      return;
    }
    for (const grant of this.income) {
      if (grant.remaining > 0 && grant.authorize()) {
        const used = Math.min(amount, grant.remaining);
        grant.remaining -= used;
        amount -= used;
        if (amount === 0) {
          return;
        }
      }
    }
    if (amount > 0) {
      fail("increase has no verified income source");
    }
  }
  observe(value: number): void {
    validateMoney(value);
    this.earn(value - this.balance);
    this.balance = value;
  }
  /** Copies/rerolls remain inside the same menu. Combat cannot be farmed
   * between them, and the preceding native menu determines the paid fee. */
  menu(value: number, fee = 0): void {
    validateMoney(value);
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > this.balance) {
      fail("reroll is disabled or exceeds the observed wallet");
    }
    if (value > this.balance - fee) {
      fail("reroll fee was not paid or menu money increased");
    }
    this.balance = value;
  }
  /** Interest happens after the final reward menu, before the next generation
   * checkpoint. Find the least pre-interest balance able to explain the next
   * wallet, then debit its income. This cannot compound an unclaimed reward or
   * grant interest twice by re-observing a checkpoint. */
  finish(value: number, coinCases = 0): void {
    validateMoney(value);
    compoundMoney(0, coinCases);
    if (!this.open) {
      this.observe(value);
      return;
    }
    let minimum = this.balance;
    let maximum = MAX_AUDIT_MONEY;
    if (compoundMoney(minimum, coinCases) < value) {
      while (minimum < maximum) {
        const middle = minimum + Math.floor((maximum - minimum) / 2);
        if (compoundMoney(middle, coinCases) >= value) {
          maximum = middle;
        } else {
          minimum = middle + 1;
        }
      }
      this.earn(minimum - this.balance);
    }
    this.balance = value;
    this.income = [];
    this.repeating = false;
    this.open = false;
  }
}
