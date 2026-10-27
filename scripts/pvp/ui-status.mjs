// SPDX-License-Identifier: AGPL-3.0-only
// Inspect a generated local UI test account without printing its credential.
import { readFileSync } from "node:fs";

const account = JSON.parse(readFileSync(process.argv[2] || "pvp-ui-account.local", "utf8"));
if (!account.username.startsWith("pvp_")) {
  throw new Error("only disposable PvP test accounts are supported");
}
const response = await fetch("http://localhost:8001/pvp/status", { headers: { Authorization: account.token } });
if (!response.ok) {
  throw new Error(`status ${response.status}`);
}
const state = await response.json();
console.log(
  JSON.stringify({
    username: account.username,
    flags: state.flags,
    match: state.match && {
      id: state.match.id,
      status: state.match.status,
      decisions: state.match.decisions.length,
      lastDecision: state.match.decisions.at(-1)?.kind,
    },
    streak: state.streak,
    practiceStreak: state.practiceStreak,
  }),
);
