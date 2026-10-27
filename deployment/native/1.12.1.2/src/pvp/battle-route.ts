// SPDX-License-Identifier: AGPL-3.0-only
import { version } from "#package.json";

const nativeVersion = /^\d+\.\d+\.\d+\.\d+$/u;
export function battleSourceVersion(): string | undefined {
  if (typeof location === "undefined" || typeof location.href !== "string") {
    return;
  }
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return;
  }
  const source = url.searchParams.get("pvpBattle");
  if (source && nativeVersion.test(source) && url.pathname === `/engines/${version}/`) {
    return source;
  }
}
export const isBattleClient = () => !!battleSourceVersion();

export function battleReturnPath(): string {
  const url = new URL(location.href);
  const path = url.searchParams.get("pvpReturn");
  const source = battleSourceVersion();
  return path === "/" || (source && path && /^\/engines\/\d+\.\d+\.\d+\.\d+\/$/u.test(path)) ? path : "/";
}

export function battleRedirect(match: {
  sourceVersion?: string | undefined;
  battlePath?: string | undefined;
  session: Record<string, unknown>;
}): string | undefined {
  const engine = match.session.gameVersion;
  if (engine === version) {
    return;
  }
  if (typeof engine !== "string" || !nativeVersion.test(engine) || match.battlePath !== `/engines/${engine}/`) {
    throw new Error("대전을 열 수 없습니다. 화면을 새로고침하세요.");
  }
  const source = match.sourceVersion ?? version;
  if (!nativeVersion.test(source)) {
    throw new Error("파티 정보를 확인할 수 없습니다.");
  }
  const back = isBattleClient() ? battleReturnPath() : new URL(location.href).pathname;
  return `${match.battlePath}?${new URLSearchParams({ pvpBattle: source, pvpReturn: back })}`;
}

export function leaveBattle(): void {
  if (isBattleClient()) {
    location.replace(battleReturnPath());
  } else {
    location.reload();
  }
}
