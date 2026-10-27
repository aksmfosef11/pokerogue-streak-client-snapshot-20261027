// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

export default defineConfig(async env => {
  const config = await base(env);
  return {
    ...config,
    test: {
      ...config.test,
      include: ["scripts/pvp/wave-rate.test.ts"],
      maxWorkers: 1,
      reporters: ["dot"],
    },
  };
});
