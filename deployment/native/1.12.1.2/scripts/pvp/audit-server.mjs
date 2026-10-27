// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const limit = Math.max(1, Math.min(4, Number(process.env.PVP_AUDIT_WORKERS) || 1));
let running = 0;
const send = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
async function execute(input) {
  const dir = await mkdtemp(join(tmpdir(), "pvp-audit-"));
  try {
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    await writeFile(inputPath, input);
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=2048",
          "node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          "scripts/pvp/audit.config.ts",
          "--silent",
        ],
        {
          env: { ...process.env, NODE_ENV: "test", PVP_AUDIT_INPUT: inputPath, PVP_AUDIT_OUTPUT: outputPath },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      child.stderr.on("data", data => {
        stderr = (stderr + data).slice(-4000);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("audit worker timeout"));
      }, 300000);
      child.once("error", err => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", code => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`audit worker exited ${code}: ${stderr}`));
      });
    });
    return JSON.parse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, running, limit });
  }
  if (req.method !== "POST" || req.url !== "/verify") {
    return send(res, 404, {});
  }
  try {
    const key = await readFile(process.env.PVP_AUDIT_KEY_FILE || "/data/pvp.key");
    const token = `Bearer ${createHmac("sha256", key).update("pvp-audit-v1").digest("hex")}`;
    const auth = req.headers.authorization || "";
    if (auth.length !== token.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(token))) {
      return send(res, 401, {});
    }
    if (running >= limit) {
      return send(res, 503, { reason: "audit worker busy" });
    }
    running++;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          return send(res, 413, { reason: "audit input too large" });
        }
        chunks.push(chunk);
      }
      const result = await execute(Buffer.concat(chunks));
      send(res, result.retry ? 503 : 200, result);
    } finally {
      running--;
    }
  } catch (error) {
    console.error(error);
    send(res, 503, { reason: "audit worker unavailable" });
  }
}).listen(8002, "0.0.0.0");
