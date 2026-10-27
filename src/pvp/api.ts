// SPDX-License-Identifier: AGPL-3.0-only
import { ApiBase } from "#api/api-base";
import { battleSourceVersion } from "./battle-route";
export class PvpApi extends ApiBase {
  private source: string | undefined;

  setSource(source?: string): void {
    this.source = source;
  }

  async request<T>(path: string, body?: Record<string, unknown>, source?: string | null): Promise<T> {
    const selected = source === null ? undefined : source ?? this.source ?? battleSourceVersion();
    const response = await this.doFetch(`/pvp/${path}`, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      headers: selected ? { "PKR-PVP-Source-Version": selected } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json() as Promise<T>;
  }
}
export const pvpApi = new PvpApi(import.meta.env.VITE_SERVER_URL ?? "http://localhost:8001");
