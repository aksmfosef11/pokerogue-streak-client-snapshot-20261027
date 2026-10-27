// SPDX-License-Identifier: AGPL-3.0-only
// Local API integration using saves produced by the pinned native game.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const base = process.env.PVP_TEST_URL ?? "http://localhost:8001";
const fixture = JSON.parse(await readFile("test/fixtures/pvp/native-system-income.json", "utf8"));
assert.equal(fixture.samples.length, 8);
const accounts = [];
const request = async (path, token, body, expected = 200) => {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: token ?? "",
      "Content-Type": "application/json",
      "PKR-Client-Version": fixture.manifest.version,
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
async function account() {
  const username = `pvin_${randomBytes(4).toString("hex")}`;
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
  // Keep only generated account names for optional local cleanup; no credential.
  await writeFile("pvp-system-income-accounts.local", JSON.stringify(accounts));
  return token;
}
for (const sample of fixture.samples) {
  // Level 1 runs on every mode. The Breeder control exercises both routes in
  // all five mode requests; the other native controls exercise Classic here.
  const modes = sample.name === "breeder-thirteen-eggs" ? [0, 1, 2, 3, 4] : [0];
  for (const mode of modes) {
    for (const route of ["system", "all"]) {
      const token = await account();
      const getFlags = async () => (await request("/pvp/status", token)).flags ?? [];
      const clientSessionId = `native-income-${randomBytes(6).toString("hex")}`;
      const query = `?clientSessionId=${clientSessionId}`;
      await request(`/savedata/system/get${query}`, token, undefined, 404);
      let playTime = 0;
      const old = structuredClone(sample.old);
      old.gameStats.playTime = ++playTime;
      await request(`/savedata/system/update${query}`, token, old, 204);
      const session = {
        playTime: 1,
        gameVersion: fixture.manifest.version,
        party: [],
        enemyParty: [],
        modifiers: [],
        enemyModifiers: [],
        money: 0,
        battleType: 0,
        gameMode: mode,
        waveIndex: 1,
        seed: clientSessionId,
      };
      old.gameStats.playTime = ++playTime;
      await request("/savedata/updateall", token, { clientSessionId, sessionSlotId: 0, system: old, session });
      assert.deepEqual(await getFlags(), [], `${sample.name}:baseline`);
      session.waveIndex = 2;
      const save = async data => {
        data.gameStats.playTime = ++playTime;
        session.playTime = playTime;
        if (route === "system") {
          await request(`/savedata/system/update${query}`, token, data, 204);
        } else {
          await request("/savedata/updateall", token, { clientSessionId, sessionSlotId: 0, system: data, session });
        }
      };
      const next = structuredClone(sample.next);
      await save(next);
      assert.deepEqual(await getFlags(), [], `${sample.name}:native:${mode}:${route}`);
      await save(next);
      assert.deepEqual(await getFlags(), [], `${sample.name}:unchanged`);
      if (sample.name === "breeder-thirteen-eggs") {
        const originals = structuredClone(next.eggs);
        // The finite five-wave reserve allows a burst, then must run out while
        // uploads keep reporting the same wave. Stock stays below the native 99.
        let denied = false;
        for (let repeat = 0; repeat < 6; repeat++) {
          next.eggs.push(...originals.map((egg, index) => ({ ...egg, id: 80000001 + repeat * 20 + index })));
          await save(next);
          const flags = await getFlags();
          if (flags.includes("event-egg-inflow-bound")) {
            denied = true;
            break;
          }
          assert.deepEqual(flags, [], "unrelated flag during finite native egg budget test");
        }
        assert.equal(denied, true, "same-wave uploads renewed event egg credit");
        assert.ok(next.eggs.length <= 99);
      }
      const root = Object.keys(next.starterData)[0];
      next.starterData[root].candyCount += 1000;
      await save(next);
      assert.ok((await getFlags()).includes("candy-income-bound"));
      const saved = await request(`/savedata/system/get${query}`, token);
      assert.equal(
        saved.starterData[root].candyCount,
        next.starterData[root].candyCount,
        "soft flag lost ordinary saved progress",
      );
      console.log(
        JSON.stringify({
          passed: true,
          name: sample.name,
          mode,
          route,
          savedCandy: saved.starterData[root].candyCount,
        }),
      );
    }
  }
}
console.log(
  JSON.stringify({
    passed: true,
    nativeSamples: fixture.samples.length,
    accounts: accounts.length,
    routes: 2,
    breederModes: 5,
  }),
);
