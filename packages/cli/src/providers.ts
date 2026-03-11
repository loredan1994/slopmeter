import type { UsageSummary } from "./interfaces";
import { loadAntigravityRows } from "./lib/antigravity";
import { loadClaudeRows } from "./lib/claude-code";
import { loadCopilotRows } from "./lib/copilot";
import { loadCodexRows } from "./lib/codex";
import { loadGeminiRows } from "./lib/gemini";
import {
  providerIds,
  providerStatusLabel,
  type ProviderId,
} from "./lib/interfaces";
import { loadOpenCodeRows } from "./lib/open-code";
import { hasUsage } from "./lib/utils";

export { providerIds, providerStatusLabel, type ProviderId };

interface AggregateUsageOptions {
  start: Date;
  end: Date;
  requestedProviders?: ProviderId[];
}

export interface AggregateUsageResult {
  rowsByProvider: Record<ProviderId, UsageSummary | null>;
  warnings: string[];
}

export async function aggregateUsage({
  start,
  end,
  requestedProviders,
}: AggregateUsageOptions): Promise<AggregateUsageResult> {
  const providersToLoad =
    requestedProviders?.length ? requestedProviders : providerIds;
  const rowsByProvider: Record<ProviderId, UsageSummary | null> = {
    claude: null,
    codex: null,
    gemini: null,
    copilot: null,
    antigravity: null,
    opencode: null,
  };
  const warnings: string[] = [];

  for (const provider of providersToLoad) {
    const summary =
      provider === "claude"
        ? await loadClaudeRows(start, end)
        : provider === "codex"
          ? await loadCodexRows(start, end, warnings)
          : provider === "gemini"
            ? await loadGeminiRows(start, end)
            : provider === "copilot"
              ? await loadCopilotRows(start, end)
              : provider === "antigravity"
                ? await loadAntigravityRows(start, end)
                : await loadOpenCodeRows(start, end);

    rowsByProvider[provider] = hasUsage(summary) ? summary : null;
  }

  return { rowsByProvider, warnings };
}
