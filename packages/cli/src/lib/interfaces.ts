import type { UsageSummary } from "../interfaces";

export type ProviderId = UsageSummary["provider"];

export const providerIds: ProviderId[] = [
  "claude",
  "codex",
  "gemini",
  "copilot",
  "antigravity",
  "opencode",
];

export const providerStatusLabel: Record<ProviderId, string> = {
  claude: "Claude code",
  codex: "Codex",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  antigravity: "Antigravity",
  opencode: "Open Code",
};
