// SPDX-License-Identifier: AGPL-3.0-only
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { allMoves } from "#data/data-lists";
import { getModifierTypeFuncById, ModifierTypeGenerator } from "#modifiers/modifier-type";
import type { OptionSelectItem } from "#types/ui-types";
import { pvpApi } from "./api";
import heldModifiers from "./held-modifiers.json";

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
const results: Record<string, string> = { lost: "패배", forfeit: "종료", timeout: "시간 초과", invalid: "무효 종료" };

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
      items.push(action("공통 아이템", () => showItems(shared, show)));
    }
    items.push(action("뒤로가기", back));
    ui.message(`${title}\n포켓몬을 선택하면 기술과 소지품을 볼 수 있습니다.`, () => ui.options(items));
  };
  const showItems = (items: Item[], next: () => void) => {
    const options: OptionSelectItem[] = items.map(m =>
      action(itemLabel(m), () => {
        ui.message(`${itemLabel(m)}\n${itemType(m)?.getDescription() ?? ""}`, () => showItems(items, next));
      }),
    );
    options.push(action("뒤로가기", next));
    ui.options(options);
  };
  const showMember = (p: PartyMember) => {
    const held = team.session.modifiers.filter(m => heldModifiers.includes(m.className) && m.args[0] === p.id);
    const moves = (p.moveset ?? []).map(m => allMoves[m.moveId]?.name ?? String(m.moveId));
    ui.message(
      `${partyMemberName(p)} Lv.${p.level} · 개체값 전부 31\n기술: ${moves.join(" / ")}\n소지품 ${held.length}종`,
      () => {
        const items = held.map(m =>
          action(itemLabel(m), () =>
            ui.message(`${itemLabel(m)}\n${itemType(m)?.getDescription() ?? ""}`, () =>
              ui.options([action("뒤로가기", () => showMember(p))]),
            ),
          ),
        );
        items.push(action("뒤로가기", show));
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
    const items = data.entries.map(entry =>
      action(`${entry.rank}위 ${entry.username}${entry.isSelf ? " (나)" : ""} · ${entry.wins}연승`, () => {
        const load = async () => {
          try {
            const team = await pvpApi.request<RankedTeam>(`leaderboard/team?id=${encodeURIComponent(entry.id)}`);
            showRankedTeam(
              ui,
              team,
              `${entry.username} · 최종 ${entry.wins}연승 · ${results[entry.result] ?? entry.result}`,
              reload,
            );
          } catch (error) {
            ui.failure(error, () => {
              void load();
            });
          }
        };
        void load();
      }),
    );
    if (data.page > 0) {
      items.push(action("이전 페이지", () => reload(data.page - 1)));
    }
    if ((data.page + 1) * data.pageSize < data.total) {
      items.push(action("다음 페이지", () => reload(data.page + 1)));
    }
    if (data.self && !data.entries.some(e => e.id === data.self!.id)) {
      items.push(action("내 최고 기록으로", () => reload(Math.floor((data.self!.position - 1) / data.pageSize))));
    }
    items.push(
      action("새로고침", () => reload()),
      action("뒤로가기", back),
    );
    const own = data.self ? `내 최고 ${data.self.rank}위 · ${data.self.wins}연승` : "내 종료 기록 없음";
    ui.message(
      data.total > 0
        ? `연승전 랭킹 · ${data.page + 1}/${Math.ceil(data.total / data.pageSize)}\n${own} · 종료 기록 ${data.total}개`
        : `연승전 랭킹\n종료된 연승전이 없습니다. 종료 시 파티와 기록이 등록됩니다.`,
      () => ui.options(items),
    );
  } catch (error) {
    ui.failure(error, () => {
      void openRanking(ui, back, page);
    });
  }
}
