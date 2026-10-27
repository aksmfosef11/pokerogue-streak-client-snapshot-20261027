// SPDX-License-Identifier: AGPL-3.0-only
import { isBattleClient } from "./battle-route";
export const pvpEnabled = import.meta.env.VITE_PVP_ENABLED === "1";
let active = false;
export const isPvpMatchActive = (): boolean => active || (pvpEnabled && isBattleClient());
export function setPvpMatchActive(value: boolean): void {
  active = value;
}
