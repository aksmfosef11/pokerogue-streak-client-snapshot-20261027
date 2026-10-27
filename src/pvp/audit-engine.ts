// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import { getGameMode } from "#app/game-mode";
import { GameModes } from "#enums/game-modes";
import { TrainerVariant } from "#enums/trainer-variant";
import { EncounterPhase } from "#phases/encounter-phase";
import { NewBiomeEncounterPhase } from "#phases/new-biome-encounter-phase";
import { NextEncounterPhase } from "#phases/next-encounter-phase";
import i18next from "i18next";
import { AuditInputError } from "./audit-errors";
import { parseAuditSession } from "./audit-input";
import type { GenerationCheckpoint, generationResult } from "./generation";
import { loadSession } from "./loader";

let restoreTrainerAI = () => {};

/** Input captured before newBattle consumes the wave seed. No client RNG state
 * is accepted: replay calls the real newBattle and EncounterPhase again. */
/** Reuse upstream loading, battle configuration, species/move/item generation,
 * including the trainer/biome seed offsets. The caller supplies a headless scene
 * and captures saveAll, which is the boundary before any combat begins. */
export async function replayGeneration(
  scene: BattleScene,
  checkpoint: GenerationCheckpoint,
  serverSeed: string,
  expected?: ReturnType<typeof generationResult>,
): Promise<void> {
  restoreTrainerAI();
  if (
    !checkpoint
    || checkpoint.schema !== 2
    || !Number.isInteger(checkpoint.wave)
    || checkpoint.wave < 1
    || checkpoint.wave > 200
    || !checkpoint.basis
    || !checkpoint.identity
    || !Array.isArray(checkpoint.active)
  ) {
    throw new AuditInputError("invalid generation checkpoint");
  }
  if (
    typeof checkpoint.initial !== "boolean"
    || (checkpoint.initial ? checkpoint.wave !== 1 : checkpoint.basis.waveIndex !== checkpoint.wave - 1)
  ) {
    throw new AuditInputError("generation checkpoint is not contiguous");
  }
  if (checkpoint.basis.gameMode !== GameModes.CLASSIC) {
    throw new AuditInputError("generation audit only accepts classic runs");
  }
  const basis = parseAuditSession(scene.gameData, checkpoint.basis, serverSeed);
  if (
    ![checkpoint.identity.trainerId, checkpoint.identity.secretId].every(
      n => Number.isInteger(n) && n >= 0 && n <= 65535,
    )
    || checkpoint.active.length > 2
    || new Set(checkpoint.active).size !== checkpoint.active.length
    || checkpoint.active.some(id => !basis.party.some(p => p.id === id))
    || (checkpoint.language != null && (typeof checkpoint.language !== "string" || checkpoint.language.length > 64))
    || (checkpoint.trainerTeras != null
      && (!Array.isArray(checkpoint.trainerTeras)
        || checkpoint.trainerTeras.length > 6
        || checkpoint.trainerTeras.some(n => !Number.isInteger(n) || n < 0 || n > 5)))
  ) {
    throw new AuditInputError("invalid generation context");
  }
  scene.phaseManager.clearPhaseQueue();
  scene.reset(false, true);
  scene.gameMode = getGameMode(GameModes.CLASSIC);
  scene.gameData.trainerId = checkpoint.identity.trainerId;
  scene.gameData.secretId = checkpoint.identity.secretId;
  if (checkpoint.language && checkpoint.language !== i18next.language) {
    await i18next.changeLanguage(checkpoint.language);
  }
  await loadSession(scene.gameData, basis);
  if (scene.seed !== serverSeed) {
    throw new Error(`loader changed seed ${serverSeed} to ${scene.seed}`);
  }
  for (const p of scene.getPlayerParty()) {
    if (checkpoint.active.includes(p.id)) {
      scene.field.add(p);
    }
  }
  if (checkpoint.initial) {
    scene.currentBattle = null!;
  }
  // Upstream getRandomTrainerFunc deliberately uses unseeded randInt for evil
  // trainer gender/doubles. Validate that small branch's legal outcome; species,
  // trainer identity, party members, moves and held items still come from replay.
  const randomGenderWaves = [35, 62, 64, 66, 112, 114, 164];
  const config = randomGenderWaves.includes(checkpoint.wave)
    ? scene.gameMode.getFixedBattle(checkpoint.wave)
    : undefined;
  const getTrainer = config?.getTrainer;
  if (config && getTrainer && expected?.trainer) {
    config.getTrainer = () => {
      const variant = expected.trainer!.variant;
      const grunt = [35, 62, 64, 112].includes(checkpoint.wave);
      // Supply only the two upstream non-seeded branch rolls. Constructing with
      // the chosen variant also builds the correct number of trainer sprites.
      const random = Math.random;
      let draw = 0;
      Math.random = () =>
        draw++ === 0 ? (variant === TrainerVariant.FEMALE ? 0 : 0.99) : variant === TrainerVariant.DOUBLE ? 0 : 0.99;
      let trainer: ReturnType<typeof getTrainer>;
      try {
        trainer = getTrainer();
      } finally {
        Math.random = random;
      }
      if (
        trainer.config.trainerType !== expected.trainer!.trainerType
        || ![
          TrainerVariant.DEFAULT,
          TrainerVariant.FEMALE,
          ...(grunt && trainer.config.hasDouble ? [TrainerVariant.DOUBLE] : []),
        ].includes(variant)
      ) {
        throw new AuditInputError("invalid unseeded trainer branch");
      }
      return trainer;
    };
  }
  try {
    scene.newBattle();
  } finally {
    if (config && getTrainer) {
      config.getTrainer = getTrainer;
    }
  }
  if (checkpoint.initial) {
    scene.arena.init();
  }
  if (scene.currentBattle.waveIndex !== checkpoint.wave) {
    throw new Error("generation wave mismatch");
  }
  const trainer = scene.currentBattle.trainer;
  if (trainer && checkpoint.trainerTeras) {
    const slots = checkpoint.trainerTeras;
    if (slots.length > 6 || slots.some(n => !Number.isInteger(n) || n < 0 || n > 5)) {
      throw new AuditInputError("invalid trainer tera slots");
    }
    // genAI mutates shared TrainerConfig across encounters and even earlier
    // runs in the same browser. Static rules must match; only trainers with
    // upstream dynamic AI generators may carry their previously chosen slots.
    const current = [...new Set(trainer.config.trainerAI.instantTeras)].sort();
    if (trainer.config.genAIFuncs.length === 0 && JSON.stringify(current) !== JSON.stringify(slots)) {
      throw new AuditInputError("static trainer tera policy changed");
    }
    const ai = trainer.config.trainerAI;
    const descriptor = Object.getOwnPropertyDescriptor(ai, "instantTeras");
    Object.defineProperty(ai, "instantTeras", { configurable: true, get: () => slots });
    restoreTrainerAI = () => {
      if (descriptor) {
        Object.defineProperty(ai, "instantTeras", descriptor);
      } else {
        Reflect.deleteProperty(ai, "instantTeras");
      }
      restoreTrainerAI = () => {};
    };
    const save = scene.gameData.saveAll;
    scene.gameData.saveAll = function (...args) {
      restoreTrainerAI();
      return save.apply(this, args);
    };
  }
  scene.phaseManager.clearPhaseQueue();
  const Phase = checkpoint.initial
    ? EncounterPhase
    : checkpoint.wave % 10 === 1
      ? NewBiomeEncounterPhase
      : NextEncounterPhase;
  new Phase(false).start();
}
