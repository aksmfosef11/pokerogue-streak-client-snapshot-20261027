// SPDX-License-Identifier: AGPL-3.0-only
import { registerGenerationReplayTests } from "./generation-suite";

registerGenerationReplayTests([
  ["en", false, false, false, false, false],
  ["ko", false, false, false, false, false],
  ["ko", true, false, false, false, false],
  ["ko", false, true, false, false, false],
  ["ko", false, false, true, false, false],
  ["ko", false, false, false, true, false],
]);
