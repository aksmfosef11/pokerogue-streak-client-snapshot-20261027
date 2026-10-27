// SPDX-License-Identifier: AGPL-3.0-only
// Build a separate native checkout; applying the seam patch must preserve the
// selected tag's engine, rather than relabelling the current client.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [version, destination] = process.argv.slice(2);
assert.match(version ?? "", /^\d+\.\d+\.\d+\.\d+$/u, "usage: prepare-version.mjs VERSION NEW_DIRECTORY");
assert.ok(destination, "a new output directory is required");
const output = resolve(destination);
assert.ok(!existsSync(output), `output already exists: ${output}`);
const git = args => execFileSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true }).trim();
const tag = `v${version}`;
const nativeCommit = git(["rev-parse", `${tag}^{commit}`]);
const addonCommit = git(["rev-parse", "HEAD"]);
// Inheriting dependencies/assets from the current audit image is allowed only
// when the selected native release pins the exact same content.
for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  assert.equal(
    git(["rev-parse", `${tag}:${file}`]),
    git(["rev-parse", `vendor:${file}`]),
    `${file}: different native pin`,
  );
}
const seams = [
  "src/battle-scene.ts",
  "src/data/egg.ts",
  "src/data/status-effect.ts",
  "src/phases/select-modifier-phase.ts",
  "src/phases/select-starter-phase.ts",
  "src/phases/title-phase.ts",
  "src/system/game-data.ts",
];
const patch = execFileSync("git", ["diff", "--binary", "vendor", "--", ...seams], { cwd: source });
mkdirSync(output, { recursive: true });
const archive = `${output}.tar`;
git(["archive", "--format=tar", "--output", archive, tag]);
try {
  execFileSync("tar", ["-xf", archive, "-C", output], { windowsHide: true });
} finally {
  unlinkSync(archive);
}
const patchPath = join(output, "pvp-seams.patch");
writeFileSync(patchPath, patch);
// Merge each guarded seam against its real native base. New releases may edit
// adjacent imports, so a context-only patch is insufficient for a safe port.
for (const file of seams) {
  const base = join(output, "pvp-seam-base.local");
  const addon = join(output, "pvp-seam-addon.local");
  writeFileSync(
    base,
    execFileSync("git", ["show", `vendor:${file}`], { cwd: source, encoding: "utf8" }).replace(/\r\n/g, "\n"),
  );
  writeFileSync(addon, readFileSync(join(source, file), "utf8").replace(/\r\n/g, "\n"));
  writeFileSync(join(output, file), readFileSync(join(output, file), "utf8").replace(/\r\n/g, "\n"));
  try {
    const merged = execFileSync("git", ["merge-file", "-p", join(output, file), base, addon], { windowsHide: true });
    writeFileSync(join(output, file), merged);
  } finally {
    unlinkSync(base);
    unlinkSync(addon);
  }
}
// Media must come from the selected native tag, including new shiny variants.
for (const name of ["assets", "locales"]) {
  const pin = git(["rev-parse", `${tag}:${name}`]);
  const mediaArchive = `${output}-${name}.tar`;
  execFileSync("git", ["-C", name, "archive", "--format=tar", "--output", mediaArchive, pin], {
    cwd: source,
    windowsHide: true,
  });
  mkdirSync(join(output, name), { recursive: true });
  try {
    execFileSync("tar", ["-xf", mediaArchive, "-C", join(output, name)], { windowsHide: true });
  } finally {
    unlinkSync(mediaArchive);
  }
}
for (const file of [
  "src/pvp",
  "scripts/pvp",
  "test/tests/pvp",
  "test/fixtures/pvp",
  "vite.pvp.config.ts",
  "pvp.nginx.conf",
  "Dockerfile.audit.dockerignore",
  "Dockerfile.pvp.dockerignore",
]) {
  cpSync(join(source, file), join(output, file), { recursive: true });
}
const packagePath = join(output, "package.json");
const nativePackage = JSON.parse(readFileSync(packagePath, "utf8"));
const currentPackage = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
assert.equal(nativePackage.version, version);
assert.deepEqual(nativePackage.dependencies, currentPackage.dependencies, "different native dependencies");
assert.deepEqual(
  nativePackage.devDependencies,
  currentPackage.devDependencies,
  "different native development dependencies",
);
nativePackage.scripts = currentPackage.scripts;
writeFileSync(packagePath, `${JSON.stringify(nativePackage, null, 2)}\n`);
const policy = JSON.parse(readFileSync(join(source, "src/pvp/audit-policy.json"), "utf8")).policy;
writeFileSync(
  join(output, "src/pvp/audit-policy.json"),
  `${JSON.stringify({ policy: version + policy.slice(policy.indexOf(":")) }, null, 2)}\n`,
);
writeFileSync(
  join(output, "Dockerfile.audit"),
  "FROM auditbase\nWORKDIR /app\nRUN rm -rf /app/src /app/test /app/scripts /app/assets /app/locales /app/plugins /app/game-data-output\nCOPY . .\n",
);
writeFileSync(
  join(output, "Dockerfile.pvp"),
  `FROM auditold AS build
WORKDIR /app
ENV VITE_BYPASS_LOGIN=0 VITE_BYPASS_TUTORIAL=1 VITE_SERVER_URL=/api VITE_PVP_ENABLED=1
RUN node node_modules/typescript/bin/tsc && node node_modules/vite/bin/vite.js build --config vite.pvp.config.ts
FROM nginx:alpine
COPY pvp.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/assets /usr/share/nginx/html
COPY --from=build /app/locales /usr/share/nginx/html/locales
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
`,
);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const addonFiles = {};
function record(dir) {
  for (const entry of readdirSync(join(output, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      record(file);
    } else {
      addonFiles[file] = hash(readFileSync(join(output, file)));
    }
  }
}
for (const dir of ["src/pvp", "scripts/pvp"]) {
  record(dir);
}
const provenance = {
  version,
  nativeTag: tag,
  nativeCommit,
  addonCommit,
  seamPatchSHA256: hash(patch),
  assets: git(["rev-parse", `${tag}:assets`]),
  locales: git(["rev-parse", `${tag}:locales`]),
  nativeBattlerTagsSHA256: hash(readFileSync(join(output, "src/data/battler-tags.ts"))),
  addonFiles,
};
writeFileSync(join(output, "pvp-version-source.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Prepared native ${tag} (${nativeCommit}) with ${seams.length} guarded seam files at ${output}`);
console.log("Export matching rules/manifest in the native image before enabling this version in the server registry.");
