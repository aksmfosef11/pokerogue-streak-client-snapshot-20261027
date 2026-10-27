// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = process.env.PVP_TEST_URL ?? "http://localhost:8001";
const manifest = JSON.parse(await readFile("src/pvp/rules-manifest.json", "utf8"));
const accounts = [];

const request = async (path, token, body, expected = 200, version = manifest.version) => {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: token ?? "",
      "Content-Type": "application/json",
      "PKR-Client-Version": version,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${path}: ${text}`);
  if (!text) {
    return;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

async function createAccount() {
  const username = `pvr_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  let token;
  for (const action of ["register", "login"]) {
    const response = await fetch(`${base}/account/${action}`, {
      method: "POST",
      body: new URLSearchParams({ username, password }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    if (action === "login") {
      token = (await response.json()).token;
    }
  }
  accounts.push(username);
  return { username, token };
}

// 1. Verify normal wave rate does not flag on 1.12.1.3
{
  const { token } = await createAccount("1.12.1.3");
  const getFlags = async () => (await request("/pvp/status", token, undefined, 200, "1.12.1.3")).flags ?? [];
  const clientSessionId = `rate-test-${randomBytes(4).toString("hex")}`;
  const query = `?clientSessionId=${clientSessionId}`;

  let playTime = 1;
  const system = {
    trainerId: 1001,
    secretId: 2002,
    gameVersion: "1.12.1.3",
    gameStats: { playTime },
    starterData: { 1: { candyCount: 0, valueReduction: 0, eggMoves: 0, passiveAttr: 0 } },
    dexData: {},
    eggs: [],
    appliedMigrators: {},
  };

  // Baseline system update
  await request(`/savedata/system/update${query}`, token, system, 204, "1.12.1.3");
  assert.deepEqual(await getFlags(), [], "fresh baseline should have no flags");

  const session = {
    playTime: 1,
    gameVersion: "1.12.1.3",
    party: [],
    enemyParty: [],
    modifiers: [],
    enemyModifiers: [],
    money: 0,
    battleType: 0,
    gameMode: 0,
    waveIndex: 5,
    seed: clientSessionId,
  };

  // 5 waves within initial burst credit of 10
  system.gameStats.playTime = ++playTime;
  await request("/savedata/updateall", token, { clientSessionId, sessionSlotId: 0, system, session }, 200, "1.12.1.3");
  assert.deepEqual(await getFlags(), [], "5 waves within initial credit should not flag");

  // Next 5 waves (waveIndex: 10) consumes remaining initial credit of 5
  session.waveIndex = 10;
  system.gameStats.playTime = ++playTime;
  await request("/savedata/updateall", token, { clientSessionId, sessionSlotId: 0, system, session }, 200, "1.12.1.3");
  assert.deepEqual(await getFlags(), [], "10 waves within initial 10-wave credit should not flag");

  // Immediate jump of 40 waves (waveIndex: 50) with 0 elapsed seconds exceeds credit
  session.waveIndex = 50;
  system.gameStats.playTime = ++playTime;
  await request("/savedata/updateall", token, { clientSessionId, sessionSlotId: 0, system, session }, 200, "1.12.1.3");
  const flags = await getFlags();
  assert.ok(flags.includes("wave-arrival-rate"), `expected wave-arrival-rate in flags, got: ${JSON.stringify(flags)}`);

  // Verify save persistence despite the flag
  const savedSystem = await request(`/savedata/system/get${query}`, token, undefined, 200, "1.12.1.3");
  assert.equal(savedSystem.trainerId, 1001, "save data must be preserved on disk");
  assert.equal(savedSystem.gameStats.playTime, playTime, "playTime must match");
}

// 2. Verify wave rate enforcement on 1.12.1.2 (multi-version registry)
{
  const { token } = await createAccount("1.12.1.2");
  const getFlags = async () => (await request("/pvp/status", token, undefined, 200, "1.12.1.2")).flags ?? [];
  const clientSessionId = `rate-old-${randomBytes(4).toString("hex")}`;
  const query = `?clientSessionId=${clientSessionId}`;

  let playTime = 1;
  const system = {
    trainerId: 3001,
    secretId: 4002,
    gameVersion: "1.12.1.2",
    gameStats: { playTime },
    starterData: { 1: { candyCount: 0, valueReduction: 0, eggMoves: 0, passiveAttr: 0 } },
    dexData: {},
    eggs: [],
    appliedMigrators: {},
  };

  // Baseline
  await request(`/savedata/system/update${query}`, token, system, 204, "1.12.1.2");
  assert.deepEqual(await getFlags(), [], "1.12.1.2 fresh baseline should have no flags");

  const session = {
    playTime: 1,
    gameVersion: "1.12.1.2",
    party: [],
    enemyParty: [],
    modifiers: [],
    enemyModifiers: [],
    money: 0,
    battleType: 0,
    gameMode: 0,
    waveIndex: 5,
    seed: clientSessionId,
  };

  // 5 waves within credit
  system.gameStats.playTime = ++playTime;
  await request("/savedata/updateall", token, { clientSessionId, sessionSlotId: 0, system, session }, 200, "1.12.1.2");
  assert.deepEqual(await getFlags(), [], "1.12.1.2 5 waves within credit should not flag");

  // Immediate jump of 50 waves
  session.waveIndex = 55;
  system.gameStats.playTime = ++playTime;
  await request("/savedata/updateall", token, { clientSessionId, sessionSlotId: 0, system, session }, 200, "1.12.1.2");
  const flags = await getFlags();
  assert.ok(
    flags.includes("wave-arrival-rate"),
    `1.12.1.2 expected wave-arrival-rate in flags, got: ${JSON.stringify(flags)}`,
  );

  // Verify save persistence
  const saved = await request(`/savedata/system/get${query}`, token, undefined, 200, "1.12.1.2");
  assert.equal(saved.trainerId, 3001);
}

console.log(
  JSON.stringify({
    passed: true,
    testedVersions: ["1.12.1.3", "1.12.1.2"],
    checkedCases: [
      "initial-burst-credit-5-waves-pass",
      "consecutive-5-waves-total-10-pass",
      "excessive-wave-jump-flagged-wave-arrival-rate",
      "save-data-preserved-during-flag",
      "old-version-registry-identical-rate-enforcement",
    ],
  }),
);
