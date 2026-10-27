// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import CryptoJS from "crypto-js";

export function battleDigest(scene: BattleScene): string {
  const party = [...scene.getPlayerParty(), ...scene.getEnemyParty()].map(p => ({
    id: p.id,
    species: p.species.speciesId,
    level: p.level,
    hp: p.hp,
    status: p.status,
    moves: p.getMoveset().map(m => [m.moveId, m.ppUsed]),
  }));
  return CryptoJS.SHA256(JSON.stringify({ turn: scene.currentBattle.turn, party })).toString();
}
export function reseedBattle(scene: BattleScene, seed: string): void {
  scene.currentBattle.battleSeed = seed;
  Reflect.set(scene.currentBattle, "battleSeedState", null);
  scene.rngSeedOverride = seed;
  Phaser.Math.RND.sow([seed]);
}
