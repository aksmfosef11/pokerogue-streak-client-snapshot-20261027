// SPDX-License-Identifier: AGPL-3.0-only
import { timedEventManager } from "#app/global-event-manager";
import { EGG_SEED, Egg, type IEggOptions } from "#data/egg";
import { EggSourceType } from "#enums/egg-source-types";
import { SpeciesId } from "#enums/species-id";
import { version } from "#package.json";
import { EggData } from "#system/egg-data";
import { GameManager } from "#test/framework/game-manager";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEggs, type EggJob } from "../../../src/pvp/audit-eggs";
import { type EggReceipt, eggContext, eggEntropy, withEggProofReplay } from "../../../src/pvp/egg-proof";

describe("Single-use egg seed proof reproduction", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let job: EggJob;
  const timestamp = Date.UTC(2026, 9, 24, 5);
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    timedEventManager.disable();
    game = new GameManager(phaser);
    await game.runToTitle();
    game.scene.newBattle();
    game.scene.gameData.eggs = [];
    game.scene.gameData.eggPity = [0, 0, 0, 0];
    game.scene.gameData.unlockPity = [0, 0, 0, 0];
    for (const entry of Object.values(game.scene.gameData.dexData)) {
      entry.caughtAttr = 1n;
    }
    vi.setSystemTime(timestamp);
    job = { basis: eggContext(game.scene.gameData), next: eggContext(game.scene.gameData), receipts: [], seeds: {} };
  });
  afterAll(() => timedEventManager.disable());
  function create(options: IEggOptions, certified = true, batch?: EggReceipt["batch"], seed?: string) {
    const n = job.receipts.length + 1;
    const receipt: EggReceipt = {
      id: `receipt-${n}`,
      options: { ...options, timestamp },
      context: eggContext(game.scene.gameData),
      ...(batch ? { batch } : {}),
    };
    const value = seed ?? `fixed-egg-seed-${n}`;
    if (certified) {
      receipt.sequence = n;
      receipt.ticketId = `ticket-${n}`;
      job.seeds[n] = value;
    } else {
      receipt.seed = value;
    }
    const egg = withEggProofReplay({ seed: value, certified, receipt }, () => new Egg(receipt.options));
    if (!options.pulled) {
      egg.addEggToGameData();
    }
    receipt.egg = JSON.parse(JSON.stringify(new EggData(egg)));
    job.receipts.push(receipt as EggJob["receipts"][number]);
    job.next = eggContext(game.scene.gameData);
    return egg;
  }
  function verify(value = job) {
    return auditEggs(game.scene, value, time => vi.setSystemTime(time));
  }
  it.each([EggSourceType.GACHA_MOVE, EggSourceType.GACHA_LEGENDARY, EggSourceType.GACHA_SHINY])(
    "replays gacha source %i with ID, shiny, variant and move slot",
    sourceType => {
      const egg = create({ pulled: true, sourceType });
      expect(verify()).toEqual([{ id: egg.id, species: egg.species, moveIndex: egg.eggMoveIndex }]);
    },
  );
  it.each([10, 25])("reproduces the %i-pull guarantee only when earned", size => {
    const tiers: number[] = [];
    for (let i = 0; i < size; i++) {
      const guarantee = size === 25 ? 2 : 1;
      const tier = i === size - 1 && !tiers.some(t => t >= guarantee) ? guarantee : undefined;
      tiers.push(
        create({ pulled: true, sourceType: EggSourceType.GACHA_MOVE, ...(tier == null ? {} : { tier }) }, true, {
          id: "batch",
          size,
          index: i,
        }).tier,
      );
    }
    expect(verify()).toHaveLength(size);
    const forged = structuredClone(job);
    forged.receipts[0].options.tier = 3;
    expect(() => verify(forged)).toThrow(/guarantee/);
  });
  it("replays same-species and bounded event eggs", () => {
    create({ sourceType: EggSourceType.SAME_SPECIES_EGG, species: SpeciesId.BULBASAUR });
    create({ sourceType: EggSourceType.EVENT, tier: 2 });
    expect(verify()).toHaveLength(2);
  });
  it("excludes fallback seeds while preserving the next certified egg's pity", () => {
    create({ pulled: true, sourceType: EggSourceType.GACHA_MOVE }, false);
    const certified = create({ pulled: true, sourceType: EggSourceType.GACHA_MOVE });
    expect(verify()).toEqual([{ id: certified.id, species: certified.species, moveIndex: certified.eggMoveIndex }]);
  });
  it("rejects move/shiny/ID changes and unauthorized constructor overrides", () => {
    create({ pulled: true, sourceType: EggSourceType.GACHA_MOVE });
    for (const [key, value] of [
      ["eggMoveIndex", 99],
      ["id", 5],
      ["isShiny", !job.receipts[0].egg.isShiny],
    ] as const) {
      const forged = structuredClone(job);
      forged.receipts[0].egg[key] = value;
      expect(() => verify(forged)).toThrow(/generated/);
    }
    const override = structuredClone(job);
    override.receipts[0].options.eggMoveIndex = 3;
    expect(() => verify(override)).toThrow(/override/);
  });
  it("rejects invented pity, stock or caught context", () => {
    create({ pulled: true, sourceType: EggSourceType.GACHA_MOVE });
    const forged = structuredClone(job);
    forged.receipts[0].context.eggPity[3] = 411;
    expect(() => verify(forged)).toThrow(/pity/);
    const stock = structuredClone(job);
    stock.receipts[0].context.eggs.push({ id: 123, species: 1 });
    expect(() => verify(stock)).toThrow(/stock/);
    const caught = structuredClone(job);
    caught.receipts[0].context.caught = [];
    expect(() => verify(caught)).toThrow(/unlock/);
  });
  it("reproduces same-species Phione's actual ID-based Manaphy hatch", () => {
    let found: Egg | undefined;
    for (let n = 0; n < 128 && !found; n++) {
      game.scene.gameData.eggs = [];
      job.receipts = [];
      job.seeds = {};
      job.basis = eggContext(game.scene.gameData);
      const egg = create(
        { sourceType: EggSourceType.SAME_SPECIES_EGG, species: SpeciesId.PHIONE },
        true,
        undefined,
        `manaphy-${n}`,
      );
      const hatch = egg.generatePlayerPokemon();
      if (hatch.species.speciesId === SpeciesId.MANAPHY) {
        found = egg;
      }
      hatch.destroy();
    }
    expect(found).toBeDefined();
    expect(verify()[0].species).toBe(SpeciesId.MANAPHY);
  });
  it("reproduces the common event Manaphy egg without inventing gacha hatch progress", () => {
    let found: Egg | undefined;
    for (let n = 0; n < 4096 && !found; n++) {
      game.scene.gameData.eggs = [];
      game.scene.gameData.eggPity = [0, 0, 0, 0];
      game.scene.gameData.unlockPity = [0, 0, 0, 0];
      job.receipts = [];
      job.seeds = {};
      const egg = create({ sourceType: EggSourceType.EVENT, tier: 0 }, true, undefined, `event-manaphy-${n}`);
      if (egg.isManaphyEgg()) {
        found = egg;
      }
    }
    expect(found).toBeDefined();
    expect(found!.hatchWaves).toBe(10);
    expect(verify()).toHaveLength(1);
  });
  it("classifies malformed proof contexts as a permanent input rejection", () => {
    create({ pulled: true, sourceType: EggSourceType.GACHA_MOVE });
    for (const context of [null, {}, { ...job.receipts[0].context, eggPity: null }]) {
      const forged = structuredClone(job);
      Reflect.set(forged.receipts[0], "context", context);
      expect(() => verify(forged)).toThrow(/egg proof: (context shape|pity range)/);
    }
  });
  it("keeps upstream unseeded tier and ID behavior when no proof is active", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.125);
    const egg = new Egg({ sourceType: EggSourceType.GACHA_MOVE });
    expect(egg.tier).toBe(1);
    expect(egg.id).toBe(EGG_SEED + Math.floor(EGG_SEED * 0.125));
    random.mockRestore();
  });
  it("reproduces an epic shiny variant from the ticket seed", () => {
    let found: Egg | undefined;
    for (let n = 0; n < 2048 && !found; n++) {
      game.scene.gameData.eggs = [];
      job.receipts = [];
      job.seeds = {};
      job.basis = eggContext(game.scene.gameData);
      const egg = create(
        { sourceType: EggSourceType.SAME_SPECIES_EGG, species: SpeciesId.BULBASAUR },
        true,
        undefined,
        `shiny-variant-${n}`,
      );
      if (egg.isShiny && egg.variantTier === 2) {
        found = egg;
      }
    }
    expect(found).toBeDefined();
    expect(verify()).toHaveLength(1);
  });
  it.runIf(version === "1.12.2.0")("binds same-species counters and variant stock to the saved context", () => {
    create({ sourceType: EggSourceType.SAME_SPECIES_EGG, species: SpeciesId.BULBASAUR });
    const altered = structuredClone(job);
    altered.receipts[0].context.starterPity![SpeciesId.BULBASAUR][0] += 1;
    expect(() => verify(altered)).toThrow(/pity diverged/);
    const final = structuredClone(job);
    final.next.starterPity![SpeciesId.BULBASAUR][1] += 1;
    expect(() => verify(final)).toThrow(/final same-species pity mismatch/);
    expect(verify()).toHaveLength(1);
  });
  it("restores the global random source when a seeded constructor step throws", () => {
    const original = Math.random;
    const receipt = { id: "exception", options: {}, context: eggContext(game.scene.gameData) };
    expect(() =>
      eggEntropy({ seed: "throw", certified: true, receipt }, "id", () => {
        throw new Error("expected");
      }),
    ).toThrow("expected");
    expect(Math.random).toBe(original);
  });
});
