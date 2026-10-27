// SPDX-License-Identifier: AGPL-3.0-only
import type { BattleScene } from "#app/battle-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { Egg } from "#data/egg";
import { version } from "#package.json";
import { EggData } from "#system/egg-data";
import { AuditInputError } from "./audit-errors";
import { type EggContext, type EggReceipt, withEggProofReplay } from "./egg-proof";

export interface EggJob {
  receipts: (EggReceipt & { egg: Record<string, unknown> })[];
  seeds: Record<string, string>;
  basis: EggContext;
  next: EggContext;
}
function fail(message: string): never {
  throw new AuditInputError(`egg proof: ${message}`);
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pity = (values: number[] | undefined) => Array.from({ length: 4 }, (_, i) => values?.[i] ?? 0);
const nativePity = Number(version.split(".")[2]) >= 2;
function checkContext(ctx: EggContext, requirePity = false): void {
  if (!ctx || !Array.isArray(ctx.caught) || !Array.isArray(ctx.eggs)) {
    fail("context shape");
  }
  if (nativePity) {
    if (
      !ctx.starterPity
      || !ctx.caughtAttrs
      || Object.keys(ctx.starterPity).length > 2000
      || Object.entries(ctx.starterPity).some(
        ([id, value]) =>
          !speciesDataRegistry.isStarter(Number(id))
          || !Array.isArray(value)
          || value.length !== 2
          || value.some(n => !Number.isInteger(n) || n < 0 || n > 1000000),
      )
      || Object.keys(ctx.caughtAttrs).length > 2000
      || Object.entries(ctx.caughtAttrs).some(
        ([id, value]) =>
          !Object.hasOwn(speciesDataRegistry.data, id) || typeof value !== "string" || !/^\d{1,100}$/u.test(value),
      )
    ) {
      fail("same-species pity context");
    }
    if (ctx.eggs.some(e => !Number.isInteger(e.variantTier) || e.variantTier! < 0 || e.variantTier! > 2)) {
      fail("stock variant");
    }
  }
  for (const values of [ctx.eggPity, ctx.unlockPity]) {
    if (values == null && !requirePity) {
      continue;
    }
    if (
      !Array.isArray(values)
      || values.length !== 4
      || values.some(v => !Number.isInteger(v) || v < 0 || v > 1000000)
    ) {
      fail("pity range");
    }
  }
  if (
    ctx.caught.length > 2000
    || new Set(ctx.caught).size !== ctx.caught.length
    || ctx.caught.some(id => !Number.isInteger(id) || !Object.hasOwn(speciesDataRegistry.data, id))
    || ctx.eggs.length > 99
    || ctx.eggs.some(e => !e || !Number.isSafeInteger(e.id) || e.id <= 0 || !Number.isInteger(e.species))
  ) {
    fail("context bound");
  }
}
export function auditEggs(scene: BattleScene, job: EggJob, setTime: (timestamp: number) => void) {
  if (!Array.isArray(job.receipts) || job.receipts.length > 128) {
    fail("receipt count");
  }
  checkContext(job.basis);
  checkContext(job.next);
  let eggPity = pity(job.basis.eggPity);
  let unlockPity = pity(job.basis.unlockPity);
  let starterPity = structuredClone(job.basis.starterPity);
  const variants = new Map(job.basis.eggs.map(e => [e.id, e.variantTier]));
  const beforeCaught = new Set(job.basis.caught);
  const afterCaught = new Set(job.next.caught);
  const allowed = new Map(job.basis.eggs.map(e => [e.id, e.species]));
  const finalStock = new Map(job.next.eggs.map(e => [e.id, e.species]));
  const batches = new Map<string, { size: number; source: number; tiers: number[] }>();
  const results: { id: number; species: number; moveIndex: number }[] = [];
  for (const receipt of job.receipts) {
    if (!receipt || !receipt.options || !receipt.egg) {
      fail("receipt shape");
    }
    const ctx = receipt.context;
    checkContext(ctx, true);
    if (!equal(pity(ctx.eggPity), eggPity) || !equal(pity(ctx.unlockPity), unlockPity)) {
      fail("pity context diverged");
    }
    if (nativePity && !equal(ctx.starterPity, starterPity)) {
      fail("same-species pity diverged");
    }
    if (nativePity) {
      for (const id of new Set([...Object.keys(job.basis.caughtAttrs!), ...Object.keys(ctx.caughtAttrs!)])) {
        const before = BigInt(job.basis.caughtAttrs![Number(id)] ?? "0");
        const current = BigInt(ctx.caughtAttrs![Number(id)] ?? "0");
        const after = BigInt(job.next.caughtAttrs![Number(id)] ?? "0");
        if ((current & before) !== before || (current | after) !== after) {
          fail("variant unlock context");
        }
      }
      for (const egg of ctx.eggs) {
        if (egg.variantTier !== variants.get(egg.id)) {
          fail("stock variant changed");
        }
      }
    }
    const caught = new Set(ctx.caught);
    const stock = new Map(ctx.eggs.map(e => [e.id, e.species]));
    if (stock.size !== ctx.eggs.length) {
      fail("duplicate stock ID");
    }
    for (const id of beforeCaught) {
      if (!caught.has(id)) {
        fail("known unlock omitted");
      }
    }
    for (const id of caught) {
      if (!afterCaught.has(id)) {
        fail("unknown unlock added");
      }
    }
    for (const [id, species] of stock) {
      if (!allowed.has(id) || allowed.get(id) !== species) {
        fail("unobserved stock");
      }
    }
    for (const [id, species] of allowed) {
      if (finalStock.has(id) && stock.get(id) !== species) {
        fail("surviving stock omitted");
      }
    }
    const options = receipt.options;
    if (!Number.isSafeInteger(options.timestamp) || options.timestamp! <= 0) {
      fail("timestamp range");
    }
    if (options.species && !Object.hasOwn(speciesDataRegistry.data, options.species)) {
      fail("unknown species");
    }
    if (options.tier != null && (!Number.isInteger(options.tier) || options.tier < 0 || options.tier > 3)) {
      fail("tier range");
    }
    const certified = (receipt.sequence ?? 0) > 0;
    const seed = certified ? job.seeds[receipt.sequence!] : receipt.seed;
    if (typeof seed !== "string" || !seed || seed.length > 128) {
      fail("seed missing");
    }
    if (certified) {
      if (
        options.isShiny != null
        || options.variantTier != null
        || options.eggMoveIndex != null
        || options.hatchWaves != null
        || options.overrideHiddenAbility
      ) {
        fail("property override");
      }
      if (
        options.sourceType == null
        || !Number.isInteger(options.sourceType)
        || options.sourceType < 0
        || options.sourceType > 4
      ) {
        fail("source");
      }
      if (options.sourceType === 3) {
        if (
          !options.species
          || !speciesDataRegistry.isStarter(options.species)
          || options.pulled
          || options.tier != null
        ) {
          fail("same-species options");
        }
      } else if (options.sourceType === 4) {
        if (options.pulled || options.species || options.tier == null || options.tier > 2 || options.tier < 0) {
          fail("event options");
        }
      } else {
        if (!options.pulled || options.species) {
          fail("gacha options");
        }
        let expected: number | undefined;
        const b = receipt.batch;
        if (b) {
          if (![1, 5, 10, 25].includes(b.size)) {
            fail("gacha batch size");
          }
          let prior = batches.get(b.id);
          if (!prior) {
            prior = { size: b.size, source: options.sourceType, tiers: [] };
            batches.set(b.id, prior);
          }
          if (prior.size !== b.size || prior.source !== options.sourceType || b.index !== prior.tiers.length) {
            fail("gacha batch sequence");
          }
          const guarantee = b.size === 25 ? 2 : b.size === 10 ? 1 : 0;
          if (b.index === b.size - 1 && guarantee > 0 && !prior.tiers.some(t => t >= guarantee)) {
            expected = guarantee;
          }
        }
        if (options.tier !== expected) {
          fail("unearned guarantee");
        }
      }
    }
    setTime(options.timestamp!);
    for (const [id, data] of Object.entries(scene.gameData.dexData)) {
      data.caughtAttr = nativePity ? BigInt(ctx.caughtAttrs![Number(id)] ?? "0") : caught.has(Number(id)) ? 1n : 0n;
    }
    if (nativePity) {
      for (const [id, entry] of Object.entries(scene.gameData.starterData)) {
        const counters = ctx.starterPity![Number(id)];
        if (!counters) {
          fail("missing species pity");
        }
        Reflect.set(entry, "pity", [...counters]);
      }
    }
    scene.gameData.eggPity = [...eggPity];
    scene.gameData.unlockPity = [...unlockPity];
    scene.gameData.eggs = ctx.eggs.map(e => ({ id: e.id, species: e.species, variantTier: e.variantTier }) as Egg);
    const roll = { seed, certified, receipt };
    const egg = withEggProofReplay(roll, () => new Egg(options));
    const actual = new EggData(egg) as unknown as Record<string, unknown>;
    for (const field of [
      "id",
      "tier",
      "sourceType",
      "hatchWaves",
      "timestamp",
      "variantTier",
      "isShiny",
      "species",
      "eggMoveIndex",
      "overrideHiddenAbility",
    ]) {
      if (!equal(actual[field], receipt.egg[field])) {
        fail(`generated ${field} mismatch`);
      }
    }
    eggPity = [...scene.gameData.eggPity];
    unlockPity = [...scene.gameData.unlockPity];
    if (nativePity) {
      starterPity = Object.fromEntries(
        Object.entries(scene.gameData.starterData).map(([id, entry]) => [id, [...Reflect.get(entry, "pity")]]),
      );
    }
    allowed.set(egg.id, egg.species);
    variants.set(egg.id, egg.variantTier);
    const b = receipt.batch;
    if (b) {
      let previous = batches.get(b.id);
      if (!previous) {
        previous = { size: b.size, source: options.sourceType!, tiers: [] };
        batches.set(b.id, previous);
      }
      if (b.index !== previous.tiers.length) {
        fail("batch order");
      }
      previous.tiers.push(egg.tier);
    }
    if (certified) {
      const hatch = egg.generatePlayerPokemon();
      results.push({ id: egg.id, species: hatch.species.speciesId, moveIndex: egg.eggMoveIndex });
      hatch.destroy();
    }
  }
  for (const b of batches.values()) {
    if (b.tiers.length !== b.size) {
      fail("incomplete batch");
    }
  }
  if (!equal(eggPity, pity(job.next.eggPity)) || !equal(unlockPity, pity(job.next.unlockPity))) {
    fail("final pity mismatch");
  }
  if (nativePity && !equal(starterPity, job.next.starterPity)) {
    fail("final same-species pity mismatch");
  }
  return results;
}
