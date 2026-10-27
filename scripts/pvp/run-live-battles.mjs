// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  workspace = resolve(repo, "..");
const input = process.argv[2];
if (!input) throw Error("Usage: run-live-battles.mjs COHORT_DIRECTORY [battles-per-account=3]");
const cohort = resolve(input),
  accounts = JSON.parse(readFileSync(resolve(cohort, "accounts.local.json")));
const results = resolve(cohort, "battles");
mkdirSync(results, { recursive: true });
const registry = JSON.parse(
  readFileSync(resolve(workspace, "rogueserver-master/rogueserver-master/pvp/versions.json")),
);
for (const account of accounts) {
  const current = await (
    await fetch("http://localhost:8001/pvp/status", {
      headers: { Authorization: account.token, "PKR-Client-Version": account.version },
    })
  ).json();
  if (!current.streakAttempt || current.streakAttempt.status !== "active") {
    const response = await fetch("http://localhost:8001/pvp/teams", {
      headers: { Authorization: account.token, "PKR-Client-Version": account.version },
    });
    if (!response.ok) throw Error(`Party list failed: HTTP ${response.status}`);
    const parties = await response.json();
    const chosen = account.teamId
      ? parties.find(p => p.id === account.teamId && p.canStart)
      : parties.find(p => p.canStart);
    if (chosen) account.teamId = chosen.id;
    else {
      writeFileSync(
        resolve(results, `${account.username}-existing.json`),
        JSON.stringify(
          {
            username: account.username,
            sourceVersion: account.version,
            opponent: current.match?.opponent,
            opponentVersion: current.match?.opponentVersion,
            result: current.match?.status,
            engine: current.match?.session?.gameVersion,
            decisions: current.match?.decisions?.length,
            origin: "existing persisted result",
          },
          null,
          2,
        ),
      );
      console.log(`[SKIP] ${account.username}: no available registered party`);
      continue;
    }
  }
  const engine =
      current.match?.status === "active"
        ? current.match.session.gameVersion
        : registry.versions[account.version].battleVersion,
    service = new URL(registry.versions[engine].auditURL).hostname;
  const file = `${account.username}.local.json`;
  writeFileSync(resolve(results, file), JSON.stringify(account), { mode: 0o600 });
  for (let i = 0; i < Number(process.argv[3] || 3); i++) {
    const report = `${account.username}-${Date.now()}-${i + 1}.json`;
    console.log(`[BATTLE] ${account.username} #${i + 1}`);
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
        `${results}:/automation-output`,
        "-e",
        "NODE_ENV=test",
        "-e",
        "PVP_AUTOMATION_TEST=scripts/pvp/live-battle.test.ts",
        "-e",
        `PVP_BATTLE_ACCOUNT=/automation-output/${file}`,
        "-e",
        `PVP_BATTLE_RESULT=/automation-output/${report}`,
        service,
        "node",
        "--max-old-space-size=2048",
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "scripts/pvp/automation.config.ts",
      ],
      { cwd: workspace, stdio: "inherit" },
    );
    const result = JSON.parse(readFileSync(resolve(results, report)));
    console.log(
      `[RESULT] ${result.sourceVersion} vs ${result.opponentVersion}: ${result.result} (${result.decisions} decisions)`,
    );
    if (result.result !== "won") break;
  }
}
