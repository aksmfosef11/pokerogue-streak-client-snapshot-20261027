// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const hooks = {
  "src/data/egg.ts": ["beginEggProof(eggOptions)", "eggEntropy(proof,", "finishEggProof(this, proof)"],
  "src/phases/title-phase.ts": ["pvpBoot(", "pvpMenuOptions("],
  "src/phases/select-starter-phase.ts": ["await prepareRankedRun(starters)"],
  "src/phases/select-modifier-phase.ts": ["logShopOffer(this, this.typeOptions)", "logShop({"],
  "src/battle-scene.ts": ["logItem(new PvpModifierData("],
  "src/system/game-data.ts": [
    "isPvpMatchActive()",
    "await recordWave(",
    "await finalizeRun(",
    "await this.initSessionFromData(sessionData)",
  ],
  "src/data/status-effect.ts": ["randSeedIntRange(1, 6)", "randSeedIntRange(0, 1)"],
};
for (const [file, needles] of Object.entries(hooks)) {
  const text = readFileSync(file, "utf8");
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${file}: missing hook ${needle}`);
  }
}
const addon = readFileSync("src/pvp/runtime.ts", "utf8");
assert.ok(
  readFileSync("src/pvp/log.ts", "utf8").includes("const original = prototype.loadSession"),
  "missing campaign journal load boundary",
);
for (const [file, needles] of Object.entries({
  "command-phase": ["tryExecuteQueuedMove", "handleCommand"],
  "enemy-command-phase": ["start()"],
  "switch-phase": ["start()", "this.isModal", "const fieldIndex"],
  "victory-phase": ["start(): void"],
  "game-over-phase": ["start(): void"],
  "battle-end-phase": ["m.lapse(...args)", "this.end()"],
  "mystery-encounter-phases": [
    "class MysteryEncounterOptionSelectedPhase",
    "this.onOptionSelect().finally",
    "handleOptionSelect(option: MysteryEncounterOption, index: number)",
  ],
})) {
  const text = readFileSync(`src/phases/${file}.ts`, "utf8");
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${file}: wrapped upstream boundary changed: ${needle}`);
  }
}
for (const name of [
  "CommandPhase",
  "EnemyCommandPhase",
  "SwitchPhase",
  "VictoryPhase",
  "GameOverPhase",
  "BattleEndPhase",
  "MysteryEncounterOptionSelectedPhase",
  "MysteryEncounterPhase",
]) {
  assert.ok(new RegExp(`patch\\(\\s*${name}\\.prototype`).test(addon), `missing addon boundary: ${name}`);
}
const brandingFiles = ["src/data/splash-messages.ts", "src/ui/handlers/menu-ui-handler.ts"];
const changed = execFileSync("git", ["diff", "--name-only", "vendor", "--", "src"], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
assert.deepEqual(
  changed.filter(file => !file.startsWith("src/pvp/") && !Object.hasOwn(hooks, file) && !brandingFiles.includes(file)),
  [],
  "upstream changes exceed the guarded seam allowlist",
);
console.log(`PASS: ${Object.keys(hooks).length} upstream files; 6 battle and 2 ME boundaries isolated in addon`);
