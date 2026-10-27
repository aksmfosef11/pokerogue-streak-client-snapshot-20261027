// SPDX-License-Identifier: AGPL-3.0-only

import { loggedInUser } from "#app/account";
import type { TurnCommand } from "#app/battle";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { BattleStyle } from "#enums/battle-style";
import { Command } from "#enums/command";
import { PartyUiMode } from "#enums/party-ui-mode";
import type { SwitchType } from "#enums/switch-type";
import { UiMode } from "#enums/ui-mode";
import { version } from "#package.json";
import type { CommandPhase } from "#phases/command-phase";
import type { EnemyCommandPhase } from "#phases/enemy-command-phase";
import type { SwitchPhase } from "#phases/switch-phase";
import type { OptionSelectItem } from "#types/ui-types";
import { PartyOption, PartyUiHandler } from "#ui/party-ui-handler";
import { pvpApi } from "./api";
import { applyBattlePlayer, type BattlePlayer } from "./battle-player";
import { battleRedirect, battleReturnPath, battleSourceVersion, isBattleClient, leaveBattle } from "./battle-route";
import { battleDigest, reseedBattle } from "./battle-state";
import { installEggProofHooks, refreshEggTickets } from "./egg-proof";
import { loadSession } from "./loader";
import { installAutoRegistrationRetry, installGenerationCapture, queueRegistrationCandidate } from "./log";
import { openRanking, partyMemberName, showRankedTeam, type RankedTeam } from "./ranking";
import { closePvpPanel, panelUi, showPvpPanel } from "./panel";
import { isPvpMatchActive, pvpEnabled, setPvpMatchActive } from "./state";

interface Decision {
  index: number;
  kind: string;
  choice: any;
  digest: string;
  seed: string;
}
interface Match {
  sourceVersion?: string;
  battlePath?: string;
  id: string;
  practice: boolean;
  opponent: string;
  session: Record<string, unknown>;
  decisions: Decision[];
  status: string;
  expires: number;
}
interface Status {
  playerIdentity?: BattlePlayer;
  sourceVersion?: string;
  battleVersion?: string;
  battlePath?: string;
  enginePaths?: Record<string, string>;
  newGamePath?: string;
  streakAttempt?: { id: string; runId: string; status: string; wins: number; endedAt: number; opponents: number };
  match?: Match;
  registered: boolean;
  defense?: { wins: number; losses: number };
  practiceEnabled: boolean;
  flags?: string[];
  streak: number;
  best: number;
  practiceStreak: number;
  practiceBest: number;
  audit?: { status: string; reason?: string; runId?: string };
  runs: Record<string, { id: string; candidate?: unknown; created: number; clearedAt?: number }>;
}
let match: Match | undefined;
let nextIndex = 0;
let committedTurn = -1;
let finishing = false;
// The terminal result flow owns its own retry/exit UI. A stopped replay must
// not replace it with a retry of a decision that can no longer be executed.
class ReplayStopped extends Error {}
let resumeTitle: (() => void) | undefined;
let newGamePath: string | undefined;
let menuExit: (() => void | Promise<void>) | undefined;
let rootBack = () => {
  void exitMenu();
};
let entryUrl: string | undefined;
let ordinaryDataReady = false;
let reopenLobby = false;
let previousBattleStyle: BattleStyle | undefined;
let menuStatus: Status | undefined;

async function exitMenu(): Promise<void> {
  closePvpPanel();
  pvpApi.setSource(undefined);
  const back = entryUrl ?? battleReturnPath();
  const path = new URL(back, location.href);
  // Browsing a source profile is only a URL/state change. Return without
  // restarting Phaser or re-downloading the client.
  history.replaceState(
    history.state,
    "",
    path.pathname === "/" || path.pathname === `/engines/${version}/` ? path.pathname + path.search : "/",
  );
  entryUrl = undefined;
  rootBack = () => {
    void exitMenu();
  };
  if (!ordinaryDataReady) {
    await globalScene.gameData.loadSystem();
    ordinaryDataReady = true;
  }
  await menuExit?.();
}

function returnToLobby(): void {
  closePvpPanel();
  match = undefined;
  finishing = false;
  setPvpMatchActive(false);
  globalScene.reset(false, false);
  if (previousBattleStyle != null) settings.general.battleStyle = previousBattleStyle;
  previousBattleStyle = undefined;
  reopenLobby = true;
  globalScene.phaseManager.toTitleScreen();
  globalScene.phaseManager.shiftPhase();
}

export function openLatestGame(): boolean {
  if (!newGamePath || isBattleClient()) {
    return false;
  }
  message("새 런은 최신 버전에서 시작합니다. 진행 중인 구버전 런이 있으면 먼저 그 버전으로 이어갑니다.", () =>
    location.assign(newGamePath!),
  );
  return true;
}
const activeKey = () => {
  const source = battleSourceVersion() ?? version;
  return `pvp:active:${source === "1.12.1.3" ? "" : source + ":"}${loggedInUser?.username}`;
};
function readMarker(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}
function clearMarker(key: string, id: string | null | undefined): void {
  try {
    if (localStorage.getItem(key) === id) {
      localStorage.removeItem(key);
    }
  } catch (err) {
    console.warn("연승전 매치 표식 정리 실패:", err);
  }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function options(items: OptionSelectItem[]): void {
  globalScene.ui.setMode(UiMode.OPTION_SELECT, {
    options: items,
    maxOptions: 7,
    yOffset: 48,
    blockCancelButton: true,
  });
}
function message(text: string, callback: () => void): void {
  closePvpPanel();
  globalScene.ui.setMode(UiMode.MESSAGE).then(() => globalScene.ui.showText(text, 0, callback, null, true));
}
function failure(err: unknown, retry: () => void): void {
  console.error("PvP:", err);
  message(`연승전: ${err instanceof Error ? err.message : String(err)}`, () =>
    options([
      {
        label: "다시 시도",
        handler: () => {
          retry();
          return true;
        },
      },
      {
        label: match?.status === "active" ? "기권 후 돌아가기" : "뒤로가기",
        handler: () => {
          if (isPvpMatchActive() && match?.status === "active") {
            void finish("forfeit");
          } else {
            void openMenu();
          }
          return true;
        },
      },
    ]),
  );
}
function stateDigest(): string {
  return battleDigest(globalScene);
}
function reseed(seed: string): void {
  reseedBattle(globalScene, seed);
}
async function lock(kind: string, choice: unknown): Promise<Decision> {
  if (!match) {
    throw new Error("진행 중인 매치가 없습니다");
  }
  const digest = stateDigest();
  const old = match.decisions[nextIndex];
  if (old && (old.digest !== digest || old.kind !== kind)) {
    await finish("invalid");
    throw new ReplayStopped();
  }
  const decision =
    old ?? (await pvpApi.request<Decision>("commit", { matchId: match.id, index: nextIndex, kind, choice, digest }));
  match.decisions[nextIndex] = decision;
  nextIndex++;
  reseed(decision.seed);
  return decision;
}
export function replayPvpCommand(phase: CommandPhase): boolean {
  if (!isPvpMatchActive() || !match) {
    return false;
  }
  const old = match.decisions[nextIndex];
  if (!old) {
    return false;
  }
  if (old.kind !== "turn") {
    void finish("invalid");
    return true;
  }
  const command = old.choice.command as TurnCommand;
  const cursor = command.move
    ? phase
        .getPokemon()
        .getMoveset()
        .findIndex(m => m.moveId === command.move!.move)
    : (command.cursor ?? 0);
  if (!phase.handleCommand(command.command, cursor, command.move?.useMode ?? command.args?.[0], command.move)) {
    void finish("invalid");
  }
  return true;
}
export function pausePvpTurn(phase: EnemyCommandPhase): boolean {
  if (!isPvpMatchActive() || committedTurn === globalScene.currentBattle.turn) {
    return false;
  }
  const submit = () => {
    void lock("turn", { command: clone(globalScene.currentBattle.turnCommands[0]) })
      .then(d => {
        globalScene.currentBattle.turnCommands[0] = d.choice.command;
        committedTurn = globalScene.currentBattle.turn;
        phase.start();
      })
      .catch(err => {
        if (!(err instanceof ReplayStopped)) {
          failure(err, submit);
        }
      });
  };
  submit();
  return true;
}
export function handlePvpSwitch(
  phase: SwitchPhase,
  fieldIndex: number,
  switchType: SwitchType,
  doReturn: boolean,
  isModal: boolean,
): boolean {
  if (!isPvpMatchActive() || !match) {
    return false;
  }
  const submit = (slotIndex: number, option: PartyOption) => {
    const choice = { slotIndex, option };
    const run = () => {
      void lock("switch", choice)
        .then(d => {
          const selected = d.choice as typeof choice;
          if (
            selected.slotIndex >= globalScene.currentBattle.getBattlerCount()
            && selected.slotIndex < globalScene.getPlayerParty().length
          ) {
            globalScene.phaseManager.unshiftNew(
              "SwitchSummonPhase",
              selected.option === PartyOption.PASS_BATON ? (2 as SwitchType) : switchType,
              fieldIndex,
              selected.slotIndex,
              doReturn,
            );
          }
          globalScene.ui.setMode(UiMode.MESSAGE).then(() => phase.end());
        })
        .catch(err => {
          if (!(err instanceof ReplayStopped)) {
            failure(err, run);
          }
        });
    };
    run();
  };
  const old = match.decisions[nextIndex];
  if (old) {
    if (old.kind === "switch") {
      submit(old.choice.slotIndex, old.choice.option);
    } else {
      void finish("invalid");
    }
  } else {
    globalScene.ui.setMode(
      UiMode.PARTY,
      isModal ? PartyUiMode.FAINT_SWITCH : PartyUiMode.POST_BATTLE_SWITCH,
      fieldIndex,
      submit,
      PartyUiHandler.FilterNonFainted,
    );
  }
  return true;
}
export function handlePvpVictory(end: () => void): boolean {
  if (!isPvpMatchActive()) {
    return false;
  }
  if (globalScene.getEnemyParty().every(p => p.isFainted())) {
    void finish("won");
  } else {
    end();
  }
  return true;
}
export function handlePvpLoss(): boolean {
  if (!isPvpMatchActive()) {
    return false;
  }
  void finish("lost");
  return true;
}
export function handlePvpForfeit(command: Command, resume: () => void): boolean {
  if (!isPvpMatchActive() || command !== Command.RUN) {
    return false;
  }
  message("기권하면 현재 연승이 끝납니다.\n기권하시겠습니까?", () => {
    globalScene.ui.setMode(UiMode.CONFIRM, {
      yesHandler: () => {
        void finish("forfeit");
      },
      noHandler: resume,
    });
  });
  return true;
}
async function finish(result: "won" | "lost" | "invalid" | "forfeit"): Promise<void> {
  if (!match || finishing) {
    return;
  }
  const endingMatch = match;
  const marker = activeKey();
  const request = {
    matchId: endingMatch.id,
    result,
    index: nextIndex,
    playerHP: globalScene.getPlayerParty().map(p => p.hp),
    enemyHP: globalScene.getEnemyParty().map(p => p.hp),
  };
  finishing = true;
  globalScene.phaseManager.clearPhaseQueue();
  const submit = async () => {
    try {
      const ended = await pvpApi.request<Match>("finish", request);
      const status = await pvpApi.request<Status>("status");
      // Another tab may have already started a new match under the same user.
      clearMarker(marker, endingMatch.id);
      const count = endingMatch.practice ? status.practiceStreak : status.streak;
      message(
        `연승전 ${ended.status === "won" ? "승리!" : ended.status === "invalid" ? "무효" : ended.status === "timeout" ? "시간 초과 패배" : "패배"}\n${!endingMatch.practice && status.streakAttempt && status.streakAttempt.status !== "active" ? `최종 ${status.streakAttempt.wins}연승 · 랭킹 등록 완료. 이 파티는 재도전할 수 없습니다.` : `현재 ${count}연승`}`,
        returnToLobby,
      );
    } catch (err) {
      finishing = false;
      failure(err, () => {
        finishing = true;
        void submit();
      });
    }
  };
  await submit();
}
async function loadMatch(data: Match, onReady: () => void): Promise<void> {
  const redirect = battleRedirect(data);
  if (redirect) {
    location.replace(redirect);
    return;
  }
  match = data;
  nextIndex = 0;
  committedTurn = -1;
  finishing = false;
  setPvpMatchActive(true);
  try {
    localStorage.setItem(activeKey(), data.id);
  } catch (err) {
    console.warn("연승전 매치 표식 저장 실패:", err);
  }
  previousBattleStyle ??= settings.general.battleStyle;
  settings.general.battleStyle = BattleStyle.SET;
  globalScene.ui.resetModeChain();
  await globalScene.ui.setMode(UiMode.MESSAGE);
  const raw = globalScene.gameData.parseSessionData(JSON.stringify(data.session));
  await loadSession(globalScene.gameData, raw);
  for (const p of [...globalScene.getPlayerParty(), ...globalScene.getEnemyParty()]) {
    p.calculateStats();
    p.hp = p.stats[0];
    p.status = null;
  }
  globalScene.disableMenu = true;
  message(
    `연승전 · 상대 ${data.opponent}\n${data.decisions.length > 0 ? "서버에 잠긴 선택을 재생합니다." : "선택은 서버에 저장되며 새로고침해도 유지됩니다."}`,
    onReady,
  );
}
export async function pvpBoot(onReady: () => void, onMenuExit?: () => void | Promise<void>): Promise<boolean> {
  installGenerationCapture();
  if (!pvpEnabled) {
    reopenLobby = false;
    return false;
  }
  installAutoRegistrationRetry();
  if (onMenuExit) menuExit = onMenuExit;
  if (!isBattleClient()) ordinaryDataReady = true;
  if (!isBattleClient()) {
    const { EggGachaUiHandler } = await import("#ui/egg-gacha-ui-handler");
    const { Egg } = await import("#data/egg");
    installEggProofHooks(globalScene.gameData, EggGachaUiHandler.prototype, Egg.prototype);
    void refreshEggTickets(true);
  }
  (await import("./runtime")).installBattleHooks({
    handlePvpForfeit,
    replayPvpCommand,
    pausePvpTurn,
    handlePvpSwitch,
    handlePvpVictory,
    handlePvpLoss,
  });
  resumeTitle = onReady;
  const marker = activeKey();
  const knownMatch = readMarker(marker);
  try {
    const status = await pvpApi.request<Status>("status");
    newGamePath = status.newGamePath;
    if (isBattleClient()) {
      applyBattlePlayer(globalScene.gameData, status.playerIdentity);
    }
    const latestMatch = readMarker(marker);
    if (latestMatch && latestMatch !== knownMatch && latestMatch !== status.match?.id) {
      // An older response must neither load nor clear a newer match which
      // another tab started while this request was in flight.
      leaveBattle();
      return true;
    }
    if (status.match?.status === "active") {
      await loadMatch(status.match, onReady);
      return true;
    }
    clearMarker(marker, latestMatch);
    if (isBattleClient() || reopenLobby) {
      reopenLobby = false;
      if (status.battleVersion && status.battleVersion !== version) {
        const path = battleRedirect({
          sourceVersion: status.sourceVersion,
          battlePath: status.battlePath,
          session: { gameVersion: status.battleVersion },
        });
        if (path) {
          location.replace(path);
          return true;
        }
      }
      const url = new URL(location.href);
      const requestedStart = url.searchParams.get("pvpStart");
      if (requestedStart === "ranked") {
        const teamId = url.searchParams.get("pvpTeam") ?? undefined;
        url.searchParams.delete("pvpStart");
        url.searchParams.delete("pvpTeam");
        history.replaceState(history.state, "", url.pathname + url.search);
        menuStatus = status;
        start(false, teamId);
      } else await openMenu();
      return true;
    }
  } catch (err) {
    console.warn("연승전 서버 상태 확인 실패:", err);
    if (readMarker(marker) || isPvpMatchActive()) {
      failure(err, () => {
        void pvpBoot(onReady).then(consumed => {
          // The original TitlePhase call already returned while offline. If
          // the match ended meanwhile, reload the ordinary save/title path.
          if (!consumed) {
            leaveBattle();
          }
        });
      });
      return true;
    }
  }
  return false;
}
type PartySource = { source: string; status: Status };
type RegisteredParty = { id: string; defense: { wins: number; losses: number }; canStart: boolean } & RankedTeam;
type PartyChoice = PartySource & { team: RegisteredParty };

function partyLabel(party: PartyChoice, index: number): string {
  const members = party.team.session.party;
  const names = members.slice(0, 2).map(partyMemberName).join(" · ");
  return `파티 ${index + 1} ${names}${members.length > 2 ? ` 외 ${members.length - 2}마리` : ""}`;
}

function pickSource(source: PartySource): void {
  pvpApi.setSource(source.source);
  menuStatus = source.status;
}

// Keep the active match recoverable after a refresh without reloading the menu.
function rememberBattleSource(source: string): void {
  const back = new URL(entryUrl ?? (isBattleClient() ? battleReturnPath() : location.href), location.href).pathname;
  history.replaceState(history.state, "", `/engines/${version}/?${new URLSearchParams({ pvpBattle: source, pvpReturn: back })}`);
}

function backOption(back: () => void): OptionSelectItem {
  return { label: "뒤로가기", handler: () => { back(); return true; } };
}

function selectParty(title: string, parties: PartySource[], choose: (party: PartySource) => void, back: () => void): void {
  if (parties.length === 1) {
    choose(parties[0]);
    return;
  }
  showPvpPanel({
    title,
    description: "확인할 파티를 선택하세요.",
    options: [
      ...parties.map((party, index) => ({
        label: `파티 ${index + 1}${party.status.streakAttempt?.status === "active" ? ` · ${party.status.streakAttempt.wins}연승` : party.status.defense ? ` · 방어 ${party.status.defense.wins}승 ${party.status.defense.losses}패` : ""}`,
        handler: () => { choose(party); return true; },
      })),
      backOption(back),
    ],
  });
}

async function openMenu(): Promise<void> {
  try {
    const initial = await pvpApi.request<Status>("status");
    const sources: string[] = [...Object.keys(initial.enginePaths ?? {})];
    if (!sources.length) sources.push(initial.sourceVersion ?? version);
    const parties = await Promise.all(sources.map(async source => ({
      source,
      status: source === initial.sourceVersion ? initial : await pvpApi.request<Status>("status", undefined, source),
    })));
    const activeMatch = parties.find(p => p.status.match?.status === "active");
    if (activeMatch) {
      pickSource(activeMatch);
      if (activeMatch.status.match?.session.gameVersion === version) rememberBattleSource(activeMatch.source);
      await loadMatch(activeMatch.status.match!, resumeTitle!);
      return;
    }
    const registered: PartyChoice[] = (await Promise.all(parties.map(async party => {
      if (!party.status.registered) return [];
      const teams = await pvpApi.request<RegisteredParty[]>("teams", undefined, party.source);
      return teams.map(team => ({ ...party, team }));
    }))).flat();
    const active = parties.filter(p => p.status.streakAttempt?.status === "active");
    let queued = false;
    let missingJournal = false;
    for (const party of parties) {
      const latest = Object.values(party.status.runs).filter(run => run.candidate)
        .sort((a, b) => (b.clearedAt ?? b.created) - (a.clearedAt ?? a.created))[0];
      if (!latest || party.status.flags?.length || party.status.audit?.status === "pending"
        || party.status.audit?.runId === latest.id || party.status.streakAttempt?.runId === latest.id) continue;
      if (queueRegistrationCandidate(latest.id, party.source)) queued = true;
      else missingJournal = true;
    }
    const pending = parties.some(p => p.status.audit?.status === "pending") || queued;
    const rejected = parties.find(p => p.status.audit?.status === "rejected")?.status.audit;
    const back = () => void openMenu();
    const showRegistered = () => {
      const view = (party: PartyChoice) => {
        pickSource(party);
        const defense = party.team.defense;
        showRankedTeam(panelUi(failure), party.team, `내 등록 파티 · 방어 ${defense.wins}승 ${defense.losses}패`, registered.length === 1 && !pending && !rejected && !missingJournal ? back : showRegistered);
      };
      const options: OptionSelectItem[] = registered.map((party, index) => ({
        label: `${partyLabel(party, index)} · 방어 ${party.team.defense.wins}승 ${party.team.defense.losses}패`,
        handler: () => { view(party); return true; },
      }));
      if (registered.length === 1 && !pending && !rejected && !missingJournal) { view(registered[0]); return; }
      showPvpPanel({
        title: "내 등록 파티",
        description: pending ? "클리어 파티를 자동으로 검증하고 있습니다. 진행 중인 연승전은 계속할 수 있습니다."
          : rejected ? `자동 등록을 완료하지 못했습니다. ${rejected.reason ?? ""}`
          : missingJournal ? "클리어 기록을 찾을 수 없어 자동 등록하지 못했습니다."
          : options.length ? "등록한 파티와 방어전 기록을 확인하세요." : "클래식 200층 클리어 시 파티가 자동 등록됩니다.",
        options: [...options, backOption(back)],
      });
    };
    const showActive = () => {
      if (!active.length) {
        showPvpPanel({ title: "내 연승전 진행중인 파티", description: "진행 중인 연승전이 없습니다.", options: [backOption(back)] });
        return;
      }
      selectParty("내 연승전 진행중인 파티", active, party => {
        pickSource(party);
        const view = async () => {
          try {
            const team = await pvpApi.request<Parameters<typeof showRankedTeam>[1]>("attempt/team");
            showRankedTeam(panelUi(failure), team, `진행중인 파티 · ${party.status.streakAttempt!.wins}연승`, detail);
          } catch (error) { failure(error, () => void view()); }
        };
        const detail = () => showPvpPanel({
          title: "내 연승전 진행중인 파티",
          description: `현재 ${party.status.streakAttempt!.wins}연승`,
          options: [
            { label: "파티 보기", handler: () => { void view(); return true; } },
            { label: "연승전 종료", handler: () => {
              message(`현재 ${party.status.streakAttempt!.wins}연승으로 종료하시겠습니까?\n이 파티는 재도전할 수 없습니다.`, () => globalScene.ui.setMode(UiMode.CONFIRM, {
                yesHandler: () => {
                  const end = async () => {
                    try { await pvpApi.request("end-streak", {}); message("연승 기록이 랭킹에 등록되었습니다.", back); }
                    catch (error) { failure(error, () => void end()); }
                  };
                  void end();
                },
                noHandler: detail,
              }));
              return true;
            } },
            backOption(active.length === 1 ? back : showActive),
          ],
        });
        detail();
      }, back);
    };
    const startStreak = () => {
      if (active.length) {
        selectParty("연승전 계속하기", active, party => { pickSource(party); start(false); }, back);
        return;
      }
      const eligible = registered.filter(p => p.team.canStart);
      if (!eligible.length) {
        showPvpPanel({ title: "연승전 시작하기", description: pending ? "클리어 파티를 검증하고 있습니다." : "클래식 200층을 클리어하면 새 파티가 자동 등록됩니다.", options: [backOption(back)] });
        return;
      }
      const choose = () => showPvpPanel({
        title: "연승전 시작하기", description: "시작할 파티를 선택하세요.",
        options: [...eligible.map((party, index) => ({
          label: partyLabel(party, index), handler: () => { confirm(party, index); return true; },
        })), backOption(back)],
      });
      const confirm = (party: PartyChoice, index: number) => showPvpPanel({
        title: "선택한 파티", description: partyLabel(party, index),
        options: [
          { label: "파티 보기", handler: () => { showRankedTeam(panelUi(failure), party.team, "선택한 파티", () => confirm(party, index)); return true; } },
          { label: "이 파티로 시작", handler: () => { pickSource(party); start(false, party.team.id); return true; } },
          backOption(choose),
        ],
      });
      choose();
    };
    showPvpPanel({
      title: "연승전",
      description: "",
      options: [
        { label: registered.length === 1 ? `내 등록 파티 · 방어 ${registered[0].team.defense.wins}승 ${registered[0].team.defense.losses}패` : "내 등록 파티", handler: () => { showRegistered(); return true; } },
        { label: "내 연승전 진행중인 파티", handler: () => { showActive(); return true; } },
        { label: "연승전 시작하기", handler: () => { startStreak(); return true; } },
        { label: "랭킹", handler: () => { void openRanking(panelUi(failure), back); return true; } },
        backOption(rootBack),
      ],
    });
  } catch (error) { failure(error, () => void openMenu()); }
}
function start(practice: boolean, teamId?: string): void {
  if (menuStatus?.battleVersion && menuStatus.battleVersion !== version && menuStatus.battlePath) {
    const parameters = new URLSearchParams({ pvpBattle: menuStatus.sourceVersion ?? battleSourceVersion() ?? version, pvpReturn: new URL(entryUrl ?? location.href).pathname, pvpStart: practice ? "practice" : "ranked" });
    if (teamId) parameters.set("pvpTeam", teamId);
    location.assign(
      `${menuStatus.battlePath}?${parameters}`,
    );
    return;
  }
  if (menuStatus?.sourceVersion) rememberBattleSource(menuStatus.sourceVersion);
  closePvpPanel();
  void globalScene.ui.setMode(UiMode.MESSAGE).then(() => globalScene.ui.showText("대전 상대를 찾고 있습니다…", 0));
  const attempt = async () => {
    try {
      const data = await pvpApi.request<Match>("matches", { practice, version, ...(teamId ? { teamId } : {}) });
      await loadMatch(data, resumeTitle!);
    } catch (err) {
      failure(err, () => void attempt());
    }
  };
  void attempt();
}
export function pvpMenuOptions(onBack?: () => void | Promise<void>): OptionSelectItem[] {
  return pvpEnabled
    ? [
        {
          label: "연승전",
          handler: () => {
            entryUrl = location.href;
            ordinaryDataReady = true;
            const cursor = globalScene.ui.getHandler().getCursor();
            if (onBack)
              menuExit = async () => {
                await onBack();
                globalScene.ui.getHandler().setCursor(cursor);
              };
            rootBack = () => {
              void exitMenu();
            };
            void openMenu();
            return true;
          },
        },
      ]
    : [];
}
