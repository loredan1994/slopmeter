import type { PricingMode, ProviderPricingSummary, UsageSummary } from "../interfaces";
import { estimateGoogleCosts } from "./google-pricing";
import { estimateOpenAICosts } from "./openai-pricing";

export async function estimateProviderCosts({
  summary,
  mode,
  subscriptionPrice,
  startDate,
  endDate,
}: {
  summary: UsageSummary;
  mode: PricingMode;
  subscriptionPrice: number | null;
  startDate: Date;
  endDate: Date;
}): Promise<ProviderPricingSummary | null> {
  if (summary.provider === "codex" && subscriptionPrice) {
    return estimateOpenAICosts({
      summary,
      mode,
      subscriptionPrice,
      startDate,
      endDate,
    });
  }

  if (summary.provider === "gemini") {
    return estimateGoogleCosts({
      mode,
      startDate,
      endDate,
    });
  }

  return null;
}
