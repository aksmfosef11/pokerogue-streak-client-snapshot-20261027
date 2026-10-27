// SPDX-License-Identifier: AGPL-3.0-only
import { settings } from "#app/global-settings-manager";
import { PlayerGender } from "#enums/player-gender";
import type { GameData } from "#system/game-data";

export interface BattlePlayer {
  trainerId: number;
  secretId: number;
  gender: number;
}
export function applyBattlePlayer(data: GameData, identity: BattlePlayer | undefined): void {
  if (identity) {
    data.trainerId = identity.trainerId;
    data.secretId = identity.secretId;
    if (identity.gender === PlayerGender.MALE || identity.gender === PlayerGender.FEMALE) {
      settings.general.playerGender = identity.gender;
    }
  }
  // A battle-only client must not enter the ordinary gender/save setup flow.
  if (settings.general.playerGender === PlayerGender.UNSET) {
    settings.general.playerGender = PlayerGender.MALE;
  }
}
