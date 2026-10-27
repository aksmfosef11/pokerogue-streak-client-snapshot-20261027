// SPDX-License-Identifier: AGPL-3.0-only
import { version } from "#package.json";
import { pvpApi } from "./api";
import { isBattleClient } from "./battle-route";

export async function campaignUpgradePath(): Promise<string | undefined> {
  if (isBattleClient() || Number(version.split(".")[2]) < 2) {
    return;
  }
  const status = await pvpApi.request<{ blocked: { version: string; path: string }[] }>("upgrade-status");
  const first = status.blocked[0];
  if (first) {
    if (first.path !== `/engines/${first.version}/`) {
      throw new Error("진행 중인 런의 원본 버전이 필요합니다.");
    }
    return first.path;
  }
}
