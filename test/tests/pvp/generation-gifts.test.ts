// SPDX-License-Identifier: AGPL-3.0-only
import { registerGenerationReplayTests } from "./generation-suite";

registerGenerationReplayTests(
  [
    ["ko", false, "normal", false, false, false],
    ["ko", false, false, false, false, false, false, "gift"],
    ["ko", false, false, false, false, false, false, "return"],
  ],
  false,
);
