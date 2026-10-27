// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  workspace = existsSync(resolve(repo, "deployment/pvp-release.json")) ? resolve(repo, "deployment") : resolve(repo, "..");
const config = JSON.parse(readFileSync(resolve(workspace, "pvp-release.json")));
const server = resolve(workspace, config.server),
  registry = JSON.parse(readFileSync(join(server, "pvp/versions.json")));
const command = process.argv[2] || "check";
const seams = [
  "src/battle-scene.ts",
  "src/data/egg.ts",
  "src/data/status-effect.ts",
  "src/phases/select-modifier-phase.ts",
  "src/phases/select-starter-phase.ts",
  "src/phases/title-phase.ts",
  "src/system/game-data.ts",
];
const run = (tool, args, options = {}) =>
  execFileSync(tool, args, {
    cwd: workspace,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
const docker = (args, options = {}) =>
  run("docker", ["compose", "-f", resolve(workspace, "compose.pvp.yml"), ...args], options);
const git = args => run("git", args, { cwd: repo });
const sha = data => createHash("sha256").update(data).digest("hex");
function check() {
  assert.equal(registry.defaultVersion, config.defaultVersion);
  for (const [version, p] of Object.entries(config.profiles)) {
    const dir = resolve(workspace, p.directory);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, version);
    const profile = registry.versions[version];
    assert.equal(profile.battleVersion, config.battleVersion);
    assert.equal(JSON.parse(readFileSync(join(dir, "src/pvp/audit-policy.json"))).policy, profile.auditPolicy);
    const ruleDir = resolve(server, "pvp", profile.rulesDir);
    assert.equal(
      sha(readFileSync(join(dir, "src/pvp/rules-manifest.json"))),
      sha(readFileSync(join(ruleDir, "rules.manifest.json"))),
      `${version}: rule manifest drift`,
    );
    console.log(`${version}: native package / policy / rules OK`);
  }
  docker(["config", "--quiet"]);
}
function sync() {
  for (const [version, p] of Object.entries(config.profiles)) {
    const dir = resolve(workspace, p.directory);
    if (dir === repo) continue;
    assert.ok(dir.startsWith(workspace + "\\") || dir.startsWith(workspace + "/"));
    for (const file of seams) {
      const base = join(dir, "pvp-base.local"),
        addon = join(dir, "pvp-addon.local"),
        target = join(dir, file);
      writeFileSync(target, git(["show", `v${version}:${file}`]).replaceAll("\r\n", "\n"));
      writeFileSync(base, git(["show", `vendor:${file}`]).replaceAll("\r\n", "\n"));
      writeFileSync(addon, readFileSync(join(repo, file), "utf8").replaceAll("\r\n", "\n"));
      try {
        writeFileSync(target, run("git", ["merge-file", "-p", target, base, addon]));
      } finally {
        unlinkSync(base);
        unlinkSync(addon);
      }
    }
    for (const path of ["src/pvp", "scripts/pvp", "test/tests/pvp", "test/fixtures/pvp", "pvp.nginx.conf"])
      cpSync(join(repo, path), join(dir, path), { recursive: true });
    writeFileSync(
      join(dir, "src/pvp/audit-policy.json"),
      JSON.stringify({ policy: registry.versions[version].auditPolicy }) + "\n",
    );
    cpSync(
      resolve(server, "pvp", registry.versions[version].rulesDir, "rules.manifest.json"),
      join(dir, "src/pvp/rules-manifest.json"),
    );
    console.log(`Synced addon into native ${version}; ${seams.length} guarded merges`);
  }
  check();
}
function nativeSource() {
  const output = resolve(workspace, "review", `native-source-${Date.now()}`);
  mkdirSync(output, { recursive: true });
  const report = [];
  const walk = (root, dir = "src") =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(root, `${dir}/${e.name}`) : [`${dir}/${e.name}`],
    );
  for (const [version, p] of Object.entries(config.profiles)) {
    const pristine = join(output, version);
    mkdirSync(pristine);
    const archive = join(output, `${version}.tar`);
    git(["archive", "--format=tar", "--output", archive, `v${version}`, "src"]);
    run("tar", ["-xf", archive, "-C", pristine]);
    unlinkSync(archive);
    const brandingFiles = ["src/data/splash-messages.ts", "src/ui/handlers/menu-ui-handler.ts"];
    const expected = walk(pristine).filter(f => !seams.includes(f) && !brandingFiles.includes(f)),
      actual = walk(resolve(workspace, p.directory)).filter(f => !seams.includes(f) && !brandingFiles.includes(f) && !f.startsWith("src/pvp/"));
    assert.deepEqual(actual.sort(), expected.sort(), `${version}: native file set changed`);
    for (const file of expected)
      assert.equal(
        readFileSync(resolve(workspace, p.directory, file), "utf8").replaceAll("\r\n", "\n"),
        readFileSync(join(pristine, file), "utf8").replaceAll("\r\n", "\n"),
        `${version}: unexpected native edit ${file}`,
      );
    report.push({
      version,
      nativeCommit: git(["rev-parse", `v${version}^{commit}`]).trim(),
      unchangedNativeFiles: expected.length,
      guardedSeams: seams,
    });
  }
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(`PASS: all native source files outside guarded seams; ${join(output, "result.json")}`);
}
function backup() {
  const out = resolve(process.argv[3] || join(workspace, "review", `release-backup-${Date.now()}`));
  if (existsSync(join(out, "database.sql"))) throw Error("Backup exists; choose a new directory");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "database.sql"),
    docker([
      "exec",
      "-T",
      "db",
      "sh",
      "-c",
      'exec mariadb-dump --single-transaction --hex-blob --routines -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"',
    ]),
  );
  const id = docker(["ps", "-q", "server"]).trim();
  run("docker", ["cp", `${id}:/data/pvp.key`, join(out, "pvp.key")]);
  run("docker", ["cp", `${id}:/app/rogueserver`, join(out, "rogueserver")]);
  for (const file of ["compose.pvp.yml", "pvp-release.json", "pvp.gateway.conf"])
    cpSync(resolve(workspace, file), join(out, file));
  run("docker", ["cp", `${id}:/app/pvp/versions.json`, join(out, "versions.json")]);
  writeFileSync(join(out, "containers.json"), docker(["ps", "--format", "json"]));
  console.log(`Backup saved: ${out}. Treat this directory as private.`);
}
async function verify() {
  check();
  const base = process.env.POKEROGUE_URL || "http://localhost:8000";
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.gameVersion, config.defaultVersion);
  const paths = ["/", ...Object.keys(config.profiles).map(v => `/engines/${v}/`)];
  for (const path of paths) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<html/);
  }
  for (const [version, p] of Object.entries(config.profiles)) {
    const script =
      "const f=require('fs'),c=require('crypto');const paths="
      + JSON.stringify([
        "package.json",
        "src/pvp/index.ts",
        "src/pvp/panel.ts",
        "src/pvp/rules-manifest.json",
        "src/system/game-data.ts",
      ])
      + ";console.log(JSON.stringify(Object.fromEntries(paths.map(p=>[p,c.createHash('sha256').update(f.readFileSync(p)).digest('hex')]))))";
    const hashes = JSON.parse(docker(["exec", "-T", p.audit, "node", "-e", script]));
    for (const [file, hash] of Object.entries(hashes))
      assert.equal(hash, sha(readFileSync(resolve(workspace, p.directory, file))), `${version}: deployed ${file}`);
  }
  console.log("PASS: default release, every legacy route, and deployed audit source hashes");
}
if (command === "sync") sync();
else if (command === "native-check") {
  check();
  nativeSource();
} else if (command === "test") {
  check();
  nativeSource();
  for (const p of Object.values(config.profiles))
    docker(
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "-e",
        "NODE_ENV=test",
        "-e",
        "NODE_OPTIONS=--max-old-space-size=2048",
        p.audit,
        "node",
        "node_modules/vitest/vitest.mjs",
        "run",
        "test/tests/pvp",
        "--pool",
        "threads",
        "--maxWorkers",
        "1",
        "--silent=passed-only",
      ],
      { stdio: "inherit" },
    );
} else if (command === "check") check();
else if (command === "backup") backup();
else if (command === "build") {
  check();
  docker(["build"], { stdio: "inherit" });
} else if (command === "deploy") {
  check();
  docker(["up", "-d", "--no-build", "--wait"], { stdio: "inherit" });
  // Nginx resolves named upstreams when loading its configuration. Re-resolve
  // after all replaced native containers are ready, including an unchanged gateway.
  for (const service of [...Object.values(config.profiles).map(p => p.game), "game"]) {
    docker(["exec", "-T", service, "nginx", "-t"], { stdio: "inherit" });
    docker(["exec", "-T", service, "nginx", "-s", "reload"], { stdio: "inherit" });
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  await verify();
} else if (command === "verify") await verify();
else throw Error("Usage: version-release.mjs check|sync|native-check|test|backup [DIRECTORY]|build|deploy|verify");
