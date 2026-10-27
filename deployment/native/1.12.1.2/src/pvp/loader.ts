// SPDX-License-Identifier: AGPL-3.0-only
import type { GameData } from "#system/game-data";
import type { SessionSaveData } from "#types/save-data";

/** Reuse the upstream loader without widening its public API. */
export async function loadSession(gameData: GameData, data: SessionSaveData): Promise<void> {
  const initialize = Reflect.get(gameData, "initSessionFromData");
  if (typeof initialize !== "function") {
    throw new Error("upstream session loader changed");
  }
  await initialize.call(gameData, data);
}
