// SPDX-License-Identifier: AGPL-3.0-only
import { Egg } from "#data/egg";
import { EggSourceType } from "#enums/egg-source-types";
import { SpeciesId } from "#enums/species-id";
import { version } from "#package.json";
import { GameManager } from "#test/framework/game-manager";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

it("exports controlled saves through the actual old native serializers", async () => {
  expect(version).toBe("1.12.1.2");
  const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
  await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
  const data = game.scene.gameData;
  // Controlled progress values test preservation, not an earned-income proof.
  Object.assign(data.starterData[SpeciesId.BULBASAUR], {
    candyCount: 42,
    friendship: 17,
    eggMoves: 5,
    valueReduction: 1,
    passiveAttr: 1,
  });
  data.eggs.push(new Egg({ sourceType: EggSourceType.SAME_SPECIES_EGG, species: SpeciesId.BULBASAUR }));
  const system = data.getSystemSaveData();
  const session = data.getSessionSaveData();
  expect(system.gameVersion).toBe(version);
  expect(session.gameVersion).toBe(version);
  writeFileSync(
    process.env.PVP_NATIVE_SAVE_OUTPUT!,
    JSON.stringify(
      {
        source: {
          version,
          nativeCommit: "b271d3e63f82059da9bb93b01f69ec33ed7a10a0",
          producer: "native-save-producer.test.ts",
        },
        system,
        session,
      },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    ),
  );
});
