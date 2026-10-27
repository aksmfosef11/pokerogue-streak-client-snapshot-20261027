// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, type Plugin } from "vite";
import { sharedConfig } from "./vite.config.ts";

// Docker copies assets/locales directly into nginx. Reuse upstream's remaining
// plugins, including enum inlining and the static bootstrap manifest.
export default defineConfig(async env => {
  const config = await sharedConfig(env);
  return {
    ...config,
    base: "",
    publicDir: false as const,
    plugins: (config.plugins as Plugin[]).filter(p => p.name !== "minify-public-json-files"),
  };
});
