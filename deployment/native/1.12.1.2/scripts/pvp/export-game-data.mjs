// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Preserve the upstream exporter and its CLI, then emit the matching PvP rules.
const upstream = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "scripts/game-data-exporter/game-data-exporter.config.ts",
    "scripts/game-data-exporter/run.test.ts",
    "--",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
if (upstream.status !== 0) {
  process.exit(upstream.status ?? 1);
}
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const rules = spawnSync(
  process.execPath,
  ["scripts/pvp/export-rules.mjs", `game-data-output/pvp/${version}/rules.json`],
  { stdio: "inherit", env: { ...process.env, PVP_DATA_ALREADY_EXPORTED: "1" } },
);
process.exit(rules.status ?? 1);
