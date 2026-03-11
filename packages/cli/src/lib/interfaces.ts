import type { UsageSummary } from "../interfaces";

export type ProviderId = UsageSummary["provider"];

export const providerIds: ProviderId[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
];

export const providerStatusLabel: Record<ProviderId, string> = {
  claude: "Claude code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "Open Code",
};
