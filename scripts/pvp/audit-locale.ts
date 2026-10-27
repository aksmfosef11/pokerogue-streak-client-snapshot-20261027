// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import i18next from "i18next";
import { namespaceMap } from "../../src/i18n-namespace-map";
import { AuditInputError } from "../../src/pvp/audit-errors";
import { toCamelCase } from "../../src/utils/strings";

const loaded = new Set<string>();
/** Trainer generation can consume localized name pools. Load the pinned local
 * dictionaries directly: the upstream unit-test HTTP mock only serves English. */
export async function loadAuditLocale(language: string): Promise<void> {
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,4})?$/.test(language)) {
    throw new AuditInputError("invalid audit language");
  }
  const available = readdirSync("locales", { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  const hierarchy = [...new Set([language, language === "es-419" ? "es-ES" : language.split("-")[0], "en"])].filter(
    code => available.includes(code),
  );
  if (hierarchy.length === 1 && hierarchy[0] === "en" && !language.startsWith("en")) {
    throw new AuditInputError("unsupported audit language");
  }
  for (const code of hierarchy) {
    if (loaded.has(code)) {
      continue;
    }
    function visit(path: string, prefix = "") {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          visit(join(path, entry.name), `${prefix}${toCamelCase(entry.name)}/`);
        } else if (entry.name.endsWith(".json")) {
          const stem = entry.name.slice(0, -5);
          let name = Object.entries(namespaceMap).find(([, file]) => file === stem)?.[0] ?? toCamelCase(stem);
          if (prefix.startsWith("mysteryEncounters/")) {
            name = name.replace(/Dialogue$/, "");
          }
          const namespace = prefix + name;
          i18next.addResourceBundle(
            code,
            namespace,
            JSON.parse(readFileSync(join(path, entry.name), "utf8")),
            true,
            true,
          );
        }
      }
    }
    visit(join("locales", code));
    loaded.add(code);
  }
  await i18next.changeLanguage(language);
}
