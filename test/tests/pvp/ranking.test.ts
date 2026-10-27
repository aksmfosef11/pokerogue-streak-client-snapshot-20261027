// SPDX-License-Identifier: AGPL-3.0-only
import { GameManager } from "#test/framework/game-manager";
import type { OptionSelectItem } from "#types/ui-types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pvpApi } from "../../../src/pvp/api";
import { openRanking, type RankingPage, type RankingUi } from "../../../src/pvp/ranking";
import fixture from "../../fixtures/pvp/streak-item-session.json";

describe("Final streak ranking and archived party menus", () => {
  let ui: RankingUi;
  let options: OptionSelectItem[];
  let messages: string[];
  let data: RankingPage;
  const back = vi.fn();
  beforeAll(async () => {
    const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
    await game.runToTitle();
  });
  beforeEach(() => {
    options = [];
    messages = [];
    back.mockClear();
    ui = {
      message: (text, next) => {
        messages.push(text);
        next();
      },
      options: items => {
        options = items;
      },
      failure: vi.fn(),
    };
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `entry-${i}`,
      rank: 1,
      position: i + 1,
      username: `trainer${i}`,
      wins: 7,
      result: "lost",
      endedAt: 100,
      isSelf: false,
      party: fixture.party,
    }));
    data = {
      version: "1.12.1.3",
      page: 0,
      pageSize: 5,
      total: 7,
      entries,
      self: { ...entries[0], id: "mine", position: 7, isSelf: true },
    };
    vi.spyOn(pvpApi, "request").mockImplementation(async path => {
      if (path.startsWith("leaderboard/team?")) {
        return { session: fixture };
      }
      return data;
    });
  });
  it("shows shared ranks, final wins, paging and the correct page for a tied self record", async () => {
    await openRanking(ui, back);
    expect(messages[0]).toContain("내 최고 1위 · 7연승");
    expect(options[0].label).toBe("1위 trainer0 · 7연승");
    expect(options.some(o => o.label === "이전 페이지")).toBe(false);
    options.find(o => o.label === "내 최고 기록으로")!.handler();
    await vi.waitFor(() => expect(pvpApi.request).toHaveBeenCalledWith("leaderboard?page=1"));
  });
  it("loads a finalized party and displays its moves and restored held-item quantities", async () => {
    await openRanking(ui, back);
    options[0].handler();
    await vi.waitFor(() => expect(messages.at(-1)).toContain("최종 7연승"));
    expect(pvpApi.request).toHaveBeenCalledWith("leaderboard/team?id=entry-0");
    expect(options[0].label).toContain("Lv.100");
    options[0].handler();
    expect(messages.at(-1)).toContain("개체값 전부 31");
    expect(options.some(o => o.label.includes("×7"))).toBe(true);
    expect(options.some(o => o.label.includes("×3"))).toBe(true);
    expect(options.some(o => o.label.includes("×2"))).toBe(true);
    expect(options).toHaveLength(10);
  });
  it("supports an empty ranking without a fake party or a broken navigation option", async () => {
    data = { ...data, entries: [], self: null, total: 0 };
    await openRanking(ui, back);
    expect(messages[0]).toContain("종료된 연승전이 없습니다");
    expect(options.map(o => o.label)).toEqual(["새로고침", "뒤로가기"]);
    options.at(-1)!.handler();
    expect(back).toHaveBeenCalledOnce();
  });
  it("offers a retry when ranking retrieval fails", async () => {
    vi.mocked(pvpApi.request).mockRejectedValueOnce(new Error("offline"));
    await openRanking(ui, back, 2);
    expect(ui.failure).toHaveBeenCalledWith(expect.any(Error), expect.any(Function));
  });
});
