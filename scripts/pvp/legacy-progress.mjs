// SPDX-License-Identifier: AGPL-3.0-only
// Prepare/verify only dedicated QA accounts made by --seed-only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  workspace = resolve(repo, ".."),
  command = process.argv[2],
  dir = resolve(process.argv[3]);
const account = JSON.parse(readFileSync(resolve(dir, "accounts.local.json")))[0];
assert.match(account.username, /^qacompat/);
async function api(path, body, expected = 200, version = account.version) {
  const res = await fetch("http://localhost:8001" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: account.token, "Content-Type": "application/json", "PKR-Client-Version": version },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, expected, `${path}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const systemPath = `/savedata/system/get?clientSessionId=${account.clientSessionId}`;
const savePath = `/savedata/system/update?clientSessionId=${account.clientSessionId}`;
const slotPath = `/savedata/session/get?slot=0&clientSessionId=${account.clientSessionId}`;
function native(test, version = account.version, env = {}) {
  const service = version === "1.12.1.3" ? "audit" : `audit-${version.replaceAll(".", "-")}`;
  const vars = { PVP_AUTOMATION_TEST: `scripts/pvp/${test}.test.ts`, ...env };
  execFileSync(
    "docker",
    [
      "compose",
      "-f",
      resolve(workspace, "compose.pvp.yml"),
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--volume",
      `${resolve(repo, "scripts/pvp")}:/app/scripts/pvp:ro`,
      "--volume",
      `${dir}:/automation-output`,
      "-e",
      "NODE_ENV=test",
      ...Object.keys(vars).flatMap(k => ["-e", k]),
      service,
      "node",
      "--max-old-space-size=2048",
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "scripts/pvp/automation.config.ts",
    ],
    { cwd: workspace, env: { ...process.env, ...vars }, stdio: "inherit" },
  );
}
const snapshot = (name, data) => writeFileSync(resolve(dir, name), JSON.stringify(data, null, 2));
if (command === "prepare") {
  const system = await api(systemPath),
    tickets = await api("/pvp/egg-tickets", {});
  snapshot("egg-input.local.json", { system, ticket: tickets.tickets[0] });
  native("egg-producer", account.version, {
    PVP_EGG_PRESERVE_SYSTEM: "1",
    PVP_EGG_PRODUCER_INPUT: "/automation-output/egg-input.local.json",
    PVP_EGG_PRODUCER_OUTPUT: "/automation-output/egg-generated.local.json",
  });
  const egg = JSON.parse(readFileSync(resolve(dir, "egg-generated.local.json")));
  await api(savePath, egg.created, 204);
  for (let i = 0; i < 120; i++) {
    const st = await api("/pvp/status");
    assert.equal(st.flags?.length || 0, 0);
    if (!st.eggVerification.pendingJobs) break;
    await new Promise(r => setTimeout(r, 500));
    if (i === 119) throw Error("Egg audit not finished");
  }
  const session = JSON.parse(readFileSync(resolve(repo, "test/fixtures/pvp/native-save-1.12.1.2.json"))).session;
  session.gameVersion = account.version;
  await api(`/savedata/session/update?slot=0&clientSessionId=${account.clientSessionId}`, session);
  snapshot("before-progress.local.json", {
    system: await api(systemPath),
    session: await api(slotPath),
    status: await api("/pvp/status"),
  });
  assert.equal((await api("/pvp/upgrade-status", undefined, 200, "1.12.2.0")).ready, false);
  console.log(`PREPARED ${account.version}: old run + native ticketed egg audited before rollout`);
} else if (command === "verify") {
  const before = JSON.parse(readFileSync(resolve(dir, "before-progress.local.json"))),
    system = await api(systemPath),
    session = await api(slotPath);
  assert.deepEqual(system, before.system);
  assert.deepEqual(session, before.session);
  const upgrade = { ...system, gameVersion: "1.12.2.0" };
  await api(savePath, upgrade, 409, "1.12.2.0");
  assert.deepEqual(await api(systemPath), system);
  snapshot("resume-input.local.json", { system, session });
  native("legacy-resume", account.version, {
    PVP_PROGRESS_INPUT: "/automation-output/resume-input.local.json",
    PVP_PROGRESS_OUTPUT: "/automation-output/resumed.local.json",
  });
  const resumed = JSON.parse(readFileSync(resolve(dir, "resumed.local.json")));
  await api(`/savedata/updateall`, {
    system: resumed.system,
    session: resumed.session,
    sessionSlotId: 0,
    clientSessionId: account.clientSessionId,
  });
  assert.equal((await api(slotPath)).gameVersion, account.version);
  assert.equal((await api("/pvp/status")).flags?.length || 0, 0);
  snapshot("after-resume.local.json", {
    system: await api(systemPath),
    session: await api(slotPath),
    status: await api("/pvp/status"),
  });
  console.log(`PASS ${account.version}: data preserved, old native run resumed, next turn saved, existing egg intact`);
} else if (command === "mature") {
  snapshot("maturity-input.local.json", { system: await api(systemPath), session: await api(slotPath) });
  native("legacy-mature", account.version, {
    PVP_PROGRESS_INPUT: "/automation-output/maturity-input.local.json",
    PVP_PROGRESS_OUTPUT: "/automation-output/matured.local.json",
  });
  const progress = JSON.parse(readFileSync(resolve(dir, "matured.local.json")));
  for (const frame of progress.frames) {
    await api("/savedata/updateall", { ...frame, sessionSlotId: 0, clientSessionId: account.clientSessionId });
    const status = await api("/pvp/status");
    assert.deepEqual(status.flags ?? [], []);
  }
  console.log(
    `PASS ${account.version}: existing egg matured through ${progress.waves} native wave lapses, no qualification flags`,
  );
} else if (command === "upgrade-hatch" || command === "verify-hatch") {
  let before;
  if (command === "upgrade-hatch") {
    before = await api(systemPath);
    assert.ok(
      before.eggs?.length && before.eggs.every(egg => egg.hatchWaves === 0),
      "Run mature first: hatch waves must be completed before upgrade-hatch",
    );
    await api(`/savedata/session/delete?slot=0&clientSessionId=${account.clientSessionId}`);
    assert.equal((await api("/pvp/upgrade-status", undefined, 200, "1.12.2.0")).ready, true);
    snapshot("hatch-input.local.json", { system: before });
    native("legacy-hatch", "1.12.2.0", {
      PVP_PROGRESS_INPUT: "/automation-output/hatch-input.local.json",
      PVP_PROGRESS_OUTPUT: "/automation-output/hatched.local.json",
    });
    const next = JSON.parse(readFileSync(resolve(dir, "hatched.local.json")));
    await api(savePath, next.upgraded, 204, "1.12.2.0");
    await api(savePath, next.hatched, 204, "1.12.2.0");
  } else before = JSON.parse(readFileSync(resolve(dir, "hatch-input.local.json"))).system;
  const next = JSON.parse(readFileSync(resolve(dir, "hatched.local.json")));
  for (let i = 0; i < 120; i++) {
    const st = await api("/pvp/status", undefined, 200, "1.12.2.0");
    assert.equal(st.flags?.length || 0, 0);
    if (!st.eggVerification.pendingJobs) break;
    await new Promise(r => setTimeout(r, 500));
    if (i === 119) throw Error("Hatch audit not finished");
  }
  const after = await api(systemPath, undefined, 200, "1.12.2.0");
  assert.equal(after.eggs?.length ?? 0, before.eggs.length - 1);
  assert.equal(after.dexData[next.species].hatchedCount, next.hatched.dexData[next.species].hatchedCount);
  await api(
    savePath,
    { ...before, gameStats: { ...before.gameStats, playTime: after.gameStats.playTime }, timestamp: Date.now() },
    409,
    account.version,
  );
  snapshot("upgrade-hatch-result.json", {
    passed: true,
    sourceVersion: account.version,
    targetVersion: after.gameVersion,
    eggId: next.eggId,
    hatchSpecies: next.species,
    eggRemoved: true,
    oldTabDowngradeBlocked: true,
    flags: (await api("/pvp/status", undefined, 200, "1.12.2.0")).flags,
  });
  console.log(
    `PASS ${account.version} → 1.12.2.0: old egg hatched, qualification inherited, old-tab downgrade rejected`,
  );
} else throw Error("Usage: legacy-progress.mjs prepare|verify|mature|upgrade-hatch|verify-hatch QA_DIRECTORY");
