// SPDX-License-Identifier: AGPL-3.0-only
// Read balance source without loading Phaser or changing upstream's exporter.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

// These CSVs are produced by the real registry, including inherited form moves.
// Never reuse a previous version's export when pvp:export is invoked directly.
if (!process.env.PVP_DATA_ALREADY_EXPORTED) {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "scripts/game-data-exporter/game-data-exporter.config.ts",
      "scripts/game-data-exporter/run.test.ts",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function csv(path) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const value = readFileSync(path, "utf8");
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') {
      if (quoted && value[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (c === "," || c === "\n")) {
      row.push(cell.replace(/\r$/, ""));
      cell = "";
      if (c === "\n") {
        rows.push(row);
        row = [];
      }
    } else {
      cell += c;
    }
  }
  if (cell || row.length > 0) {
    rows.push([...row, cell]);
  }
  const headers = rows.shift();
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

const read = p => readFileSync(p, "utf8");
function enumValues(name) {
  const src = read(`src/enums/${name}.ts`)
    .replace(/^import .*$/gm, "")
    .replace(/export /g, "");
  const compiled = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ctx = {};
  vm.runInNewContext(compiled, ctx);
  return ctx[name === "species-id" ? "SpeciesId" : "MoveId"];
}
const species = enumValues("species-id");
const moves = enumValues("move-id");
const balanceContext = { IS_TEST: false };
const balanceSource = read("src/data/balance/starters.ts")
  .replace(/^import .*$/gm, "")
  .replace(/^export /gm, "");
vm.runInNewContext(
  ts.transpileModule(balanceSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  balanceContext,
);
const eventSource = read("src/data/balance/timed-events.ts");
const friendshipMultiplier = Math.max(
  3,
  ...[...eventSource.matchAll(/classicFriendshipMultiplier:\s*(\d+)/g)].map(m => Number(m[1])),
);
const catchBonus = Math.max(0, ...[...eventSource.matchAll(/extraCatchCandy:\s*(\d+)/g)].map(m => Number(m[1])));
vm.runInNewContext(
  `globalThis.costs = Array.from({length:10}, (_,i) => ({
  friendshipCap:getStarterValueFriendshipCap(i+1), passive:getPassiveCandyCount(i+1),
  reduction:getValueReductionCandyCounts(i+1), eggCosts:allStarterCandyCosts[i].eggCosts ?? [allStarterCandyCosts[i].eggCost],
  eggThresholds:allStarterCandyCosts[i].eggCostReductionThresholds ?? []
}));`,
  balanceContext,
);
const rules = {};
for (const file of readdirSync("src/data/balance/species").filter(f => /^generation.*\.ts$/.test(f))) {
  const src = read(`src/data/balance/species/${file}`);
  const blocks = [...src.matchAll(/\w+SpeciesData\[SpeciesId\.(\w+)\]\s*=\s*\{/g)];
  blocks.forEach((m, i) => {
    const block = src.slice(m.index, blocks[i + 1]?.index ?? src.length);
    const cost = /starterCost:\s*(\d+)/.exec(block);
    if (cost) {
      const value = Number(cost[1]);
      rules[species[m[1]]] = { cost: value, eggMoves: [], candy: balanceContext.costs[value - 1] };
      rules[species[m[1]]].candy.friendshipMultiplier = friendshipMultiplier;
      rules[species[m[1]]].candy.catchBonus = catchBonus;
    }
  });
}
for (const m of read("src/data/balance/moves/egg-moves.ts").matchAll(/\[SpeciesId\.(\w+)\]:\s*\[([^\]]*)\]/g)) {
  if (rules[species[m[1]]]) {
    rules[species[m[1]]].eggMoves = [...m[2].matchAll(/MoveId\.(\w+)/g)].map(x => moves[x[1]]);
  }
}
const speciesRows = csv("game-data-output/species.csv");
const baseSpecies = new Map(speciesRows.map(r => [r.id, r]));
const moveRows = csv("game-data-output/level-moves.csv");
for (const [id, rule] of Object.entries(rules)) {
  const forms = speciesRows.filter(r => r.dexNum === id);
  if (forms.length === 0) {
    throw new Error(`Missing exported species ${id}`);
  }
  let root = forms[0];
  const seen = new Set();
  while (root.prevolution && !seen.has(root.id)) {
    seen.add(root.id);
    root = baseSpecies.get(root.prevolution);
    if (!root) {
      throw new Error(`Invalid prevolution for ${id}`);
    }
  }
  rule.root = Number(root.dexNum);
  rule.eggTier = ["COMMON", "RARE", "EPIC", "LEGENDARY"].indexOf(root.eggTier || "COMMON");
  rule.starterMoves = Object.fromEntries(
    forms.flatMap((form, index) =>
      forms.length > 1 && form.isStartSelectable !== "true"
        ? []
        : [
            [
              index,
              [
                ...new Set(
                  moveRows
                    .filter(
                      r =>
                        r.dexNum === id
                        && Number(r.level) > 0
                        && Number(r.level) <= 5
                        && (!r.form || r.form === form.formKey),
                    )
                    .map(r => moves[r.move]),
                ),
              ],
            ],
          ],
    ),
  );
  if (Object.values(rule.starterMoves).some(ms => ms.length === 0 || ms.some(m => !Number.isInteger(m)))) {
    throw new Error(`Invalid starter moves for ${id}`);
  }
}
if (Object.keys(rules).length < 500 || rules[1]?.cost !== 3 || rules[1].eggMoves.length !== 4) {
  throw new Error("Balance source layout changed");
}
const output = resolve(process.argv[2] ?? "../server/pvp/rules.json");
mkdirSync(dirname(output), { recursive: true });
const data = JSON.stringify(rules, null, 2) + "\n";
writeFileSync(output, data);
const { version } = JSON.parse(read("package.json"));
const manifest =
  JSON.stringify(
    {
      schema: 1,
      version,
      upstreamTag: `v${version}`,
      auditSchema: 2,
      harness: "scripts/pvp/audit.config.ts",
      rulesSHA256: createHash("sha256").update(data).digest("hex"),
    },
    null,
    2,
  ) + "\n";
writeFileSync(output.replace(/\.json$/, "") + ".manifest.json", manifest);
writeFileSync("src/pvp/rules-manifest.json", manifest);
console.log(`Exported ${Object.keys(rules).length} starter rules to ${output}`);
