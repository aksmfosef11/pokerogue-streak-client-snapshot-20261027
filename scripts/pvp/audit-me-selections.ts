// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import { EncounterBattleAnim } from "#data/battle-anims";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import { StatusEffect } from "#enums/status-effect";
import { UiMode } from "#enums/ui-mode";
import type { EnemyPokemon, PlayerPokemon } from "#field/pokemon";
import { PersistentModifier } from "#modifiers/modifier";
// biome-ignore lint/performance/noNamespaceImport: Suppress dialogue only; keep native postprocessing and all RNG calls.
import * as encounterDialogue from "#mystery-encounters/encounter-dialogue-utils";
// biome-ignore lint/performance/noNamespaceImport: Run the native selection callback without displaying its party prompt.
import * as encounterPhases from "#mystery-encounters/encounter-phase-utils";
// biome-ignore lint/performance/noNamespaceImport: Transformation animation has no audit side effects.
import * as encounterAnimation from "#mystery-encounters/encounter-transformation-sequence";
import { ModifierData } from "#system/modifier-data";
import { PokemonData } from "#system/pokemon-data";
import { vi } from "vitest";
import { customAbility, generatedPokemon, serialCopy } from "../../src/pvp/generation";

/** Fixture control: execute the original post-battle ability option. Skip only
 * battle/dialogue/animation, retaining its native confirm and party callbacks.
 * Mutates the selected player's Pokemon. */
export async function applyClownAbilityChoice(scene: BattleScene, owner: PlayerPokemon) {
  const encounter = scene.currentBattle.mysteryEncounter;
  if (encounter?.encounterType !== ME.CLOWNING_AROUND || !scene.getPlayerParty().includes(owner)) {
    throw new Error("clown ability requires its generated encounter and a live owner");
  }
  const mocks = [
    vi.spyOn(encounterDialogue, "showEncounterText").mockResolvedValue(),
    vi.spyOn(encounterDialogue, "showEncounterDialogue").mockResolvedValue(),
    vi.spyOn(scene.ui, "setMode").mockResolvedValue(),
    vi.spyOn(scene.ui, "setModeWithoutClear").mockImplementation(async (mode, config) => {
      if (mode === UiMode.CONFIRM) {
        config.yesHandler();
      }
    }),
    vi.spyOn(encounterPhases, "selectPokemonForOption").mockImplementation(callback => {
      callback(owner);
      return Promise.resolve(true);
    }),
    vi.spyOn(EncounterBattleAnim.prototype, "playWithoutTargets").mockImplementation(() => {}),
    vi.spyOn(scene.tweens, "add").mockReturnValue({} as Phaser.Tweens.Tween),
  ];
  try {
    await encounter.options[0].onPostOptionPhase!();
    return serialCopy(new PokemonData(owner));
  } finally {
    for (const mock of mocks) {
      mock.mockRestore();
    }
  }
}

/** Run native heat damage, eligibility, burn roll and permanent ability write.
 * Temporarily stage the selection-time party, including its active members for
 * ally immunities. Suppress only dialogue and phase transitions. */
export async function replayFieryHeat(scene: BattleScene, selectedParty: PokemonData[]) {
  const encounter = scene.currentBattle.mysteryEncounter;
  if (encounter?.encounterType !== ME.FIERY_FALLOUT) {
    return;
  }
  const originalParty = scene.getPlayerParty().slice();
  const active = new Set(originalParty.filter(p => p.isOnField()).map(p => p.id));
  const rng = Phaser.Math.RND.state();
  const offset = encounter.getSeedOffset();
  const tokens = { ...encounter.dialogueTokens };
  const staged = selectedParty.map(p => new PokemonData({ ...p, player: true }).toPokemon() as PlayerPokemon);
  const messages = vi.spyOn(encounterDialogue, "queueEncounterMessage").mockImplementation(() => {});
  const leave = vi.spyOn(encounterPhases, "leaveEncounterWithoutBattle").mockImplementation(() => {});
  try {
    scene.getPlayerParty().splice(0, originalParty.length, ...staged);
    for (const pokemon of staged) {
      if (active.has(pokemon.id)) {
        scene.field.add(pokemon);
      }
    }
    scene.resetSeed();
    encounter.updateSeedOffset();
    let done: Promise<void | boolean> | undefined;
    scene.executeWithSeedOffset(() => {
      done = encounter.options[1].onOptionPhase();
    }, encounter.getSeedOffset() * 500);
    await done;
    const party = staged.map(p => serialCopy(new PokemonData(p)));
    const target = party.find(
      (p, index) => p.status?.effect === StatusEffect.BURN && selectedParty[index].status?.effect !== StatusEffect.BURN,
    );
    return {
      party,
      target: target
        ? { id: target.id, fusion: !!target.fusionSpecies, ability: customAbility(target, !!target.fusionSpecies) }
        : undefined,
    };
  } finally {
    messages.mockRestore();
    leave.mockRestore();
    scene.getPlayerParty().splice(0, staged.length, ...originalParty);
    for (const pokemon of staged) {
      pokemon.destroy();
    }
    encounter.dialogueTokens = tokens;
    Reflect.set(encounter, "seedOffset", offset);
    Phaser.Math.RND.state(rng);
  }
}

/** Clown's pre-option callback runs synchronously inside its native seed scope.
 * Stage the audited selection-time party so its order and move priorities match
 * the real prompt. Keep the generated encounter and never accept client RNG. */
export async function replayClownTypeShuffle(scene: BattleScene, selectedParty: PokemonData[]) {
  const encounter = scene.currentBattle.mysteryEncounter;
  if (encounter?.encounterType !== ME.CLOWNING_AROUND) {
    return;
  }
  const originalParty = scene.getPlayerParty().slice();
  const rng = Phaser.Math.RND.state();
  const offset = encounter.getSeedOffset();
  const staged = selectedParty.map(p => new PokemonData({ ...p, player: true }).toPokemon() as PlayerPokemon);
  try {
    scene.getPlayerParty().splice(0, originalParty.length, ...staged);
    scene.resetSeed();
    encounter.updateSeedOffset();
    let done: Promise<void | boolean> | undefined;
    scene.executeWithSeedOffset(() => {
      done = encounter.options[2].onPreOptionPhase!();
    }, encounter.getSeedOffset());
    await done;
    return staged.map(p => serialCopy(new PokemonData(p)));
  } finally {
    scene.getPlayerParty().splice(0, staged.length, ...originalParty);
    for (const pokemon of staged) {
      pokemon.destroy();
    }
    Reflect.set(encounter, "seedOffset", offset);
    Phaser.Math.RND.state(rng);
  }
}

/** The upstream party prompt invokes this callback after its seeded pre-option
 * scope has returned. EncounterPhase resets the wave RNG after saveAll;
 * reproduce that reset before invoking the original callback. In particular,
 * never take a random state or a generated gift from the submitted record. */
export async function replayGtsWonderTradeGifts(scene: BattleScene) {
  const encounter = scene.currentBattle.mysteryEncounter;
  if (encounter?.encounterType !== ME.GLOBAL_TRADE_SYSTEM) {
    return [];
  }
  const rng = Phaser.Math.RND.state();
  const misc = { ...encounter.misc };
  const tokens = { ...encounter.dialogueTokens };
  const gifts: { outgoing: number; pokemon: ReturnType<typeof generatedPokemon> }[] = [];
  try {
    for (const owner of scene.getPlayerParty()) {
      scene.resetSeed();
      const selection = vi.spyOn(encounterPhases, "selectPokemonForOption").mockImplementation(callback => {
        callback(owner);
        return Promise.resolve(true);
      });
      let pokemon: EnemyPokemon | undefined;
      try {
        await encounter.options[1].onPreOptionPhase!();
        pokemon = encounter.misc.receivedPokemon;
        gifts.push({
          outgoing: owner.id,
          pokemon: serialCopy({ ...generatedPokemon(new PokemonData(pokemon!)), passive: !!owner.passive }),
        });
      } finally {
        selection.mockRestore();
        pokemon?.destroy();
      }
    }
    return gifts;
  } finally {
    Phaser.Math.RND.state(rng);
    encounter.misc = misc;
    encounter.dialogueTokens = tokens;
  }
}

/** Execute the original transformation branch on the freshly regenerated ME.
 * This mutates the scene; the caller must reload its generation checkpoint
 * before auditing the submitted acquisition and item timeline. */
export async function replayWeirdDreamTransformation(scene: BattleScene) {
  const encounter = scene.currentBattle.mysteryEncounter;
  if (encounter?.encounterType !== ME.WEIRD_DREAM) {
    return;
  }
  const transformations = encounter.misc.teamTransformations as {
    previousPokemon: PlayerPokemon;
    newPokemon: PlayerPokemon;
  }[];
  const oldItems = new Set(scene.modifiers);
  const createdItems: ModifierData[] = [];
  const unlockedEggMoves: { species: number; moveIndex: number }[] = [];
  const add = scene.addModifier;
  const delayedCall = scene.time.delayedCall;
  const origSetEggMoveUnlocked = scene.gameData.setEggMoveUnlocked;
  scene.time.delayedCall = (_delay, callback, args, scope) => {
    callback.apply(scope, args ?? []);
    return new Phaser.Time.TimerEvent({ delay: 0 });
  };
  scene.addModifier = function (...args) {
    if (args[0] instanceof PersistentModifier && !oldItems.has(args[0]) && !args[3]) {
      createdItems.push(serialCopy(new ModifierData(args[0], true)));
    }
    return add.apply(this, args);
  };
  scene.gameData.setEggMoveUnlocked = async function (species, eggMoveIndex, ...rest) {
    const speciesId = typeof species === "number" ? species : (species?.speciesId ?? species);
    unlockedEggMoves.push({ species: Number(speciesId), moveIndex: Number(eggMoveIndex) });
    return origSetEggMoveUnlocked.call(this, species, eggMoveIndex, false, ...rest.slice(1));
  };
  const mocks = [
    vi.spyOn(encounterDialogue, "showEncounterText").mockResolvedValue(),
    vi.spyOn(encounterDialogue, "showEncounterDialogue").mockResolvedValue(),
    vi.spyOn(encounterAnimation, "doPokemonTransformationSequence").mockResolvedValue(),
    vi.spyOn(encounterPhases, "leaveEncounterWithoutBattle").mockImplementation(() => {}),
  ];
  try {
    scene.resetSeed();
    encounter.selectedOption = encounter.options[0];
    encounter.updateSeedOffset();
    await encounter.options[0].onPreOptionPhase!();
    let done: Promise<void | boolean> | undefined;
    scene.executeWithSeedOffset(() => {
      done = encounter.options[0].onOptionPhase!();
    }, encounter.getSeedOffset() * 500);
    await done;
    return {
      gifts: transformations.map(t => ({
        outgoing: t.previousPokemon.id,
        pokemon: serialCopy(new PokemonData(t.newPokemon)),
      })),
      items: createdItems,
      eggMoves: unlockedEggMoves,
    };
  } finally {
    scene.addModifier = add;
    scene.time.delayedCall = delayedCall;
    scene.gameData.setEggMoveUnlocked = origSetEggMoveUnlocked;
    for (const mock of mocks) {
      mock.mockRestore();
    }
  }
}
