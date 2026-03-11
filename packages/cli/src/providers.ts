import type { UsageSummary } from "./interfaces";
import { loadClaudeRows } from "./lib/claude-code";
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
}

export async function aggregateUsage({
  start,
  end,
}: AggregateUsageOptions): Promise<Record<ProviderId, UsageSummary | null>> {
  const loaders: Record<
    ProviderId,
    (startDate: Date, endDate: Date) => Promise<UsageSummary>
  > = {
    claude: loadClaudeRows,
    codex: loadCodexRows,
    gemini: loadGeminiRows,
    opencode: loadOpenCodeRows,
  };
  const summaries = {} as Record<ProviderId, UsageSummary | null>;

  for (const provider of providerIds) {
    const summary = await loaders[provider](start, end);

    summaries[provider] = hasUsage(summary) ? summary : null;
  }

  return summaries;
}
