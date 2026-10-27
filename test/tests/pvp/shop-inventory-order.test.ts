// SPDX-License-Identifier: AGPL-3.0-only
import { modifierTypes } from "#data/data-lists";
import { SpeciesId } from "#enums/species-id";
import { generateModifierType } from "#mystery-encounters/encounter-phase-utils";
import { ModifierData } from "#system/modifier-data";
import { GameManager } from "#test/framework/game-manager";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalItem, InventoryAudit } from "../../../src/pvp/audit-inventory";
import { auditItemLedger } from "../../../src/pvp/audit-item-ledger";
import { serialCopy } from "../../../src/pvp/generation";
import type { ItemRecord } from "../../../src/pvp/inventory-ledger";
import type { ShopOffer, ShopRecord } from "../../../src/pvp/shop";

describe("Shop snapshots use the inventory available before that choice", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
  });
  function records() {
    const data = new ModifierData(generateModifierType(modifierTypes.MAP)!.newModifier(), true);
    const offer: ShopOffer = {
      kind: "offer",
      session: serialCopy(game.scene.gameData.getSessionSaveData()),
      options: [],
      rerolls: 0,
      special: false,
      copy: false,
      locked: false,
    };
    const shops: ShopRecord[] = [offer, { rowCursor: 1, cursor: 0, rerolls: 0 }];
    const events: ItemRecord[] = [
      { kind: "shop", index: 0, source: "SelectModifierPhase" },
      { kind: "shop", index: 1, source: "SelectModifierPhase" },
      { kind: "acquire", data, source: "SelectModifierPhase" },
      { kind: "state", changes: [{ data, delta: 1 }], source: "SelectModifierPhase" },
      { kind: "battle-end", source: "BattleEndPhase" },
    ];
    const audit = new InventoryAudit();
    audit.begin([{ base: canonicalItem(data).base, count: 1, source: "SelectModifierPhase", availableAfterShop: 1 }]);
    const ids = new Set(game.scene.getPlayerParty().map(p => p.id));
    return { data, offer, shops, events, audit, ids };
  }
  it("accepts the native item only after its verified selection checkpoint", () => {
    const { data, shops, events, audit, ids } = records();
    auditItemLedger(audit, [], events, ids, -1, shops);
    expect(() => audit.observe(game.scene.getPlayerParty(), [data])).not.toThrow();
  });
  it("refuses to use the selected reward to inflate its own initial offer", () => {
    const { data, offer, shops, events, audit, ids } = records();
    offer.session.modifiers = [data];
    expect(() => auditItemLedger(audit, [], events, ids, -1, shops)).toThrow(/certified acquisition/);
  });
  it("rejects an acquisition moved before the player's committed choice", () => {
    const { shops, events, audit, ids } = records();
    const acquisition = events.splice(2, 1)[0];
    events.splice(1, 0, acquisition);
    expect(() => auditItemLedger(audit, [], events, ids, -1, shops)).toThrow(/certified source/);
  });
  it("does not let a later offer hide an item still present in the recorded stock", () => {
    const { offer, shops, events, audit, ids } = records();
    shops.push(serialCopy(offer));
    events.splice(4, 0, { kind: "shop", index: 2, source: "SelectModifierPhase" });
    expect(() => auditItemLedger(audit, [], events, ids, -1, shops)).toThrow(/shop snapshot differs/);
  });
  it("requires every shop record to have one correctly ordered marker", () => {
    const first = records();
    first.events = first.events.filter(event => event.kind !== "shop");
    // Give no early receipt to mask the missing timeline marker's rejection.
    first.events = first.events.filter(event => event.kind !== "acquire" && event.kind !== "state");
    expect(() => auditItemLedger(first.audit, [], first.events, first.ids, -1, first.shops)).toThrow(
      /shop timeline missing/,
    );
    const second = records();
    second.events[1] = { kind: "shop", index: 0, source: "SelectModifierPhase" };
    expect(() => auditItemLedger(second.audit, [], second.events, second.ids, -1, second.shops)).toThrow(
      /shop order mismatch/,
    );
  });
});
