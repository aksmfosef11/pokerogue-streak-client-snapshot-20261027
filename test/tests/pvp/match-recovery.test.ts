// SPDX-License-Identifier: AGPL-3.0-only
import { loggedInUser } from "#app/account";
import { Command } from "#enums/command";
import { SwitchType } from "#enums/switch-type";
import { UiMode } from "#enums/ui-mode";
import { version } from "#package.json";
import { EnemyCommandPhase } from "#phases/enemy-command-phase";
import { SwitchPhase } from "#phases/switch-phase";
import { VictoryPhase } from "#phases/victory-phase";
import { GameManager } from "#test/framework/game-manager";
import { PartyOption } from "#ui/party-ui-handler";
import { createHmac } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pvpApi } from "../../../src/pvp/api";
import { battleDigest } from "../../../src/pvp/battle-state";
import {
  handlePvpForfeit,
  handlePvpLoss,
  handlePvpSwitch,
  handlePvpVictory,
  pausePvpTurn,
  pvpBoot,
  replayPvpCommand,
} from "../../../src/pvp/index";
import { installBattleHooks } from "../../../src/pvp/runtime";
// biome-ignore lint/performance/noNamespaceImport: Exercise the real controller with only its feature gate enabled.
import * as state from "../../../src/pvp/state";
import fixture from "../../fixtures/pvp/session.json";

describe("Native match controller failure and terminal recovery", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let server: any;
  let requests: { path: string; body?: any }[];
  let messages: { text: string; next?: (() => void) | null | undefined }[];
  let modes: { mode: UiMode; args: any[] }[];
  let reload: ReturnType<typeof vi.fn>;
  let offline: boolean;
  let loseCommit: boolean;
  let loseFinish: boolean;
  let wins: number;
  const handlers = {
    handlePvpForfeit,
    handlePvpLoss,
    handlePvpSwitch,
    handlePvpVictory,
    pausePvpTurn,
    replayPvpCommand,
  };
  const key = () => `pvp:active:${version === "1.12.1.3" ? "" : version + ":"}${loggedInUser?.username}`;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  beforeEach(async () => {
    state.setPvpMatchActive(false);
    const enabled = vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(false);
    game = new GameManager(phaser);
    await game.runToTitle();
    enabled.mockReturnValue(true);
    localStorage.clear();
    requests = [];
    messages = [];
    modes = [];
    offline = false;
    loseCommit = false;
    loseFinish = false;
    wins = 0;
    reload = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:8000/", hostname: "localhost", protocol: "http:", reload });
    vi.spyOn(game.scene.ui, "setMode").mockImplementation(async (mode, ...args) => {
      modes.push({ mode, args });
    });
    vi.spyOn(game.scene.ui, "showText").mockImplementation((text, _delay, next) => {
      messages.push({ text, next });
    });
    server = {
      id: "native-controller-match",
      practice: true,
      opponent: "native fixture",
      session: { ...structuredClone(fixture), gameVersion: version },
      decisions: [],
      status: "active",
      expires: Math.floor(Date.now() / 1000) + 1800,
    };
    vi.spyOn(pvpApi, "request").mockImplementation(async (path, body) => {
      requests.push({ path, body: structuredClone(body) });
      if (path === "egg-tickets") {
        return { epoch: 1, usedThrough: 0, tickets: [], certifiedIds: [] };
      }
      if (offline) {
        throw new Error("offline response");
      }
      if (path === "status") {
        return { match: structuredClone(server), practiceStreak: wins, streak: 0, runs: {}, flags: [] };
      }
      if (path === "commit") {
        const d = body as any;
        let stored = server.decisions[d.index];
        if (stored) {
          expect(stored.kind).toBe(d.kind);
          expect(stored.digest).toBe(d.digest);
        } else {
          expect(d.index).toBe(server.decisions.length);
          stored = {
            ...structuredClone(d),
            seed: createHmac("sha256", "native-controller-secret").update(String(d.index)).digest("hex"),
          };
          server.decisions.push(stored);
        }
        if (loseCommit) {
          loseCommit = false;
          throw new Error("commit saved but response lost");
        }
        return structuredClone(stored);
      }
      if (path === "finish") {
        if (server.status === "active") {
          if (body!.result === "won" || body!.result === "lost") {
            expect(body!.index).toBeGreaterThan(0);
            expect(body!.index).toBe(server.decisions.length);
          }
          server.status = body!.result;
          if (server.status === "won") {
            wins++;
          }
        }
        if (loseFinish) {
          loseFinish = false;
          throw new Error("result saved but response lost");
        }
        return structuredClone(server);
      }
      throw new Error(`unexpected controller request: ${path}`);
    });
  });
  afterEach(() => {
    installBattleHooks(handlers)();
    state.setPvpMatchActive(false);
    vi.unstubAllGlobals();
  });
  async function boot() {
    expect(await pvpBoot(vi.fn())).toBe(true);
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    expect(game.scene.getPlayerParty()).toHaveLength(3);
    requests = [];
    messages = [];
    modes = [];
  }
  async function retry() {
    await vi.waitFor(() => expect(messages.at(-1)?.text).toMatch(/연승전:/));
    messages.at(-1)!.next!();
    const menu = modes.findLast(m => m.mode === UiMode.OPTION_SELECT)!.args[0].options;
    expect(menu[0].label).toBe("다시 시도");
    menu[0].handler();
  }
  it("allows the ordinary title while the status service is offline and no match is known", async () => {
    offline = true;
    const system = () =>
      JSON.stringify({ ...game.scene.gameData.getSystemSaveData(), timestamp: 0 }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
    const old = system();
    expect(await pvpBoot(vi.fn())).toBe(false);
    expect(state.isPvpMatchActive()).toBe(false);
    expect(system()).toBe(old);
    expect(reload).not.toHaveBeenCalled();
  });
  it.each(["read", "write"])("loads the server's active match even if local marker %s fails", async operation => {
    if (operation === "write") {
      const write = localStorage.setItem;
      vi.spyOn(localStorage, "setItem").mockImplementation((name, value) => {
        if (name === key()) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        write.call(localStorage, name, value);
      });
    } else {
      const read = localStorage.getItem;
      vi.spyOn(localStorage, "getItem").mockImplementation(name => {
        if (name === key()) {
          throw new DOMException("storage blocked", "SecurityError");
        }
        return read.call(localStorage, name);
      });
    }
    expect(await pvpBoot(vi.fn())).toBe(true);
    expect(state.isPvpMatchActive()).toBe(true);
    expect(game.scene.getPlayerParty()).toHaveLength(3);
    expect(messages.some(m => m.text.startsWith("연승전 · 상대"))).toBe(true);
  });
  it.each(["won", "timeout"])("recovers the title when an offline boot retry finds a %s match", async status => {
    localStorage.setItem(key(), server.id);
    offline = true;
    const ready = vi.fn();
    expect(await pvpBoot(ready)).toBe(true);
    expect(localStorage.getItem(key())).toBe(server.id);
    offline = false;
    server.status = status;
    await retry();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(localStorage.getItem(key())).toBeFalsy();
    expect(ready).not.toHaveBeenCalled();
  });
  it("recovers a terminal match after the native loader failed during boot", async () => {
    const init = vi
      .spyOn(game.scene.gameData as any, "initSessionFromData")
      .mockRejectedValueOnce(new Error("session assets unavailable"));
    expect(await pvpBoot(vi.fn())).toBe(true);
    expect(state.isPvpMatchActive()).toBe(true);
    expect(init).toHaveBeenCalledOnce();
    server.status = "timeout";
    await retry();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });
  it.each(["won", "active"])("does not apply a stale %s boot response over another tab's newer match", async status => {
    server.status = status;
    localStorage.setItem(key(), server.id);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const respond = vi.mocked(pvpApi.request).getMockImplementation()!;
    let captured = false;
    vi.mocked(pvpApi.request).mockImplementation(async (path, body) => {
      const data = await respond(path, body);
      if (path === "status" && !captured) {
        captured = true;
        await barrier;
      }
      return data;
    });
    const init = vi.spyOn(game.scene.gameData as any, "initSessionFromData");
    const pending = pvpBoot(vi.fn());
    await vi.waitFor(() => expect(captured).toBe(true));
    localStorage.setItem(key(), "newer-match-in-other-tab");
    release();
    expect(await pending).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(localStorage.getItem(key())).toBe("newer-match-in-other-tab");
    expect(init).not.toHaveBeenCalled();
  });
  it("waits for a turn receipt and restores the first choice after its response was lost", async () => {
    await boot();
    const phase = new EnemyCommandPhase(0);
    const start = vi.spyOn(phase, "start").mockImplementation(() => {});
    const original = { command: Command.FIGHT, cursor: 0 };
    game.scene.currentBattle.turnCommands[0] = original;
    loseCommit = true;
    expect(pausePvpTurn(phase)).toBe(true);
    await vi.waitFor(() => expect(server.decisions).toHaveLength(1));
    expect(start).not.toHaveBeenCalled();
    game.scene.currentBattle.turnCommands[0] = { command: Command.FIGHT, cursor: 1 };
    await retry();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(game.scene.currentBattle.turnCommands[0]).toEqual(original);
    expect(server.decisions).toHaveLength(1);
    expect(game.scene.currentBattle.battleSeed).toBe(server.decisions[0].seed);
    expect(Reflect.get(game.scene.currentBattle, "battleSeedState")).toBeNull();
    expect(game.scene.rngSeedOverride).toBe(server.decisions[0].seed);
    expect(pausePvpTurn(phase)).toBe(false);
  });
  it.each([PartyOption.SEND_OUT, PartyOption.PASS_BATON])(
    "preserves a locked forced-switch target after response loss (option=%s)",
    async option => {
      await boot();
      const phase = new SwitchPhase(SwitchType.SWITCH, 0, true, false);
      const end = vi.spyOn(phase, "end").mockImplementation(() => {});
      const queue = vi.spyOn(game.scene.phaseManager, "unshiftNew");
      loseCommit = true;
      expect(handlePvpSwitch(phase, 0, SwitchType.SWITCH, false, true)).toBe(true);
      modes.findLast(m => m.mode === UiMode.PARTY)!.args[2](1, option);
      await vi.waitFor(() => expect(server.decisions).toHaveLength(1));
      expect(end).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
      await retry();
      await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
      expect(queue).toHaveBeenCalledWith(
        "SwitchSummonPhase",
        option === PartyOption.PASS_BATON ? SwitchType.BATON_PASS : SwitchType.SWITCH,
        0,
        1,
        false,
      );
      expect(server.decisions).toHaveLength(1);
      expect(server.decisions[0].choice).toEqual({ slotIndex: 1, option });
    },
  );
  it("replays an already locked forced switch without opening a new selection", async () => {
    await boot();
    server.decisions = [
      {
        index: 0,
        kind: "switch",
        choice: { slotIndex: 2, option: PartyOption.SEND_OUT },
        digest: battleDigest(game.scene),
        seed: "locked-switch-seed",
      },
    ];
    await boot();
    const phase = new SwitchPhase(SwitchType.SWITCH, 0, true, false);
    const end = vi.spyOn(phase, "end").mockImplementation(() => {});
    const queue = vi.spyOn(game.scene.phaseManager, "unshiftNew");
    handlePvpSwitch(phase, 0, SwitchType.SWITCH, false, true);
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    expect(modes.some(m => m.mode === UiMode.PARTY)).toBe(false);
    expect(requests.some(r => r.path === "commit")).toBe(false);
    expect(queue).toHaveBeenCalledWith("SwitchSummonPhase", SwitchType.SWITCH, 0, 2, false);
  });
  it("keeps the invalid-result exit visible when a replay digest differs", async () => {
    await boot();
    server.decisions = [
      {
        index: 0,
        kind: "turn",
        choice: { command: { command: Command.FIGHT, cursor: 0 } },
        digest: "0".repeat(64),
        seed: "must-not-execute",
      },
    ];
    await boot();
    const phase = new EnemyCommandPhase(0);
    const start = vi.spyOn(phase, "start").mockImplementation(() => {});
    game.scene.currentBattle.turnCommands[0] = { command: Command.FIGHT, cursor: 0 };
    pausePvpTurn(phase);
    await vi.waitFor(() => expect(server.status).toBe("invalid"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(start).not.toHaveBeenCalled();
    expect(requests.some(r => r.path === "commit")).toBe(false);
    expect(messages.at(-1)?.text).toMatch(/^연승전 무효\n/);
    messages.at(-1)!.next!();
    expect(reload).not.toHaveBeenCalled();
    expect(state.isPvpMatchActive()).toBe(false);
    expect(game.scene.getPlayerParty()).toHaveLength(0);
  });
  it("retries a persisted win once without campaign rewards or duplicate streak increments", async () => {
    await boot();
    const decision = new EnemyCommandPhase(0);
    const execute = vi.spyOn(decision, "start").mockImplementation(() => {});
    game.scene.currentBattle.turnCommands[0] = { command: Command.FIGHT, cursor: 0 };
    pausePvpTurn(decision);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const rewardStats = () => JSON.stringify({ ...game.scene.gameData.gameStats, playTime: 0 });
    const stats = rewardStats();
    for (const pokemon of game.scene.getEnemyParty()) {
      pokemon.hp = 0;
    }
    loseFinish = true;
    new VictoryPhase(2).start();
    await vi.waitFor(() => expect(server.status).toBe("won"));
    expect(wins).toBe(1);
    await retry();
    await vi.waitFor(() => expect(messages.at(-1)?.text).toContain("승리!"));
    expect(wins).toBe(1);
    expect(requests.filter(r => r.path === "finish")).toHaveLength(2);
    expect(rewardStats()).toBe(stats);
    expect(localStorage.getItem(key())).toBeFalsy();
    messages.at(-1)!.next!();
    expect(reload).not.toHaveBeenCalled();
    expect(state.isPvpMatchActive()).toBe(false);
    expect(game.scene.getPlayerParty()).toHaveLength(0);
  });
  it("does not erase a newer active-match marker from another tab when an old win returns", async () => {
    await boot();
    const decision = new EnemyCommandPhase(0);
    const execute = vi.spyOn(decision, "start").mockImplementation(() => {});
    game.scene.currentBattle.turnCommands[0] = { command: Command.FIGHT, cursor: 0 };
    pausePvpTurn(decision);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const respond = vi.mocked(pvpApi.request).getMockImplementation()!;
    vi.mocked(pvpApi.request).mockImplementationOnce(async (path, body) => {
      await barrier;
      return respond(path, body);
    });
    for (const pokemon of game.scene.getEnemyParty()) {
      pokemon.hp = 0;
    }
    new VictoryPhase(2).start();
    localStorage.setItem(key(), "newer-match-in-other-tab");
    release();
    await vi.waitFor(() => expect(messages.at(-1)?.text).toContain("승리!"));
    expect(localStorage.getItem(key())).toBe("newer-match-in-other-tab");
  });
});
