// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry as registry } from "#app/global-species-data-registry";
import { speciesEggMoves } from "#balance/egg-moves";
import { EvoCondKey, type SpeciesFormEvolution } from "#balance/pokemon-evolutions";
import { allMoves } from "#data/data-lists";
import { SpeciesDefaultFormMatchTrigger, SpeciesFormChangeItemTrigger } from "#data/form-change-triggers";
import { Gender } from "#data/gender";
import type { SpeciesFormChange } from "#data/pokemon-forms";
import type { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType as ME } from "#enums/mystery-encounter-type";
import type { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import type { TimeOfDay } from "#enums/time-of-day";
import type { Pokemon } from "#field/pokemon";
import { invalidSketchMoves } from "#moves/invalid-moves";
import { DANCING_MOVES } from "#mystery-encounters/requirement-groups";
import type { PokemonData } from "#system/pokemon-data";
import { AuditInputError } from "./audit-errors";
import { possibleEvolution } from "./audit-evolutions";
import { FriendshipAudit } from "./audit-friendship";
import { validateAuditParty } from "./audit-input";
import { LevelAudit } from "./audit-levels";
import { customAbility, customPassive, customTypes, type generatedPokemon, serialCopy } from "./generation";
import type { InventoryData } from "./inventory-ledger";
import { type optionData, rewardChoice, type ShopOffer } from "./shop";

type Option = ReturnType<typeof optionData>;
type GrantKind = "tm" | "evolution" | "fusion" | "mint" | "memory" | "pp";
interface RewardChoice {
  group: string;
  value: string;
}
interface Grant {
  kind: GrantKind;
  value: number;
  eligible: Set<number>;
  used: boolean;
  choice?: RewardChoice | undefined;
}
interface Unit {
  data: PokemonData;
  moves: Set<number>;
  pp: Map<number, number>;
  forms: Set<string>;
  retired: boolean;
}
interface Route {
  species: SpeciesId;
  form: number;
  ability: number;
  evolutions: SpeciesFormEvolution[];
  sources: { species: SpeciesId; form: number }[];
  visited: Set<string>;
  changes: SpeciesFormChange[];
}
export interface PartyAuditEnvironment {
  time?: TimeOfDay | undefined;
  biome?: BiomeId | undefined;
}
export interface ProvenanceOptions {
  inventory?: ((owner: number) => readonly InventoryData[]) | undefined;
  deferResources?: boolean | undefined;
  seed?: string | undefined;
  claimReward?: ((group: string, choice: string) => boolean) | undefined;
  claimEncounter?: ((group: string, choice: string) => boolean) | undefined;
  time?: TimeOfDay | undefined;
  biome?: BiomeId | undefined;
}
type ResourceCheck = { owner: number } & (
  | { kind: "form"; item: number }
  | { kind: "held"; item: string }
  | { kind: "treasure"; count: number }
);
const number = (n: number | undefined | null) => n ?? 0;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const moves = (p: PokemonData) => p.moveset.map(m => m.moveId);
function fail(message: string): never {
  throw new AuditInputError(`party provenance: ${message}`);
}
function form(species: SpeciesId, index: number) {
  return registry.getSpecies(species).forms[index] ?? registry.getSpecies(species);
}
function pokemonDataTypes(p: PokemonData): Set<PokemonType> {
  const types = new Set<PokemonType>();
  const f = form(p.species, p.formIndex);
  const custom = customTypes(p);
  const type1 = custom[0] ?? f.type1;
  let type2 = custom[1] ?? f.type2;
  if (p.fusionSpecies) {
    const fForm = form(p.fusionSpecies, p.fusionFormIndex);
    const fCustom = customTypes(p, true);
    const ft1 = fCustom[0] ?? fForm.type1;
    const ft2 = fCustom[1] ?? fForm.type2;
    if (ft2 != null && ft2 !== type1) {
      type2 = ft2;
    } else if (ft1 != null && ft1 !== type1) {
      type2 = ft1;
    }
  }
  if (type1 != null) {
    types.add(type1);
  }
  if (type2 != null) {
    types.add(type2);
  }
  return types;
}
function evolutionRoute(
  species: SpeciesId,
  index: number,
  ability: number,
  target: SpeciesId,
  targetForm: number,
  level: number,
  gender: number | undefined,
  accepts?: ((rule: SpeciesFormEvolution, species: SpeciesId, formIndex: number) => boolean) | undefined,
  acceptsChange?: ((change: SpeciesFormChange) => boolean) | undefined,
): Route | undefined {
  const queue: Route[] = [
    { species, form: index, ability, evolutions: [], sources: [], visited: new Set(), changes: [] },
  ];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = `${current.species}:${current.form}:${current.ability}`;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    current.visited.add(key);
    if (current.species === target && current.form === targetForm) {
      return current;
    }
    if (current.evolutions.length >= 8) {
      continue;
    }
    const before = form(current.species, current.form);
    const beforeKey = registry.getSpecies(current.species).forms[current.form]?.formKey ?? "";
    for (const evo of registry.getEvolutions(current.species)) {
      if (
        evo.level > level
        || evo.condition?.data.some(
          c => c.key === EvoCondKey.SHEDINJA || (c.key === EvoCondKey.GENDER && c.gender !== gender),
        )
        || (evo.preFormKey != null && evo.preFormKey !== beforeKey)
        || (accepts && !accepts(evo, current.species, current.form))
      ) {
        continue;
      }
      const species = registry.getSpecies(evo.speciesId);
      const nextForm =
        evo.preFormKey == null
          ? Math.max(0, Math.min(current.form, species.forms.length - 1))
          : Math.max(
              0,
              species.forms.findIndex(f => f.formKey === evo.evoFormKey),
            );
      const after = form(evo.speciesId, nextForm);
      const nextAbility =
        current.ability === 2 && before.getAbilityCount() === 3 && after.getAbilityCount() === 2 ? 1 : current.ability;
      queue.push({
        species: evo.speciesId,
        form: nextForm,
        ability: nextAbility,
        evolutions: [...current.evolutions, evo],
        sources: [...current.sources, { species: current.species, form: current.form }],
        visited: new Set(current.visited),
        changes: [...current.changes],
      });
    }
    for (const change of registry.getFormChanges(current.species) ?? []) {
      if (change.preFormKey !== beforeKey || (acceptsChange && !acceptsChange(change))) {
        continue;
      }
      const nextForm = registry.getSpecies(current.species).forms.findIndex(f => f.formKey === change.formKey);
      if (nextForm < 0) {
        continue;
      }
      queue.push({
        ...current,
        form: nextForm,
        ability: Math.min(current.ability, form(current.species, nextForm).getAbilityCount() - 1),
        visited: new Set(current.visited),
        changes: [...current.changes, change],
      });
    }
  }
}
/** A possible legal history, without replaying campaign combat. Every individual
 * starts at a server-checked starter/capture; later checkpoints cannot invent its
 * species, learned moves, fusion component, nature or permanent enhancements. */
export class PartyAudit {
  private readonly levels: LevelAudit;
  private readonly friendship = new FriendshipAudit();
  private environment: PartyAuditEnvironment | undefined;
  constructor(private readonly options: ProvenanceOptions = {}) {
    this.levels = new LevelAudit(options.inventory);
  }
  setEnvironment(env: PartyAuditEnvironment | undefined): void {
    this.environment = env;
  }
  private resourceChecks: ResourceCheck[] = [];
  private encounterClaims: { group: string; choice: string }[] = [];
  private requireResources(path: Route, owner: number): void {
    for (const change of path.changes) {
      const trigger = change.findTrigger(SpeciesFormChangeItemTrigger) as SpeciesFormChangeItemTrigger | undefined;
      // A generated/captured alternate form may always return to its base form.
      // Entering an item form requires a genuinely owned item for that individual.
      if (trigger?.active) {
        this.resourceChecks.push({ owner, kind: "form", item: trigger.item });
      }
    }
    for (const evolution of path.evolutions) {
      for (const condition of evolution.condition?.data ?? []) {
        if (condition.key === EvoCondKey.HELD_ITEM) {
          this.resourceChecks.push({ owner, kind: "held", item: condition.itemKey });
        } else if (condition.key === EvoCondKey.EVO_TREASURE_TRACKER) {
          this.resourceChecks.push({ owner, kind: "treasure", count: condition.value });
        }
      }
    }
    if (!this.options.deferResources) {
      this.finishWave();
    }
  }
  finishWave(): void {
    if (this.encounter === ME.WEIRD_DREAM && this.gifts > 0 && this.itemTrades.size !== this.encounterOwners.size) {
      fail("dream transformation must replace the entire original party");
    }
    if (this.typeShuffle.size > 0) {
      for (const id of this.eligible) {
        if (this.typeShuffle.has(id) && !this.shuffledOwners.has(id)) {
          fail("clown type shuffle must affect the entire selected party");
        }
      }
    }
    this.levels.finish();
    this.friendship.finish();
    for (const claim of this.encounterClaims) {
      if (!this.options.claimEncounter?.(claim.group, claim.choice)) {
        fail("encounter gift has no exclusive paid option source");
      }
    }
    this.encounterClaims = [];
    for (const check of this.resourceChecks) {
      const items = this.options.inventory?.(check.owner) ?? [];
      if (
        check.kind === "form"
        && !items.some(
          item =>
            item.className === "PokemonFormChangeItemModifier" && item.args[1] === check.item && item.stackCount > 0,
        )
      ) {
        fail("form item has no certified ownership for this individual");
      }
      if (
        check.kind === "held"
        && !items.some(
          item => item.className === "SpeciesStatBoosterModifier" && item.typePregenArgs?.[0] === check.item,
        )
      ) {
        fail("held evolution item has no certified ownership");
      }
      if (check.kind === "treasure") {
        const coins = items.filter(
          item => item.className === "EvoTrackerModifier" && item.args[1] === SpeciesId.GIMMIGHOUL,
        );
        const treasure = new Set(
          items
            .filter(item =>
              ["DamageMoneyRewardModifier", "MoneyMultiplierModifier", "ExtraModifierModifier"].includes(
                item.className,
              ),
            )
            .map(item => item.className),
        ).size;
        if (coins.length === 0 || Math.max(...coins.map(item => item.stackCount)) + treasure < check.count) {
          fail("treasure evolution has no certified item count");
        }
      }
    }
    this.resourceChecks = [];
  }
  private partyTypes(): Set<PokemonType> {
    const types = new Set<PokemonType>();
    for (const unit of this.units.values()) {
      if (unit.retired) {
        continue;
      }
      for (const t of pokemonDataTypes(unit.data)) {
        types.add(t);
      }
      // A replayed Clown effect is an independent native source, unlike a
      // submitted evolved companion. Its proven type may precede evolution.
      const shuffled = this.typeShuffle.get(unit.data.id);
      if (shuffled) {
        for (const type of pokemonDataTypes(shuffled)) {
          types.add(type);
        }
      }
    }
    return types;
  }
  private evolutionObservationOrder(party: PokemonData[]): PokemonData[] {
    const types = this.partyTypes();
    const pending = [...party];
    const ordered: PokemonData[] = [];
    while (pending.length > 0) {
      const index = pending.findIndex(p => {
        const unit = this.units.get(p.id);
        if (!unit || unit.retired) {
          return false;
        }
        const before = unit.data;
        const accepts = (fusion: boolean) => (rule: SpeciesFormEvolution, species: SpeciesId, formIndex: number) =>
          this.possibleEvolution(unit, p, rule, species, formIndex, fusion, types);
        const primary = evolutionRoute(
          before.species,
          before.formIndex,
          before.abilityIndex,
          p.species,
          p.formIndex,
          p.level,
          p.gender,
          accepts(false),
          change => this.possibleFormChange(before, p, change),
        );
        if (!primary) {
          return false;
        }
        return (
          !before.fusionSpecies
          || !p.fusionSpecies
          || !!evolutionRoute(
            before.fusionSpecies,
            number(before.fusionFormIndex),
            number(before.fusionAbilityIndex),
            p.fusionSpecies,
            number(p.fusionFormIndex),
            p.level,
            p.fusionGender,
            accepts(true),
            () => false,
          )
        );
      });
      if (index < 0) {
        // Cyclic/impossible claims reach the normal validator with only prior
        // verified types. They must not certify one another's submitted types.
        return [...ordered, ...pending];
      }
      const [p] = pending.splice(index, 1);
      ordered.push(p);
      for (const type of pokemonDataTypes(p)) {
        types.add(type);
      }
    }
    // This is only an evaluation order. Each predecessor is fully validated
    // before its new data becomes available to a dependent in observe().
    return ordered;
  }
  private possibleEvolution(
    unit: Unit,
    p: PokemonData,
    rule: SpeciesFormEvolution,
    species: SpeciesId,
    formIndex: number,
    fusion = false,
    verifiedTypes?: Set<PokemonType>,
  ): boolean {
    const available = this.possibleMoves(unit, p, species, formIndex);
    const before = unit.data;
    // Upstream conditionsFulfilled calls the primary Pokemon's getNature even
    // when evaluating its fused component.
    const nature = (data: PokemonData) =>
      (data.customPokemonData?.nature ?? -1) >= 0 ? data.customPokemonData.nature : data.nature;
    const env = this.environment;
    return possibleEvolution(rule, registry.getEvolutions(species), {
      id: p.id,
      seed: this.options.seed,
      level: p.level,
      gender: fusion ? p.fusionGender : p.gender,
      natures: new Set([nature(before), nature(p)]),
      moves: available,
      observedMoveSets: [new Set(moves(before)), new Set(moves(p))],
      partyTypes: verifiedTypes ?? this.partyTypes(),
      time: env?.time ?? this.options.time,
      biome: env?.biome ?? this.options.biome,
      friendship: Math.max(number(before.friendship), number(p.friendship)),
    });
  }
  private possibleFormChange(before: PokemonData, p: PokemonData, change: SpeciesFormChange): boolean {
    const trigger = change.findTrigger(SpeciesDefaultFormMatchTrigger);
    if (!trigger) {
      return true;
    }
    const nature = (data: PokemonData) =>
      (data.customPokemonData?.nature ?? -1) >= 0 ? data.customPokemonData.nature : data.nature;
    const rng = Phaser.Math.RND.state();
    try {
      return [nature(before), nature(p)].some(nature =>
        trigger.canChange({
          species: registry.getSpecies(change.speciesId),
          gender: p.gender,
          getNature: () => nature,
        } as Pokemon),
      );
    } finally {
      Phaser.Math.RND.state(rng);
    }
  }
  private possibleMoves(unit: Unit, p: PokemonData, species: SpeciesId, formIndex: number): Set<MoveId> {
    const available = new Set(unit.moves);
    const memory = this.grants.some(g => !g.used && g.kind === "memory" && g.eligible.has(p.id));
    for (const [level, move] of registry.getLevelMoves(species, formIndex)) {
      if ((level >= 0 || memory) && level <= p.level) {
        available.add(move);
      }
    }
    for (const grant of this.grants) {
      if (
        !grant.used
        && grant.kind === "tm"
        && grant.eligible.has(p.id)
        && registry.getTms(species, formIndex).includes(grant.value)
      ) {
        available.add(grant.value);
      }
    }
    return available;
  }
  private authorizeEvolutionMoves(unit: Unit, p: PokemonData, path: Route): void {
    for (const [index, evolution] of path.evolutions.entries()) {
      const source = path.sources[index];
      const levelMoves = registry.getLevelMoves(source.species, source.form);
      for (const condition of evolution.condition?.data ?? []) {
        const move =
          condition.key === EvoCondKey.MOVE || condition.key === EvoCondKey.TYROGUE
            ? condition.move
            : condition.key === EvoCondKey.MOVE_TYPE
              ? [...this.possibleMoves(unit, p, source.species, source.form)].find(
                  move => allMoves[move].type === condition.pkmnType,
                )
              : undefined;
        if (move == null || unit.moves.has(move)) {
          continue;
        }
        const natural = levelMoves.some(([level, id]) => id === move && level >= 0 && level <= p.level);
        const tm =
          !natural && registry.getTms(source.species, source.form).includes(move) && this.spend("tm", move, p.id);
        const memory =
          !natural
          && !tm
          && levelMoves.some(([level, id]) => id === move && level <= p.level)
          && this.spend("memory", 0, p.id);
        if (!natural && !tm && !memory) {
          fail("evolution move has no certified learning source");
        }
        unit.moves.add(move);
      }
    }
  }
  readonly itemTransfers = new Map<number, number>();
  readonly itemTrades = new Map<number, number>();
  knownIds(): ReadonlySet<number> {
    return new Set(this.units.keys());
  }
  private readonly units = new Map<number, Unit>();
  private readonly grants: Grant[] = [];
  private eligible = new Set<number>();
  private encounter = -1;
  private abilityChanges = 0;
  private passiveChanges = 0;
  private natureChanges = 0;
  private danceMoves = 0;
  private gifts = 0;
  private encounterOwners = new Set<number>();
  private clownOption: number | undefined;
  private fieryOption: number | undefined;
  private permanentAbility: { value: number; targets: Set<string>; remaining: number } | undefined;
  private typeShuffle = new Map<number, PokemonData>();
  private shuffledOwners = new Set<number>();
  private shop?: ShopOffer | undefined;
  private readonly rewarded = new Set<string>();
  private readonly rewardChoices = new Map<string, string>();
  private freshOffers = 0;
  start(party: PokemonData[], nativeStarters = false): void {
    validateAuditParty(party);
    for (const p of party) {
      if (nativeStarters && number(p.friendship) > registry.getSpecies(p.species).baseFriendship) {
        fail("starter friendship exceeds its native starting value");
      }
      if ([customAbility(p), customAbility(p, true), customPassive(p), customPassive(p, true)].some(a => a >= 0)) {
        fail("starter has unverified custom abilities");
      }
      if (customTypes(p).length > 0 || customTypes(p, true).length > 0) {
        fail("starter has unverified permanent types");
      }
      if ((p.customPokemonData?.nature ?? -1) !== -1) {
        fail("starter has an unverified mint nature");
      }
      if (p.moveset.some(m => (m.ppUp ?? 0) !== 0)) {
        fail("starter has unverified PP Ups");
      }
      this.add(p);
    }
    this.eligible = new Set(party.map(p => p.id));
  }
  private add(p: PokemonData): void {
    if (this.units.has(p.id)) {
      fail("individual ID reused");
    }
    this.units.set(p.id, {
      data: serialCopy(p),
      moves: new Set(moves(p)),
      pp: new Map(p.moveset.map(m => [m.moveId, m.ppUp ?? 0])),
      forms: new Set([`${p.species}:${p.formIndex}:0`]),
      retired: false,
    });
  }
  beginEncounter(type: number, nativeExperienceCap?: number, nativeVictories = 0): void {
    this.finishWave();
    this.levels.begin(nativeExperienceCap);
    this.friendship.begin(nativeVictories, type === ME.THE_EXPERT_POKEMON_BREEDER);
    this.itemTrades.clear();
    this.encounter = type;
    this.encounterOwners = new Set(this.eligible);
    this.clownOption = undefined;
    this.fieryOption = undefined;
    this.permanentAbility = undefined;
    this.typeShuffle.clear();
    this.shuffledOwners.clear();
    this.abilityChanges = type === ME.TRAINING_SESSION ? 1 : 0;
    this.passiveChanges = type === ME.WEIRD_DREAM ? 1 : 0;
    this.natureChanges = type === ME.TRAINING_SESSION || type === ME.SHADY_VITAMIN_DEALER ? 1 : 0;
    this.danceMoves = type === ME.DANCING_LESSONS || type === ME.BUG_TYPE_SUPERFAN ? 1 : 0;
    this.gifts = 0;
    this.shop = undefined;
    this.grants.length = 0;
    this.rewarded.clear();
    this.rewardChoices.clear();
    this.freshOffers = 0;
  }
  clownSelection(option: number, transformed?: PokemonData[]): void {
    if (this.encounter !== ME.CLOWNING_AROUND || !Number.isInteger(option) || option < 0 || option > 2) {
      fail("invalid clown option");
    }
    if (this.clownOption != null && this.clownOption !== option) {
      fail("clown options cannot be combined");
    }
    if (this.clownOption == null) {
      this.clownOption = option;
      this.encounterClaims.push({ group: "clown:option", choice: ["fight", "exchange", "types"][option] });
    }
    if (transformed) {
      if (
        option !== 2
        || transformed.length !== this.eligible.size
        || transformed.some(p => !this.eligible.has(p.id))
        || new Set(transformed.map(p => p.id)).size !== transformed.length
      ) {
        fail("clown type source differs from the selected party");
      }
      this.typeShuffle = new Map(transformed.map(p => [p.id, serialCopy(p)]));
    }
  }
  fierySelection(option: number): void {
    if (this.encounter !== ME.FIERY_FALLOUT || !Number.isInteger(option) || option < 0 || option > 2) {
      fail("invalid fiery option");
    }
    if (this.fieryOption != null && this.fieryOption !== option) {
      fail("fiery options cannot be combined");
    }
    if (this.fieryOption == null) {
      this.fieryOption = option;
      this.encounterClaims.push({ group: "fiery:option", choice: option === 1 ? "heat" : "reward" });
    }
  }
  authorizePermanentAbility(value: number, targets: { id: number; fusion: boolean }[]): void {
    if (
      !(
        (this.encounter === ME.CLOWNING_AROUND && this.clownOption === 0)
        || (this.encounter === ME.FIERY_FALLOUT && this.fieryOption === 1)
      )
      || targets.some(target => !this.eligible.has(target.id))
    ) {
      fail("permanent ability has no native encounter source");
    }
    this.permanentAbility = {
      value,
      targets: new Set(targets.map(target => `${target.id}:${target.fusion}`)),
      remaining: 1,
    };
  }
  private spendPermanentAbility(p: PokemonData, fusion: boolean): boolean {
    const grant = this.permanentAbility;
    if (
      !grant
      || grant.remaining <= 0
      || grant.value !== customAbility(p, fusion)
      || !grant.targets.has(`${p.id}:${fusion}`)
      || !!p.fusionSpecies !== fusion
    ) {
      return false;
    }
    grant.remaining--;
    return true;
  }
  grant(kind: GrantKind, value: number, eligible = this.eligible, choice?: RewardChoice): void {
    this.grants.push({ kind, value, eligible: new Set(eligible), used: false, choice });
  }
  private claim(choice?: RewardChoice): boolean {
    if (!choice) {
      return true;
    }
    const selected = this.rewardChoices.get(choice.group);
    if (
      (selected != null && selected !== choice.value)
      || this.options.claimReward?.(choice.group, choice.value) === false
    ) {
      return false;
    }
    this.rewardChoices.set(choice.group, choice.value);
    return true;
  }
  private spend(kind: GrantKind, value: number, id: number): boolean {
    const grant = this.grants.find(
      g => !g.used && g.kind === kind && g.value === value && g.eligible.has(id) && this.claim(g.choice),
    );
    if (!grant) {
      return false;
    }
    grant.used = true;
    return true;
  }
  offer(offer: ShopOffer): void {
    if (this.encounter === ME.CLOWNING_AROUND) {
      this.clownSelection(0);
    }
    if (this.encounter === ME.FIERY_FALLOUT) {
      if (this.fieryOption === 1) {
        fail("fiery heat option cannot also claim encounter rewards");
      }
      this.fierySelection(this.fieryOption ?? 0);
    }
    if (this.gifts > 0 && [ME.ABSOLUTE_AVARICE, ME.GLOBAL_TRADE_SYSTEM].includes(this.encounter)) {
      fail("direct gift cannot also claim an encounter reward shop");
    }
    if (this.encounter === ME.WEIRD_DREAM && offer.special) {
      const transformed = offer.custom?.functions[0] === "MEMORY_MUSHROOM";
      if (transformed !== this.gifts > 0) {
        fail("dream reward branch differs from its party transformation");
      }
    }
    if (!offer.copy && offer.rerolls === 0 && ++this.freshOffers > (this.encounter < 0 ? 1 : 8)) {
      fail("too many fresh reward offers in one wave");
    }
    this.shop = offer;
  }
  selection(row: number, cursor: number): void {
    if (row !== 1 || cursor < 0 || !this.shop) {
      return;
    }
    const option = this.shop.options[cursor];
    if (!option) {
      fail("reward cursor outside the verified offer");
    }
    const choice = { group: `reward:${this.freshOffers}`, value: rewardChoice(option) };
    const key = `${choice.group}:${choice.value}`;
    if (this.rewarded.has(key)) {
      return;
    }
    // A cancelled selection may be replaced, but only the choice that actually
    // explains an enhancement or physical item can consume this reward group.
    this.rewarded.add(key);
    this.reward(option, choice);
  }
  private reward(option: Option, choice: RewardChoice): void {
    const grant = (kind: GrantKind, value: number) => this.grant(kind, value, this.eligible, choice);
    if (option.id === "RARE_CANDY" || option.id === "RARER_CANDY") {
      this.levels.reward(this.eligible, option.id === "RARER_CANDY", () => this.claim(choice));
      this.friendship.reward(this.eligible, option.id === "RARER_CANDY", () => this.claim(choice));
    }
    if (option.id.startsWith("TM_")) {
      grant("tm", Number(option.args[0]));
    }
    if (option.id === "EVOLUTION_ITEM" || option.id === "RARE_EVOLUTION_ITEM") {
      grant("evolution", Number(option.args[0]));
    }
    if (option.id === "DNA_SPLICERS") {
      grant("fusion", 0);
    }
    if (option.id === "MINT") {
      grant("mint", Number(option.args[0]));
    }
    if (option.id === "MEMORY_MUSHROOM") {
      grant("memory", 0);
    }
    if (option.id === "PP_UP" || option.id === "PP_MAX") {
      grant("pp", option.id === "PP_UP" ? 1 : 3);
    }
  }
  capture(
    p: PokemonData,
    generated: ReturnType<typeof generatedPokemon>,
    source: string,
    gift = false,
    outgoing?: number,
    nativeFriendship?: number,
  ): void {
    validateAuditParty([p], "capture");
    const giftSource =
      gift
      && source === "MysteryEncounterOptionSelectedPhase"
      && [
        ME.THE_POKEMON_SALESMAN,
        ME.DANCING_LESSONS,
        ME.UNCOMMON_BREED,
        ME.ABSOLUTE_AVARICE,
        ME.GLOBAL_TRADE_SYSTEM,
        ME.WEIRD_DREAM,
      ].includes(this.encounter);
    if ((!giftSource && source !== "AttemptCapturePhase") || p.id !== generated.id || p.species !== generated.species) {
      fail("unverified capture source");
    }
    if (number(p.friendship) > (nativeFriendship ?? registry.getSpecies(p.species).baseFriendship)) {
      fail("capture friendship differs from its native source");
    }
    const dream = giftSource && this.encounter === ME.WEIRD_DREAM;
    if (giftSource && ++this.gifts > (dream ? this.encounterOwners.size : 1)) {
      fail("too many direct gifts in one encounter");
    }
    if (giftSource && this.encounter === ME.ABSOLUTE_AVARICE) {
      this.encounterClaims.push({ group: "avarice:option", choice: "gift" });
    }
    const traded =
      giftSource && [ME.GLOBAL_TRADE_SYSTEM, ME.WEIRD_DREAM].includes(this.encounter) && outgoing != null
        ? this.units.get(outgoing)
        : undefined;
    if (
      giftSource
      && [ME.GLOBAL_TRADE_SYSTEM, ME.WEIRD_DREAM].includes(this.encounter)
      && (!traded
        || traded.retired
        || !this.eligible.has(traded.data.id)
        || this.eligible.size < (dream ? 3 : 2)
        || (dream && !this.encounterOwners.has(traded.data.id))
        || traded.data.id === p.id)
    ) {
      fail("trade gift has no available outgoing individual");
    }
    if (traded && !dream && !!p.passive !== !!traded.data.passive) {
      fail("trade passive differs from its outgoing source");
    }
    const copied = moves(p).filter(move => !generated.moves.includes(move));
    const sketch =
      !giftSource
      && copied.length <= generated.moves.filter(move => move === MoveId.SKETCH).length
      && copied.every(move => !invalidSketchMoves.has(move))
      && p.moveset.length <= generated.moves.length;
    if (!equal(moves(p), generated.moves) && !sketch) {
      const added = moves(p).filter(move => !generated.moves.includes(move));
      const allowed =
        this.encounter === ME.UNCOMMON_BREED
          ? (speciesEggMoves[form(p.species, p.formIndex).getRootSpeciesId()] ?? [])
          : this.encounter === ME.DANCING_LESSONS
            ? DANCING_MOVES.filter(move => [...this.units.values()].some(unit => !unit.retired && unit.moves.has(move)))
            : [];
      if (
        !giftSource
        || added.length > 1
        || generated.moves.filter(move => !moves(p).includes(move)).length > 1
        || p.moveset.length < generated.moves.length
        || !added.every(move => allowed.includes(move))
      ) {
        fail("captured moves differ from the generated individual");
      }
    }
    for (const key of ["abilityIndex", "nature", "level", "gender"] as const) {
      if (p[key] !== generated[key]) {
        fail(`captured ${key} differs from its generated source`);
      }
    }
    for (const key of ["shiny", "passive"] as const) {
      if (!!p[key] !== !!generated[key]) {
        fail(`captured ${key} differs from its generated source`);
      }
    }
    for (const key of ["variant", "fusionSpecies"] as const) {
      if (number(p[key]) !== number(generated[key])) {
        fail(`captured ${key} differs from its generated source`);
      }
    }
    const path = evolutionRoute(
      generated.species,
      generated.formIndex,
      generated.abilityIndex,
      p.species,
      p.formIndex,
      p.level,
      p.gender,
      undefined,
      change => this.possibleFormChange(p, p, change),
    );
    if (!path) {
      fail("captured form has no legal change path");
    }
    this.requireResources(path, p.id);
    if ((p.customPokemonData?.nature ?? -1) !== (generated.customNature ?? -1)) {
      fail("capture custom nature differs from its generated source");
    }
    if (
      !equal(customTypes(p), generated.customTypes ?? [])
      || !equal(customTypes(p, true), generated.fusionCustomTypes ?? [])
    ) {
      fail("capture permanent types differ from their generated source");
    }
    if (
      customAbility(p) !== (generated.customAbility ?? -1)
      || customAbility(p, true) !== (generated.fusionCustomAbility ?? -1)
      || customPassive(p) !== (generated.customPassive ?? -1)
      || customPassive(p, true) !== (generated.fusionCustomPassive ?? -1)
    ) {
      fail("capture custom abilities differ from their generated source");
    }
    if (p.moveset.some((m, index) => (m.ppUp ?? 0) !== (dream ? (generated.ppUps?.[index] ?? 0) : 0))) {
      fail("capture has unverified PP Ups");
    }
    this.add(p);
    if (traded) {
      if (dream) {
        this.passiveChanges = 0;
      }
      traded.retired = true;
      this.eligible.delete(traded.data.id);
      this.itemTrades.set(traded.data.id, p.id);
    }
    this.eligible.add(p.id);
  }
  observe(party: PokemonData[]): void {
    // Engine snapshots contain Sets/class instances; audit records use their
    // normal upstream JSON representation (notably summonData.abilitiesApplied).
    party = serialCopy(party);
    validateAuditParty(party);
    this.shedinja(party);
    const ids = new Set(party.map(p => p.id));
    for (const p of this.evolutionObservationOrder(party)) {
      const unit = this.units.get(p.id);
      if (!unit || unit.retired) {
        fail("unknown or retired individual in party");
      }
      const before = unit.data;
      this.friendship.observe(p.id, before.friendship, p.friendship);
      if (customPassive(p) !== customPassive(before)) {
        fail("custom passive changed without a source");
      }
      if (customAbility(p) !== customAbility(before) && !this.spendPermanentAbility(p, false)) {
        fail("permanent ability changed without a source");
      }
      let typesShuffled = false;
      const expectedTypes = this.typeShuffle.get(p.id);
      const nativeTypeMatch =
        expectedTypes
        && !this.shuffledOwners.has(p.id)
        && equal(customTypes(p), customTypes(expectedTypes))
        && (!p.fusionSpecies || equal(customTypes(p, true), customTypes(expectedTypes, true)));
      if (!equal(customTypes(p), customTypes(before)) || nativeTypeMatch) {
        if (!nativeTypeMatch) {
          fail("permanent types changed without a source");
        }
        typesShuffled = true;
        this.shuffledOwners.add(p.id);
      }
      this.levels.observe(p.id, before.level, p.level);
      const path = evolutionRoute(
        before.species,
        before.formIndex,
        before.abilityIndex,
        p.species,
        p.formIndex,
        p.level,
        p.gender,
        (rule, species, formIndex) => this.possibleEvolution(unit, p, rule, species, formIndex),
        change => this.possibleFormChange(unit.data, p, change),
      );
      if (!path) {
        fail("species/form has no legal evolution path");
      }
      this.requireResources(path, p.id);
      this.authorizeEvolutionMoves(unit, p, path);
      for (const evo of path.evolutions) {
        if (evo.item && !this.spend("evolution", evo.item, p.id)) {
          fail("evolution item has no verified reward source");
        }
      }
      for (const key of path.visited) {
        unit.forms.add(key);
      }
      if (
        p.abilityIndex !== path.ability
        && (this.abilityChanges-- <= 0 || p.abilityIndex >= form(p.species, p.formIndex).getAbilityCount())
      ) {
        fail("ability changed without a source");
      }
      if (!!p.passive !== !!before.passive && (!p.passive || this.passiveChanges-- <= 0)) {
        fail("passive changed without a source");
      }
      if (!!p.shiny !== !!before.shiny) {
        fail("shiny changed after acquisition");
      }
      for (const key of ["variant", "gender"] as const) {
        if (number(p[key]) !== number(before[key])) {
          fail(`${key} changed after acquisition`);
        }
      }
      if (p.nature !== before.nature) {
        fail("original nature changed after acquisition");
      }
      const nature = p.customPokemonData?.nature ?? -1;
      if (
        nature !== (before.customPokemonData?.nature ?? -1)
        && !this.spend("mint", nature, p.id)
        && (nature < 0 || nature > 24 || !Number.isInteger(nature) || this.natureChanges-- <= 0)
      ) {
        fail("custom nature changed without a verified mint/encounter source");
      }
      this.fusion(unit, p, ids, typesShuffled);
      const available = this.levelMoves(unit, p);
      let sketchCopies = moves(before).filter(m => m === MoveId.SKETCH).length;
      for (const [level, move] of registry.getLevelMoves(p.species, p.formIndex)) {
        if (move === MoveId.SKETCH && level > before.level && level <= p.level) {
          sketchCopies++;
        }
      }
      const tms = new Set(registry.getTms(p.species, p.formIndex));
      if (p.fusionSpecies) {
        for (const move of registry.getTms(p.fusionSpecies, p.fusionFormIndex)) {
          tms.add(move);
        }
      }
      for (const move of moves(p)) {
        if (unit.moves.has(move) || available.has(move)) {
          unit.moves.add(move);
          continue;
        }
        if (tms.has(move) && this.spend("tm", move, p.id)) {
          unit.moves.add(move);
          continue;
        }
        if (
          this.danceMoves > 0
          && ((this.encounter === ME.DANCING_LESSONS && move === MoveId.REVELATION_DANCE)
            || (this.encounter === ME.BUG_TYPE_SUPERFAN && allMoves[move].type === 6))
        ) {
          this.danceMoves--;
          unit.moves.add(move);
          continue;
        }
        if (
          !invalidSketchMoves.has(move)
          && (sketchCopies > 0 || (available.has(MoveId.SKETCH) && this.spend("memory", 0, p.id)))
        ) {
          sketchCopies--;
          unit.moves.add(move);
          continue;
        }
        fail(`move ${move} has no legal learning source`);
      }
      for (const move of p.moveset) {
        const previous = unit.pp.get(move.moveId) ?? 0;
        let supplied = previous;
        const target = move.ppUp ?? 0;
        while (target > supplied) {
          const grant = this.grants.find(
            g => !g.used && g.kind === "pp" && g.eligible.has(p.id) && this.claim(g.choice),
          );
          if (!grant || allMoves[move.moveId].pp < 5) {
            fail("PP increase has no verified reward source");
          }
          grant.used = true;
          supplied = Math.min(3, supplied + grant.value);
        }
        unit.pp.set(move.moveId, Math.max(previous, target));
      }
      unit.data = serialCopy(p);
    }
    // Releasing a Pokemon is always allowed, but its ID cannot be resurrected.
    for (const [id, unit] of this.units) {
      if (!ids.has(id) && this.eligible.has(id)) {
        unit.retired = true;
      }
    }
    this.eligible = ids;
  }
  private shedinja(party: PokemonData[]): void {
    const parents = new Set<number>();
    for (const p of party.filter(p => !this.units.has(p.id))) {
      const parent = [...this.units.values()].find(unit => {
        const before = unit.data;
        const after = party.find(v => v.id === before.id);
        if (unit.retired || parents.has(before.id) || !after || p.level < 20 || p.level !== after.level) {
          return false;
        }
        const base =
          before.species === SpeciesId.NINCADA
          && after.species === SpeciesId.NINJASK
          && p.species === SpeciesId.SHEDINJA;
        const fusion =
          before.fusionSpecies === SpeciesId.NINCADA
          && after.fusionSpecies === SpeciesId.NINJASK
          && p.species === before.species
          && p.fusionSpecies === SpeciesId.SHEDINJA;
        if (!base && !fusion) {
          return false;
        }
        if ((p.customPokemonData?.nature ?? -1) !== -1) {
          return false;
        }
        if (customTypes(p).length > 0 || customTypes(p, true).length > 0) {
          return false;
        }
        if ([customAbility(p), customAbility(p, true), customPassive(p), customPassive(p, true)].some(a => a >= 0)) {
          return false;
        }
        if (
          p.abilityIndex !== before.abilityIndex
          || (base && p.formIndex !== 0)
          || (fusion && p.formIndex !== before.formIndex)
        ) {
          return false;
        }
        for (const key of [
          "fusionSpecies",
          "fusionFormIndex",
          "fusionAbilityIndex",
          "fusionVariant",
          "fusionGender",
        ] as const) {
          const expected =
            fusion && key === "fusionSpecies"
              ? SpeciesId.SHEDINJA
              : fusion && key === "fusionFormIndex"
                ? 0
                : number(before[key]);
          if (number(p[key]) !== expected) {
            return false;
          }
        }
        if (!!p.fusionShiny !== !!before.fusionShiny) {
          return false;
        }
        if (
          p.gender !== Gender.GENDERLESS
          || p.nature !== before.nature
          || !!p.shiny !== !!before.shiny
          || number(p.variant) !== number(before.variant)
          || !!p.passive !== !!before.passive
        ) {
          return false;
        }
        const allowed = new Set(unit.moves);
        for (const [level, move] of registry.getLevelMoves(SpeciesId.NINCADA)) {
          if (level <= p.level) {
            allowed.add(move);
          }
        }
        return p.moveset.every(move => allowed.has(move.moveId) && (move.ppUp ?? 0) <= (unit.pp.get(move.moveId) ?? 0));
      });
      if (!parent) {
        continue;
      }
      parents.add(parent.data.id);
      this.add(p);
      this.eligible.add(p.id);
    }
  }
  private levelMoves(unit: Unit, p: PokemonData): Set<number> {
    const result = new Set<number>();
    const species = new Map([...registry.getPrevolutionChain(p.species), p.species].map(id => [id, p.formIndex]));
    if (p.fusionSpecies) {
      species.set(p.fusionSpecies, number(p.fusionFormIndex));
      for (const id of registry.getPrevolutionChain(p.fusionSpecies)) {
        if (!species.has(id)) {
          species.set(id, number(p.fusionFormIndex));
        }
      }
    }
    for (const [id, index] of species) {
      const indexes = new Set([Math.min(index, Math.max(0, registry.getSpecies(id).forms.length - 1))]);
      for (const key of unit.forms) {
        const [species, index] = key.split(":").map(Number);
        if (species === id) {
          indexes.add(index);
        }
      }
      for (const i of indexes) {
        for (const [level, move] of registry.getLevelMoves(id, i)) {
          if (level <= p.level) {
            result.add(move);
          }
        }
      }
    }
    return result;
  }
  private fusion(unit: Unit, p: PokemonData, partyIds: Set<number>, typesShuffled = false): void {
    const before = unit.data;
    if (!p.fusionSpecies) {
      if (customTypes(p, true).length > 0) {
        fail("unfused individual has permanent fusion types");
      }
      if (customAbility(p, true) >= 0 || customPassive(p, true) >= 0) {
        fail("unfused individual has custom fusion abilities");
      }
      return;
    } // Unfusing destroys the secondary component, while learned moves remain.
    if (before.fusionSpecies) {
      const path = evolutionRoute(
        before.fusionSpecies,
        number(before.fusionFormIndex),
        number(before.fusionAbilityIndex),
        p.fusionSpecies,
        number(p.fusionFormIndex),
        p.level,
        p.fusionGender,
        (rule, species, formIndex) => this.possibleEvolution(unit, p, rule, species, formIndex, true),
        () => false, // Native changeForm only changes the primary component.
      );
      if (
        path
        && (typesShuffled || equal(customTypes(p, true), customTypes(before, true)))
        && customPassive(p, true) === customPassive(before, true)
        && (customAbility(p, true) === customAbility(before, true) || this.spendPermanentAbility(p, true))
        && (p.fusionAbilityIndex === path.ability
          || (this.abilityChanges > 0
            && number(p.fusionAbilityIndex) < form(p.fusionSpecies, number(p.fusionFormIndex)).getAbilityCount()
            && --this.abilityChanges >= 0))
      ) {
        this.requireResources(path, p.id);
        this.authorizeEvolutionMoves(unit, p, path);
        for (const evo of path.evolutions) {
          if (evo.item && !this.spend("evolution", evo.item, p.id)) {
            fail("fusion evolution item has no source");
          }
        }
        if (!!p.fusionShiny !== !!before.fusionShiny) {
          fail("fusion component shiny changed");
        }
        for (const key of ["fusionVariant", "fusionGender"] as const) {
          if (number(p[key]) !== number(before[key])) {
            fail("fusion component attributes changed");
          }
        }
        return;
      }
    }
    const other = [...this.units.values()].find(
      v =>
        !v.retired
        && v.data.id !== p.id
        && !partyIds.has(v.data.id)
        && v.data.species === p.fusionSpecies
        && v.data.formIndex === p.fusionFormIndex
        && v.data.abilityIndex === p.fusionAbilityIndex
        && !!v.data.shiny === !!p.fusionShiny
        && number(v.data.variant) === number(p.fusionVariant)
        && number(v.data.gender) === number(p.fusionGender),
    );
    if (!other || !this.spend("fusion", 0, p.id)) {
      fail("fusion has no consumed individual/reward source");
    }
    if (!equal(customTypes(p, true), customTypes(other.data))) {
      fail("fusion permanent types differ from their consumed source");
    }
    if (customAbility(p, true) !== customAbility(other.data) || customPassive(p, true) !== customPassive(other.data)) {
      fail("fusion custom abilities differ from their consumed source");
    }
    other.retired = true;
    this.itemTransfers.set(other.data.id, p.id);
    for (const move of other.moves) {
      unit.moves.add(move);
    }
    for (const [move, amount] of other.pp) {
      unit.pp.set(move, Math.max(unit.pp.get(move) ?? 0, amount));
    }
  }
}
