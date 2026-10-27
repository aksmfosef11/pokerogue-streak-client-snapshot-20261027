// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { allMoves } from "#data/data-lists";
import { getModifierTypeFuncById, ModifierTypeGenerator } from "#modifiers/modifier-type";
import type { OptionSelectItem } from "#types/ui-types";
import { pvpApi } from "./api";
import heldModifiers from "./held-modifiers.json";
import { pvpT } from "./i18n";

interface PartyMember {
  id: number;
  species: number;
  level: number;
  fusionSpecies?: number;
  formIndex?: number;
  shiny?: boolean;
  variant?: number;
  moveset?: { moveId: number }[];
}
interface Item {
  typeId: string;
  typePregenArgs?: unknown[];
  className: string;
  args: number[];
  stackCount: number;
}
export interface RankedTeam {
  session: { party: PartyMember[]; modifiers: Item[] };
}
export interface RankingEntry {
  id: string;
  rank: number;
  position: number;
  username: string;
  wins: number;
  result: string;
  endedAt: number;
  isSelf: boolean;
  party: PartyMember[];
}
export interface RankingPage {
  version: string;
  page: number;
  pageSize: number;
  total: number;
  entries: RankingEntry[];
  self: RankingEntry | null;
}
export interface RankingUi {
  message: (text: string, next: () => void) => void;
  options: (items: OptionSelectItem[]) => void;
  failure: (error: unknown, retry: () => void) => void;
}

function action(label: string, run: () => void): OptionSelectItem {
  return {
    label,
    keepOpen: true,
    handler: () => {
      run();
      return true;
    },
  };
}
export function partyMemberName(p: PartyMember): string {
  const name = speciesDataRegistry.getSpecies(p.species).getName();
  return p.fusionSpecies ? `${name}+${speciesDataRegistry.getSpecies(p.fusionSpecies).getName()}` : name;
}
function itemType(item: Item) {
  const factory = getModifierTypeFuncById(item.typeId);
  let type = factory?.();
  if (type instanceof ModifierTypeGenerator) {
    type = type.generateType([], item.typePregenArgs) ?? type;
  }
  return type;
}
function itemLabel(item: Item): string {
  return `${itemType(item)?.name ?? item.typeId} ×${item.stackCount}`;
}
const getResults = (): Record<string, string> => ({
  lost: pvpT("lost"),
  forfeit: pvpT("forfeit"),
  timeout: pvpT("timeout"),
  invalid: pvpT("invalidEnd"),
});

export function showRankedTeam(ui: RankingUi, team: RankedTeam, title: string, back: () => void): void {
  const show = () => {
    const items: OptionSelectItem[] = team.session.party.map(p => {
      const species = speciesDataRegistry.getSpecies(p.species);
      return {
        ...action(`${partyMemberName(p)} Lv.${p.level}`, () => showMember(p)),
        iconsConfig: [
          {
            name: species.getIconAtlasKey(p.formIndex, p.shiny, p.variant),
            frame: species.getIconId(false, p.formIndex, p.shiny, p.variant),
            scale: 0.5,
          },
        ],
      };
    });
    const owners = new Set(team.session.party.map(p => p.id));
    const shared = team.session.modifiers.filter(m => !heldModifiers.includes(m.className) || !owners.has(m.args[0]));
    if (shared.length > 0) {
      items.push(action(pvpT("commonItems"), () => showItems(shared, show)));
    }
    items.push(action(pvpT("back"), back));
    ui.message(`${title}\n${pvpT("selectPokemonHint")}`, () => ui.options(items));
  };
  const showItems = (items: Item[], next: () => void) => {
    const options: OptionSelectItem[] = items.map(m =>
      action(itemLabel(m), () => {
        ui.message(`${itemLabel(m)}\n${itemType(m)?.getDescription() ?? ""}`, () => showItems(items, next));
      }),
    );
    options.push(action(pvpT("back"), next));
    ui.options(options);
  };
  const showMember = (p: PartyMember) => {
    const held = team.session.modifiers.filter(m => heldModifiers.includes(m.className) && m.args[0] === p.id);
    const moves = (p.moveset ?? []).map(m => allMoves[m.moveId]?.name ?? String(m.moveId));
    ui.message(
      `${partyMemberName(p)} Lv.${p.level} · ${pvpT("allIv31")}\n${pvpT("moves")}: ${moves.join(" / ")}\n${pvpT("heldItemsCount", { count: held.length })}`,
      () => {
        const items = held.map(m =>
          action(itemLabel(m), () =>
            ui.message(`${itemLabel(m)}\n${itemType(m)?.getDescription() ?? ""}`, () =>
              ui.options([action(pvpT("back"), () => showMember(p))]),
            ),
          ),
        );
        items.push(action(pvpT("back"), show));
        ui.options(items);
      },
    );
  };
  show();
}

export async function openRanking(ui: RankingUi, back: () => void, page = 0): Promise<void> {
  try {
    const data = await pvpApi.request<RankingPage>(`leaderboard?page=${page}`);
    const reload = (index = data.page) => {
      void openRanking(ui, back, index);
    };
    const results = getResults();
    const items = data.entries.map(entry =>
      action(
        entry.isSelf
          ? pvpT("rankUserOwn", { rank: entry.rank, username: entry.username, wins: entry.wins })
          : pvpT("rankUser", { rank: entry.rank, username: entry.username, wins: entry.wins }),
        () => {
          const load = async () => {
            try {
              const team = await pvpApi.request<RankedTeam>(`leaderboard/team?id=${encodeURIComponent(entry.id)}`);
              showRankedTeam(
                ui,
                team,
                pvpT("rankSummary", {
                  username: entry.username,
                  wins: entry.wins,
                  result: results[entry.result] ?? entry.result,
                }),
                reload,
              );
            } catch (error) {
              ui.failure(error, () => {
                void load();
              });
            }
          };
          void load();
        },
      ),
    );
    if (data.page > 0) {
      items.push(action(pvpT("previousPage"), () => reload(data.page - 1)));
    }
    if ((data.page + 1) * data.pageSize < data.total) {
      items.push(action(pvpT("nextPage"), () => reload(data.page + 1)));
    }
    if (data.self && !data.entries.some(e => e.id === data.self!.id)) {
      items.push(action(pvpT("goToMyBest"), () => reload(Math.floor((data.self!.position - 1) / data.pageSize))));
    }
    items.push(
      action(pvpT("refresh"), () => reload()),
      action(pvpT("back"), back),
    );
    const own = data.self
      ? pvpT("myBestRank", { rank: data.self.rank, wins: data.self.wins })
      : pvpT("noMyRecord");
    ui.message(
      data.total > 0
        ? pvpT("rankingHeader", {
            current: data.page + 1,
            totalPage: Math.ceil(data.total / data.pageSize),
            own,
            total: data.total,
          })
        : pvpT("noCompletedStreaks"),
      () => ui.options(items),
    );
  } catch (error) {
    ui.failure(error, () => {
      void openRanking(ui, back, page);
    });
  }
}
