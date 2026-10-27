// SPDX-License-Identifier: AGPL-3.0-only
import { registerGenerationReplayTests } from "./generation-suite";

registerGenerationReplayTests(
  [
    ["ko", false, false, false, false, "clown"],
    ["ko", false, false, false, false, "fiery"],
  ],
  false,
);
