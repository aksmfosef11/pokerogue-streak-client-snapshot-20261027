// SPDX-License-Identifier: AGPL-3.0-only
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { AuditInputError } from "./audit-errors";
import type { InventoryAudit } from "./audit-inventory";
import { applyInventoryDelta, type InventoryData, type ItemRecord, inventoryDelta } from "./inventory-ledger";
import type { ShopRecord } from "./shop";

export function auditItemLedger(
  audit: InventoryAudit,
  initial: InventoryData[],
  events: ItemRecord[],
  ids: ReadonlySet<number>,
  encounter: number,
  shops: readonly ShopRecord[] = [],
): void {
  if (!Array.isArray(events) || events.length > 4096) {
    throw new AuditInputError("item provenance: invalid event count");
  }
  const party = [...ids].map(id => ({ id }));
  let inventory = initial;
  let ends = 0;
  let shopIndex = 0;
  const maximum = encounter === ME.THE_WINSTRATE_CHALLENGE ? 5 : 1;
  for (const event of events) {
    if (!event || typeof event.source !== "string" || !event.source.endsWith("Phase") || event.source.length > 80) {
      throw new AuditInputError("item provenance: invalid event phase");
    }
    if (event.kind === "shop") {
      if (event.source !== "SelectModifierPhase" || event.index !== shopIndex || !shops[shopIndex]) {
        throw new AuditInputError("item provenance: shop order mismatch");
      }
      const shop = shops[shopIndex];
      if ("kind" in shop && shop.kind === "offer") {
        audit.observe(shop.session.party, shop.session.modifiers, false);
        if (inventoryDelta(inventory, shop.session.modifiers).length > 0) {
          throw new AuditInputError("item provenance: shop snapshot differs from recorded inventory");
        }
      }
      audit.reachShop(shopIndex++);
    } else if (event.kind === "battle-end") {
      if (event.source !== "BattleEndPhase" || ++ends > maximum) {
        throw new AuditInputError("item provenance: excess battle completions");
      }
      audit.battleEnd();
    } else if (event.kind === "state") {
      inventory = applyInventoryDelta(inventory, event.changes);
      audit.observe(party, inventory);
    } else if (event.kind === undefined || event.kind === "acquire") {
      audit.acquire(event.data, event.source, ids);
    } else {
      throw new AuditInputError("item provenance: unknown event kind");
    }
  }
  if (shopIndex !== shops.length) {
    throw new AuditInputError("item provenance: shop timeline missing");
  }
  if (encounter < 0 && ends !== 1) {
    throw new AuditInputError("item provenance: battle completion missing");
  }
}
