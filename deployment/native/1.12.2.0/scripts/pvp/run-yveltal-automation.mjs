// SPDX-License-Identifier: AGPL-3.0-only
// Controlled QA only. Campaign victories are skipped; generation/provenance audits are real.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = resolve(repo, "..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
}
if (args.includes("--help")) {
  console.log(
    "node scripts/pvp/run-yveltal-automation.mjs --version 1.12.2.0 --count 3 [--prefix qa122 | --account-file FILE] [--output DIRECTORY] [--resume]",
  );
  console.log(
    "Default: fresh QA accounts. --account-file adds parties to that account without seeding or resetting it. --resume continues this exact output directory.",
  );
  process.exit(0);
}
const version = option("--version", "1.12.2.0");
const count = Number(option("--count", "3"));
if (!Number.isInteger(count) || count < 1 || count > 20) throw Error("--count must be 1..20");
const stamp = Date.now().toString(36);
const prefix = option("--prefix", `qa${version.replaceAll(".", "")}${stamp}`);
if (!/^[a-zA-Z0-9_-]{2,24}$/.test(prefix)) throw Error("--prefix must be 2..24 letters, digits, _ or -");
const output = resolve(option("--output", resolve(workspace, "review", `automation-${prefix}`)));
mkdirSync(output, { recursive: true });
const composeFile = resolve(option("--compose", resolve(workspace, "compose.pvp.yml")));
const registry = JSON.parse(
  readFileSync(resolve(workspace, "rogueserver-master/rogueserver-master/pvp/versions.json")),
);
const profile = registry.versions[version];
if (!profile) throw Error(`Unsupported version: ${version}`);
const auditService = new URL(profile.auditURL).hostname;
const apiBase = process.env.POKEROGUE_API_URL || "http://localhost:8000/api";
const server = process.env.PVP_SERVER_URL || "http://localhost:8001";
const credentialsFile = resolve(output, "accounts.local.json");
const resume = args.includes("--resume");
const existingFile = option("--account-file", "");
if (existsSync(credentialsFile) && !resume)
  throw Error("Output already contains accounts; choose another directory or --resume");
const supplied = existingFile ? JSON.parse(readFileSync(resolve(existingFile))) : null;
if (supplied && (!supplied.username || !supplied.token || !supplied.clientSessionId))
  throw Error("--account-file must contain username, token, and the current clientSessionId");
if (supplied?.version && supplied.version !== version) throw Error("Account profile differs from --version");
const safeSlot = Number(option("--safe-slot", "4"));
if (!Number.isInteger(safeSlot) || safeSlot < 0 || safeSlot > 4) throw Error("--safe-slot must be 0..4");
const maxAttempts = Number(option("--max-attempts", "4"));
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw Error("--max-attempts must be 1..10");
const accounts = resume
  ? JSON.parse(readFileSync(credentialsFile))
  : supplied
    ? Array.from({ length: count }, (_, i) => ({ ...supplied, version, existing: true, iteration: i + 1 }))
    : Array.from({ length: count }, (_, i) => ({
        username: `${prefix}${i + 1}`,
        password: randomBytes(18).toString("base64url"),
        version,
        clientSessionId: `qa-${stamp}-${i}`,
      }));
if (accounts.some(a => a.version !== version)) throw Error("Resume version differs from saved accounts");
const saveCredentials = () => writeFileSync(credentialsFile, JSON.stringify(accounts, null, 2), { mode: 0o600 });
saveCredentials();
function docker(argv, env = {}, capture = false) {
  return execFileSync("docker", ["compose", "-f", composeFile, ...argv], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 20 * 1024 * 1024,
  });
}
function nativeTest(account, test, attempt = 1) {
  const outputName = `${account.username}-${account.iteration ?? 1}`;
  const trialName = `${outputName}-${attempt}`;
  try {
    const log = docker(
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--volume",
        `${resolve(repo, "scripts/pvp")}:/app/scripts/pvp:ro`,
        "--volume",
        `${output}:/automation-output`,
        "-e",
        "NODE_ENV=test",
        "-e",
        "PVP_ACCOUNT_TOKEN",
        "-e",
        "PVP_CLIMB_USER",
        "-e",
        "PVP_CLIENT_SESSION_ID",
        "-e",
        "PVP_AUTOMATION_TEST",
        "-e",
        "PVP_AUTOMATION_SEED_OUTPUT=/automation-output/seed.json",
        "-e",
        `PVP_AUTOMATION_RUN_ID=${account.iteration ?? 1}-${attempt}`,
        "-e",
        `PVP_AUTOMATION_RUN_OUTPUT=/automation-output/registered-${outputName}.json`,
        "-e",
        `PVP_AUTOMATION_PREFLIGHT_OUTPUT=/automation-output/preflight-${trialName}.json`,
        "-e",
        `PVP_AUTOMATION_VERIFY_URL=${profile.auditURL}`,
        "-e",
        `PVP_SAFE_SLOT=${safeSlot}`,
        "-e",
        "PVP_SERVER_URL",
        auditService,
        "node",
        "--max-old-space-size=2048",
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "scripts/pvp/automation.config.ts",
      ],
      {
        PVP_ACCOUNT_TOKEN: account.token || "",
        PVP_CLIMB_USER: account.username,
        PVP_CLIENT_SESSION_ID: account.clientSessionId,
        PVP_AUTOMATION_TEST: `scripts/pvp/${test}.test.ts`,
        PVP_SERVER_URL: process.env.PVP_NATIVE_SERVER_URL || "http://server:8001",
      },
      true,
    );
    writeFileSync(resolve(output, `${trialName}-${test}.log`), log, { mode: 0o600 });
  } catch (error) {
    writeFileSync(resolve(output, `${trialName}-${test}.log`), `${error.stdout ?? ""}\n${error.stderr ?? ""}`, {
      mode: 0o600,
    });
    throw Error(`${test} failed; inspect the private run log in ${output}`);
  }
}
async function api(account, path, body, base = apiBase) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: account.token || "", "PKR-Client-Version": version, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
const resultFile = resolve(output, "registration-results.json");
const results = resume && existsSync(resultFile) ? JSON.parse(readFileSync(resultFile)) : [];
for (const account of accounts) {
  console.log(
    `[${version}] ${account.username}${account.existing ? ` party ${account.iteration}/${accounts.length}` : ""}`,
  );
  try {
    if (account.completed) {
      console.log("[SKIP] already completed");
      continue;
    }
    if (!account.token) {
      const registered = await fetch(`${apiBase}/account/register`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: account.username, password: account.password }),
      });
      if (!registered.ok)
        throw Error(
          `Fresh account registration failed: HTTP ${registered.status}. Existing accounts are never overwritten.`,
        );
      const response = await fetch(`${apiBase}/account/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: account.username, password: account.password }),
      });
      const login = await response.json();
      if (!response.ok || !login.token) throw Error(`Login failed: HTTP ${response.status}`);
      account.token = login.token;
      saveCredentials();
    }
    const status = await api(account, "/pvp/status", undefined, server);
    if (!account.existing && !account.initialized && !status.registered) {
      nativeTest(account, "automation-seed");
      const system = JSON.parse(readFileSync(resolve(output, "seed.json")));
      const initial = await fetch(`${apiBase}/savedata/system/get?clientSessionId=${account.clientSessionId}`, {
        headers: { Authorization: account.token, "PKR-Client-Version": version },
      });
      if (initial.status !== 404 && !initial.ok) throw Error(`Initial system read: HTTP ${initial.status}`);
      await api(account, `/savedata/system/update?clientSessionId=${account.clientSessionId}`, system);
      const adminArgs = [
        "./pvp-admin",
        "approve-baseline",
        "-version",
        version,
        "-operator",
        "qa-automation",
        "-reason",
        "Isolated newly-created QA account; native full-unlock Yveltal baseline for version compatibility verification",
        account.username,
      ];
      const adminContainer = option("--admin-container", "");
      const review = adminContainer
        ? execFileSync("docker", ["exec", adminContainer, ...adminArgs], { encoding: "utf8" })
        : docker(
            [
              "exec",
              "-T",
              "server",
              "./pvp-admin",
              "approve-baseline",
              "-version",
              version,
              "-operator",
              "qa-automation",
              "-reason",
              "Isolated newly-created QA account; native full-unlock Yveltal baseline for version compatibility verification",
              account.username,
            ],
            {},
            true,
          );
      writeFileSync(resolve(output, `${account.username}-baseline.json`), review);
      account.initialized = true;
      saveCredentials();
    }
    if (args.includes("--seed-only")) {
      results.push({ username: account.username, version, initialized: true, qaOnly: true });
      continue;
    }
    if (status.flags?.length) throw Error("Account qualification is on hold; no data was reset");
    const runFile = resolve(output, `registered-${account.username}-${account.iteration ?? 1}.json`);
    const outputName = `${account.username}-${account.iteration ?? 1}`;
    const proofs = readdirSync(output).filter(
      name => name.startsWith(`climb-${outputName}-`) && name.endsWith(".local.json"),
    );
    const approvedProof = proofs.find(name => {
      const trial = name.slice(`climb-`.length, -`.local.json`.length);
      const preflight = resolve(output, `preflight-${trial}.json`);
      return existsSync(preflight) && JSON.parse(readFileSync(preflight)).ok === true;
    });
    if (approvedProof && !existsSync(runFile)) {
      const proofFile = resolve(output, approvedProof);
      const proof = JSON.parse(readFileSync(proofFile));
      let verified = false;
      for (let check = 0; check < 60; check++) {
        const teams = await api(account, "/pvp/teams", undefined, server);
        if (teams.some(team => team.id === proof.run.id)) {
          verified = true;
          break;
        }
        const current = await api(account, "/pvp/status", undefined, server);
        if (current.audit?.runId !== proof.run.id || current.audit.status !== "pending") break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!verified)
        throw Error(
          "Previous run has an unfinished proof; wait for its audit or inspect the private proof before retrying",
        );
      writeFileSync(runFile, JSON.stringify({ username: account.username, runId: proof.run.id, registered: true }));
    }
    if (!existsSync(runFile) && (account.existing || !status.registered)) {
      console.log("  Generating 200-wave proof and submitting automatic registration…");
      const priorAttempts = proofs
        .map(name => Number(name.slice(`climb-${outputName}-`.length, -`.local.json`.length)))
        .filter(Number.isInteger);
      let completed = false;
      for (let attempt = Math.max(0, ...priorAttempts) + 1; attempt <= maxAttempts; attempt++) {
        try {
          nativeTest(account, "auto-climb-yveltal", attempt);
          completed = true;
          break;
        } catch (error) {
          const preflight = resolve(output, `preflight-${outputName}-${attempt}.json`);
          if (!existsSync(preflight) || JSON.parse(readFileSync(preflight)).ok !== false) throw error;
          console.log(`  Preflight rejected generated proof #${attempt}; it was not submitted for registration.`);
        }
      }
      if (!completed)
        throw Error(
          `No valid generated proof after ${maxAttempts} attempts; rejected proofs were not submitted`,
        );
    }
    const final = await api(account, "/pvp/status", undefined, server);
    const party = existsSync(runFile) ? JSON.parse(readFileSync(runFile)) : { runId: final.audit?.runId };
    const teams = await api(account, "/pvp/teams", undefined, server);
    if (!party.runId || !teams.some(team => team.id === party.runId) || final.flags?.length)
      throw Error(`Registration failed: ${final.audit?.reason || final.flags?.join(",") || "not registered"}`);
    account.completed = true;
    saveCredentials();
    results.push({
      username: account.username,
      version,
      iteration: account.iteration ?? 1,
      runId: party.runId,
      registered: true,
      totalParties: teams.length,
    });
    console.log(`  Registered: ${teams.length} parties total.`);
  } catch (error) {
    results.push({ username: account.username, version, registered: false, error: error.message });
    console.error(`[FAILED] ${account.username}: ${error.message}`);
    process.exitCode = 1;
    break;
  } finally {
    writeFileSync(resultFile, JSON.stringify(results, null, 2));
  }
}
console.log(`Results: ${resolve(output, "registration-results.json")}`);
