// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";
export default defineConfig(async env => {
  const config = await base(env);
  return {
    ...config,
    test: {
      ...config.test,
      include: [process.env.PVP_AUTOMATION_TEST || "scripts/pvp/automation-seed.test.ts"],
      maxWorkers: 1,
      pool: "threads",
      testTimeout: 600000,
      reporters: ["dot"],
    },
  };
});
