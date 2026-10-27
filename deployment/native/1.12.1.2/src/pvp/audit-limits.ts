// SPDX-License-Identifier: AGPL-3.0-only
// Six native holders can exceed 200 distinct stacks. Reroll offers each carry
// a complete session, so the expanded wave can exceed 256 KiB while remaining
// small on the wire. Keep the compressed per-wave limit unchanged.
export const MAX_AUDIT_ITEMS = 1024;
export const MAX_AUDIT_WAVE_BYTES = 16 * 1024 * 1024;
// Structural safety limit; the level auditor derives the much smaller earned
// budget from native EXP caps and verified candy choices, including Candy Jars.
export const MAX_AUDIT_LEVEL = 1000000;
// Native addMoney/updatePlayerMoney clamp the wallet at this safe integer.
// This is a structural limit; MoneyAudit separately checks available income.
export const MAX_AUDIT_MONEY = Number.MAX_SAFE_INTEGER;
