// SPDX-License-Identifier: AGPL-3.0-only
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
it("migrates the actual old save and hatches its existing egg in the new native engine", async () => {
  const input = JSON.parse(readFileSync(process.env.PVP_PROGRESS_INPUT!, "utf8"));
  const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
  await game.runToTitle();
  const data = GameData.fromRawSystem(JSON.stringify(input.system));
  game.scene.gameData = data;
  game.scene.newBattle();
  const snapshot = () =>
    JSON.parse(JSON.stringify(data.getSystemSaveData(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const upgraded = snapshot();
  expect(upgraded.eggs.length).toBeGreaterThan(0);
  expect(upgraded.gameVersion).toBe("1.12.2.0");
  const egg = data.eggs[0],
    pokemon = egg.generatePlayerPokemon();
  expect(egg.hatchWaves).toBe(0);
  await data.setPokemonCaught(pokemon, true, true, false);
  await data.setEggMoveUnlocked(pokemon.species, egg.eggMoveIndex, false);
  data.eggs.splice(0, 1);
  data.gameStats.playTime++;
  writeFileSync(
    process.env.PVP_PROGRESS_OUTPUT!,
    JSON.stringify({
      upgraded,
      hatched: { ...snapshot(), pvpEggProofs: [] },
      eggId: egg.id,
      species: pokemon.species.speciesId,
    }),
  );
});
