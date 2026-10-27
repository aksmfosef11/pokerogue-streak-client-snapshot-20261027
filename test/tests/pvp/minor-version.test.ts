// SPDX-License-Identifier: AGPL-3.0-only

import { version } from "#package.json";
import { Button } from "#enums/buttons";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pvpApi } from "../../../src/pvp/api";
import { battleRedirect, battleReturnPath, battleSourceVersion, leaveBattle } from "../../../src/pvp/battle-route";
import { pvpBoot, pvpMenuOptions } from "../../../src/pvp/index";
import { closePvpPanel } from "../../../src/pvp/panel";
// biome-ignore lint/performance/noNamespaceImport: Exercise the production feature gate.
import * as state from "../../../src/pvp/state";
import { setPvpMatchActive } from "../../../src/pvp/state";

function at(path: string) {
  const replace = vi.fn();
  const reload = vi.fn();
  vi.stubGlobal("location", { href: `http://localhost:8000${path}`, replace, reload });
  return { replace, reload };
}
let usedBattleBoot = false;
afterEach(async () => {
  closePvpPanel();
  if (usedBattleBoot) {
    const { installBattleHooks } = await import("../../../src/pvp/runtime");
    installBattleHooks({
      handlePvpForfeit: () => false,
      replayPvpCommand: () => false,
      pausePvpTurn: () => false,
      handlePvpSwitch: () => false,
      handlePvpVictory: () => false,
      handlePvpLoss: () => false,
    })();
    usedBattleBoot = false;
  }
  setPvpMatchActive(false);
  pvpApi.setSource(undefined);
  vi.unstubAllGlobals();
});
describe("Minor version battle handoff", () => {
  it("opens an older party lobby in the common engine without entering the ordinary title", async () => {
    at("/");
    const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
    await game.runToTitle();
    const assign = vi.fn();
    at(`/engines/${version}/?pvpBattle=1.12.1.2`);
    Object.assign(location, { assign });
    vi.stubGlobal("history", {
      state: null,
      replaceState: vi.fn((_state, _title, path) => {
        Object.assign(location, { href: new URL(path, location.href).href });
      }),
    });
    vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(true);
    const status = {
      registered: true,
      runs: {},
      streak: 4,
      best: 4,
      practiceStreak: 0,
      practiceBest: 0,
      sourceVersion: "1.12.1.2",
      battleVersion: version,
      battlePath: `/engines/${version}/`,
      enginePaths: {
        "1.12.1.2": "/engines/1.12.1.2/",
        "1.12.1.3": "/engines/1.12.1.3/",
        "1.12.2.0": "/engines/1.12.2.0/",
      },
    };
    vi.spyOn(pvpApi, "request").mockImplementation(async path => path === "teams" ? [] : status);
    vi.spyOn(game.scene.ui, "showText").mockImplementation((_text, _delay, next) => {
      next?.();
    });
    usedBattleBoot = true;
    expect(await pvpBoot(vi.fn())).toBe(true);
    expect(document.querySelector(".pvp-screen")).toBeNull();
    expect(Reflect.get(game.scene.ui.getHandler(), "options").map((c: { label: string }) => c.label)).toEqual([
      "내 등록 파티", "내 연승전 진행중인 파티", "연승전 시작하기", "랭킹", "뒤로가기",
    ]);
    expect(new URL(location.href).searchParams.get("pvpBattle")).toBe("1.12.1.2");
    expect(assign).not.toHaveBeenCalled();
    game.scene.ui.getHandler().processInput(Button.CANCEL);
    expect(new URL(location.href).searchParams.has("pvpBattle")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
  it("asks which registered party to use and sends the selected party ID", async () => {
    at("/");
    const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
    await game.runToTitle();
    vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(true);
    vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
    const teams = [1, 25].map((species, i) => ({
      id: `party-${i}`, defense: { wins: i, losses: 0 }, canStart: true,
      session: { party: [{ id: i + 1, species, level: 100 }], modifiers: [] },
    }));
    const status = { registered: true, runs: {}, streak: 0, best: 0, sourceVersion: version,
      battleVersion: version, enginePaths: { [version]: `/engines/${version}/` } };
    const request = vi.spyOn(pvpApi, "request").mockImplementation(async path => {
      if (path === "teams") return teams;
      if (path === "matches") throw new Error("test stop");
      return status;
    });
    pvpMenuOptions(vi.fn())[0].handler();
    await vi.waitFor(() => expect(game.scene.ui.mode).toBe(UiMode.OPTION_SELECT));
    const click = (label: string) => {
      const handler = game.scene.ui.getHandler();
      const options = Reflect.get(handler, "options") as { label: string }[];
      const index = options.findIndex(o => o.label === label);
      expect(index).toBeGreaterThanOrEqual(0);
      Reflect.get(handler, "setScrollCursor").call(handler, 0);
      handler.setCursor(index);
      handler.processInput(Button.ACTION);
    };
    click("연승전 시작하기");
    const choices = Reflect.get(game.scene.ui.getHandler(), "options") as { label: string }[];
    expect(choices.filter(o => o.label.startsWith("파티 "))).toHaveLength(2);
    click(choices[1].label);
    expect(request.mock.calls.some(([path]) => path === "matches")).toBe(false);
    expect((Reflect.get(game.scene.ui.getHandler(), "options") as { label: string }[]).some(o => o.label === "파티 보기")).toBe(true);
    click("이 파티로 시작");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("matches", expect.objectContaining({ teamId: "party-1" })));
  });
  it("closes the ordinary lobby to its previous native title without navigation or reloading saves", async () => {
    const nav = at("/");
    const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
    await game.runToTitle();
    vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(true);
    vi.spyOn(pvpApi, "request").mockResolvedValue({
      registered: false,
      runs: {},
      streak: 0,
      best: 0,
      practiceStreak: 0,
      practiceBest: 0,
    });
    vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
    const back = vi.fn(async () => {
      await game.scene.ui.setMode(UiMode.TITLE, { options: [{ label: "연승전", handler: () => true }] });
    });
    const load = vi.spyOn(game.scene.gameData, "loadSystem");
    pvpMenuOptions(back)[0].handler();
    await vi.waitFor(() => expect(game.scene.ui.mode).not.toBe(UiMode.TITLE));
    expect(Reflect.get(game.scene.ui.getHandler(), "options").at(-1).label).toBe("뒤로가기");
    game.scene.ui.getHandler().processInput(Button.CANCEL);
    await vi.waitFor(() => expect(back).toHaveBeenCalledOnce());
    expect(nav.reload).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(game.scene.ui.mode).toBe(UiMode.TITLE);
  });
  it("routes the registered source to the pinned battle engine and preserves the return path", () => {
    at("/");
    const engine = version === "1.12.2.0" ? "1.12.1.3" : "1.12.2.0";
    expect(
      battleRedirect({ sourceVersion: version, battlePath: `/engines/${engine}/`, session: { gameVersion: engine } }),
    ).toBeTypeOf("string");
  });
  it("does not switch an existing match which already uses this native engine", () => {
    at("/");
    expect(battleRedirect({ session: { gameVersion: version } })).toBeUndefined();
  });
  it("rejects unknown engine routes and external redirects", () => {
    at("/");
    expect(() =>
      battleRedirect({ battlePath: "https://evil.invalid/", session: { gameVersion: "9.9.9.9" } }),
    ).toThrow();
    at(`/engines/${version}/?pvpBattle=1.12.1.2&pvpReturn=//evil.invalid/`);
    expect(battleReturnPath()).toBe("/");
  });
  it("uses the source profile only for PvP requests and returns to the original campaign", async () => {
    const { replace } = at(`/engines/${version}/?pvpBattle=1.12.1.2&pvpReturn=%2Fengines%2F1.12.1.2%2F`);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    expect(battleSourceVersion()).toBe("1.12.1.2");
    await pvpApi.request("status");
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "PKR-Client-Version": version,
      "PKR-PVP-Source-Version": "1.12.1.2",
    });
    leaveBattle();
    expect(replace).toHaveBeenCalledWith("/engines/1.12.1.2/");
  });
  it("loads no ordinary save and performs no ordinary writes in the battle-only client", async () => {
    at("/");
    const game = new GameManager(new Phaser.Game({ type: Phaser.HEADLESS }));
    await game.runToTitle();
    at(`/engines/${version}/?pvpBattle=1.12.1.2`);
    vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(true);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(pvpApi, "request").mockResolvedValue({ playerIdentity: { trainerId: 1234, secretId: 5678, gender: 2 } });
    expect(await game.scene.gameData.loadSystem()).toBe(true);
    expect(game.scene.gameData.trainerId).toBe(1234);
    expect(game.scene.gameData.secretId).toBe(5678);
    expect(await game.scene.gameData.saveSystem()).toBe(true);
    game.scene.newBattle();
    expect(await game.scene.gameData.saveAll()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
