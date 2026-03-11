export interface UsageSummary {
  provider:
    | "claude"
    | "codex"
    | "gemini"
    | "opencode"
    | "copilot"
    | "antigravity";
  daily: DailyUsage[];
  insights?: Insights;
  pricing?: ProviderPricingSummary;
  presentation?: UsagePresentation;
}

export interface DailyUsage {
  date: Date;
  input: number;
  output: number;
  cache: {
    input: number;
    output: number;
  };
  total: number;
  // usage by model, sorted by total tokens
  breakdown: ModelUsage[];
}

export interface ModelUsage {
  name: string;
  tokens: {
    input: number;
    output: number;
    cache: {
      input: number;
      output: number;
    };
    total: number;
  };
}

export interface Insights {
  mostUsedModel?: ModelUsage;
  recentMostUsedModel?: ModelUsage;
  topModels: ModelUsage[];
  recentTopModels: ModelUsage[];
  streaks: {
    longest: number;
    current: number;
  };
}

export interface JsonExportPayload {
  version: string;
  start: string;
  end: string;
  providers: JsonUsageSummary[];
}

export interface JsonUsageSummary {
  provider:
    | "claude"
    | "codex"
    | "gemini"
    | "opencode"
    | "copilot"
    | "antigravity";
  daily: JsonDailyUsage[];
  insights?: Insights;
  pricing?: ProviderPricingSummary;
  presentation?: UsagePresentation;
}

export interface JsonDailyUsage {
  date: string;
  input: number;
  output: number;
  cache: {
    input: number;
    output: number;
  };
  total: number;
  breakdown: ModelUsage[];
}

export type PricingMode = "batch" | "flex" | "standard" | "priority";
export type PricingVendor = "anthropic" | "google" | "openai";
export type MetricFormat = "count" | "tokens";

export interface SummaryMetric {
  label: string;
  value: number;
  format?: MetricFormat;
}

export interface UsagePresentation {
  usageUnit?: MetricFormat;
  unitLabel?: string;
  entityLabel?: string;
  headerMetrics?: SummaryMetric[];
  leaderboardTitle?: string;
  noBreakdownMessage?: string;
}

export interface PricingSource {
  url: string;
  retrievedAt: string;
  vendor: PricingVendor;
  mode?: PricingMode | string;
}

export interface ProviderPricingSummary {
  vendor: PricingVendor;
  source: PricingSource;
  models: PricedModelCost[];
  unresolvedModels: UnresolvedModelCost[];
  totals: {
    input: number;
    uncachedInput: number;
    cachedInput: number;
    output: number;
    estimatedCost: {
      input: number;
      cachedInput: number;
      output: number;
      total: number;
    };
  };
  subscriptionComparison?: {
    monthlyPrice: number;
    months: number;
    totalSubscriptionCost: number;
    difference: number;
    cheaperOption: "api" | "subscription" | "equal";
  };
  notes: string[];
}

export interface PricedModelCost {
  model: string;
  pricingModel: string;
  vendor: PricingVendor;
  tokens: {
    input: number;
    uncachedInput: number;
    cachedInput: number;
    output: number;
    total: number;
  };
  ratesPer1M: {
    input: number;
    cachedInput: number | null;
    output: number;
  };
  estimatedCost: {
    input: number;
    cachedInput: number;
    output: number;
    total: number;
  };
}

export interface UnresolvedModelCost {
  model: string;
  vendor: PricingVendor;
  reason: string;
  tokens: {
    input: number;
    cachedInput: number;
    output: number;
    total: number;
  };
}
