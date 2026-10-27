// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { FriendshipAudit } from "../../../src/pvp/audit-friendship";

describe("Finite native friendship source budgets", () => {
  it("caps one defeated opponent at the native three-bell maximum, without candy-event multiplication", () => {
    const audit = new FriendshipAudit();
    audit.begin(1, false);
    audit.observe(1, 20, 27);
    audit.finish();
    expect(() => audit.observe(1, 27, 28)).toThrow(/friendship/);
  });
  it("does not refill a spent budget after a friendship loss or unchanged observation", () => {
    const audit = new FriendshipAudit();
    audit.begin(1, false);
    audit.observe(1, 20, 27);
    audit.observe(1, 27, 0);
    audit.observe(1, 0, 0);
    expect(() => audit.observe(1, 0, 1)).toThrow(/friendship/);
  });
  it("does not carry unused battle credit into another wave", () => {
    const audit = new FriendshipAudit();
    audit.begin(6, false);
    audit.begin(0, false);
    expect(() => audit.observe(1, 20, 21)).toThrow(/friendship/);
  });
  it("reserves a Rare Candy for one owner and a Rarer Candy once for each eligible owner", () => {
    const rare = new FriendshipAudit();
    rare.begin(0, false);
    rare.reward(new Set([1, 2]), false, () => true);
    rare.observe(1, 20, 35);
    rare.observe(2, 20, 35);
    expect(() => rare.finish()).toThrow(/friendship/);
    const rarer = new FriendshipAudit();
    rarer.begin(0, false);
    rarer.reward(new Set([1, 2]), true, () => true);
    rarer.observe(1, 20, 35);
    rarer.observe(2, 20, 35);
    expect(() => rarer.finish()).not.toThrow();
    expect(() => rarer.observe(1, 35, 36)).toThrow(/friendship/);
  });
  it("requires a source before the increase and an exclusive verified reward choice", () => {
    const missing = new FriendshipAudit();
    missing.begin(0, false);
    expect(() => missing.observe(1, 20, 35)).toThrow(/friendship/);
    const rejected = new FriendshipAudit();
    rejected.begin(0, false);
    rejected.reward(new Set([1]), false, () => false);
    rejected.observe(1, 20, 35);
    expect(() => rejected.finish()).toThrow(/friendship/);
  });
  it("can allocate candy below its native cap before subsequent battle gains", () => {
    const audit = new FriendshipAudit();
    audit.begin(1, false);
    audit.reward(new Set([1]), false, () => true);
    audit.observe(1, 199, 207); // one capped candy point plus seven battle points
    expect(() => audit.finish()).not.toThrow();
    const excessive = new FriendshipAudit();
    excessive.begin(1, false);
    excessive.reward(new Set([1]), false, () => true);
    expect(() => excessive.observe(1, 199, 208)).toThrow(/friendship/);
  });
  it("does not consume a cancelled candy choice when battle credit explains the increase", () => {
    const audit = new FriendshipAudit();
    audit.begin(1, false);
    let claims = 0;
    audit.reward(new Set([1]), false, () => {
      claims++;
      return false;
    });
    audit.observe(1, 20, 27);
    audit.finish();
    expect(claims).toBe(0);
  });
});
