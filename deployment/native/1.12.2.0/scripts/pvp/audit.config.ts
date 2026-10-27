// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

export default defineConfig(async env => {
  const config = await base(env);
  return {
    ...config,
    test: {
      ...config.test,
      include: [
        process.env.PVP_EGG_PRODUCER_INPUT ? "scripts/pvp/egg-producer.test.ts" : "scripts/pvp/audit-job.test.ts",
      ],
      maxWorkers: 1,
      pool: "threads",
      testTimeout: 270000,
      reporters: ["dot"],
    },
  };
});
