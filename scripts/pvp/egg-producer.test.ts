// SPDX-License-Identifier: AGPL-3.0-only

import { speciesEggMoves } from "#balance/egg-moves";
import { Egg } from "#data/egg";
import { EggSourceType } from "#enums/egg-source-types";
import { SpeciesId } from "#enums/species-id";
import { EggData } from "#system/egg-data";
import { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { readFileSync, writeFileSync } from "node:fs";
import { it, vi } from "vitest";
import { type EggReceipt, type EggTicket, eggContext, withEggProofReplay } from "../../src/pvp/egg-proof";

it("produces an actual ticketed egg and hatch for local HTTP integration", async () => {
  const input = JSON.parse(readFileSync(process.env.PVP_EGG_PRODUCER_INPUT!, "utf8"));
  const ticket = input.ticket as EggTicket;
  vi.setSystemTime(ticket.issued + 1000);
  const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
  await game.runToTitle();
  game.scene.gameData = process.env.PVP_EGG_PRESERVE_SYSTEM
    ? GameData.fromRawSystem(JSON.stringify(input.system))
    : new GameData();
  game.scene.newBattle();
  const data = game.scene.gameData;
  data.trainerId = input.system.trainerId;
  data.secretId = input.system.secretId;
  data.starterData[SpeciesId.BULBASAUR].candyCount = 100;
  const snapshot = () =>
    JSON.parse(JSON.stringify(data.getSystemSaveData(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const options = { sourceType: EggSourceType.SAME_SPECIES_EGG, species: SpeciesId.BULBASAUR, timestamp: Date.now() };
  const receipt: EggReceipt = {
    id: "local-http-proof",
    ticketId: ticket.id,
    sequence: ticket.sequence,
    options,
    context: eggContext(data),
  };
  data.starterData[SpeciesId.BULBASAUR].candyCount -= 25;
  const egg = withEggProofReplay({ seed: ticket.seed, certified: true, receipt }, () => new Egg(options));
  egg.addEggToGameData();
  receipt.egg = JSON.parse(JSON.stringify(new EggData(egg)));
  data.gameStats.playTime = 2;
  const created = { ...snapshot(), pvpEggProofs: [receipt] };
  const hatch = egg.generatePlayerPokemon();
  await data.setPokemonCaught(hatch, true, true, false);
  await data.setEggMoveUnlocked(hatch.species, egg.eggMoveIndex, false);
  data.eggs = [];
  data.gameStats.playTime = 3;
  const hatched = { ...snapshot(), pvpEggProofs: [] };
  writeFileSync(
    process.env.PVP_EGG_PRODUCER_OUTPUT!,
    JSON.stringify({
      created,
      hatched,
      receipt,
      eggId: egg.id,
      species: hatch.species.speciesId,
      move: speciesEggMoves[hatch.species.speciesId][egg.eggMoveIndex],
      mask: 1 << egg.eggMoveIndex,
    }),
  );
});
