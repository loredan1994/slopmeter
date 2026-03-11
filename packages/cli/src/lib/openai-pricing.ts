import type {
  DailyUsage,
  OpenAIPricingMode,
  PricingSource,
  PricedModelCost,
  ProviderPricingSummary,
  UnresolvedModelCost,
  UsageSummary,
} from "../interfaces";

const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";

interface AggregatedModelTokens {
  model: string;
  input: number;
  cachedInput: number;
  output: number;
  total: number;
}

interface PricingRow {
  model: string;
  input: number | null;
  cachedInput: number | null;
  output: number | null;
}

interface PricingIndex {
  source: PricingSource;
  rows: Map<string, PricingRow>;
}

interface ResolvedPricingRow {
  row: PricingRow;
  note?: string;
}

const modelAliases: Record<string, string> = {
  "gpt-5.4": "gpt-5.4 (<272K context length)",
  "gpt-5.4-pro": "gpt-5.4-pro (<272K context length)",
};

function decodeHtmlEntities(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    );
}

function stripHtml(value: string) {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(small|span)>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function parseCurrencyCell(value: string) {
  const normalized = stripHtml(value);

  if (normalized === "" || normalized === "-" || normalized === "/") {
    return null;
  }

  const match = normalized.match(/\$([0-9]+(?:\.[0-9]+)?)/);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function extractLatestPricingSection(html: string) {
  const start = html.indexOf('id="content-switcher-latest-pricing"');

  if (start === -1) {
    throw new Error(
      "Could not find the latest pricing section in OpenAI docs.",
    );
  }

  const next = html.indexOf('id="content-switcher-', start + 1);

  return next === -1 ? html.slice(start) : html.slice(start, next);
}

function extractPricingTableBody(html: string, mode: OpenAIPricingMode) {
  const section = extractLatestPricingSection(html);
  const pattern = new RegExp(
    `data-content-switcher-pane="true" data-value="${mode}"(?: hidden)?><div class="hidden">[^<]*<\\/div><table[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody><\\/table><\\/div>`,
  );
  const match = section.match(pattern);

  if (!match) {
    throw new Error(`Could not find the OpenAI ${mode} pricing table.`);
  }

  return match[1];
}

function parsePricingRows(tbodyHtml: string) {
  const rows: PricingRow[] = [];

  for (const rowMatch of tbodyHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (match) => match[1],
    );

    if (cells.length < 4) {
      continue;
    }

    rows.push({
      model: stripHtml(cells[0]),
      input: parseCurrencyCell(cells[1]),
      cachedInput: parseCurrencyCell(cells[2]),
      output: parseCurrencyCell(cells[3]),
    });
  }

  return rows;
}

async function fetchPricingIndex(
  mode: OpenAIPricingMode,
): Promise<PricingIndex> {
  const response = await fetch(OPENAI_PRICING_URL);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenAI pricing docs: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const rows = parsePricingRows(extractPricingTableBody(html, mode));

  if (rows.length === 0) {
    throw new Error("OpenAI pricing docs did not include any parseable rows.");
  }

  return {
    source: {
      url: response.url || OPENAI_PRICING_URL,
      retrievedAt: new Date().toISOString(),
      mode,
    },
    rows: new Map(rows.map((row) => [row.model, row])),
  };
}

function aggregateModels(daily: DailyUsage[]) {
  const totals = new Map<string, AggregatedModelTokens>();

  for (const day of daily) {
    for (const model of day.breakdown) {
      const existing = totals.get(model.name);

      if (!existing) {
        totals.set(model.name, {
          model: model.name,
          input: model.tokens.input,
          cachedInput: model.tokens.cache.input,
          output: model.tokens.output,
          total: model.tokens.total,
        });
        continue;
      }

      existing.input += model.tokens.input;
      existing.cachedInput += model.tokens.cache.input;
      existing.output += model.tokens.output;
      existing.total += model.tokens.total;
    }
  }

  return [...totals.values()].sort((a, b) => b.total - a.total);
}

function resolvePricingRow(
  model: string,
  pricingRows: Map<string, PricingRow>,
): ResolvedPricingRow | null {
  const exact = pricingRows.get(model);

  if (exact) {
    return { row: exact };
  }

  const alias = modelAliases[model];

  if (!alias) {
    return null;
  }

  const aliased = pricingRows.get(alias);

  if (!aliased) {
    return null;
  }

  return {
    row: aliased,
    note: `${model} is estimated with the official ${alias} row because the session logs do not record the pricing variant.`,
  };
}

function toCost(tokens: number, ratePer1M: number | null) {
  if (!ratePer1M || tokens <= 0) {
    return 0;
  }

  return (tokens / 1_000_000) * ratePer1M;
}

function countBillingMonths(startDate: Date, endDate: Date) {
  const anchorDay = startDate.getDate();
  const endYear = endDate.getFullYear();
  const endMonth = endDate.getMonth();
  const endDay = endDate.getDate();
  let year = startDate.getFullYear();
  let month = startDate.getMonth();
  let months = 0;

  for (;;) {
    const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
    const cursorDay = Math.min(anchorDay, lastDayOfMonth);

    if (
      year > endYear ||
      (year === endYear &&
        (month > endMonth || (month === endMonth && cursorDay >= endDay)))
    ) {
      break;
    }

    months += 1;
    month += 1;

    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  return Math.max(months, 1);
}

function createPricedModel(
  tokens: AggregatedModelTokens,
  pricing: PricingRow,
): PricedModelCost {
  const uncachedInputTokens = Math.max(tokens.input - tokens.cachedInput, 0);
  const inputCost = toCost(uncachedInputTokens, pricing.input);
  const cachedInputCost = toCost(tokens.cachedInput, pricing.cachedInput);
  const outputCost = toCost(tokens.output, pricing.output);

  return {
    model: tokens.model,
    pricingModel: pricing.model,
    tokens: {
      input: tokens.input,
      uncachedInput: uncachedInputTokens,
      cachedInput: tokens.cachedInput,
      output: tokens.output,
      total: tokens.total,
    },
    ratesPer1M: {
      input: pricing.input ?? 0,
      cachedInput: pricing.cachedInput,
      output: pricing.output ?? 0,
    },
    estimatedCost: {
      input: inputCost,
      cachedInput: cachedInputCost,
      output: outputCost,
      total: inputCost + cachedInputCost + outputCost,
    },
  };
}

function createUnresolvedModel(
  tokens: AggregatedModelTokens,
  reason: string,
): UnresolvedModelCost {
  return {
    model: tokens.model,
    reason,
    tokens: {
      input: tokens.input,
      cachedInput: tokens.cachedInput,
      output: tokens.output,
      total: tokens.total,
    },
  };
}

export async function estimateOpenAICosts({
  summary,
  mode,
  subscriptionPrice,
  startDate,
  endDate,
}: {
  summary: UsageSummary;
  mode: OpenAIPricingMode;
  subscriptionPrice: number;
  startDate: Date;
  endDate: Date;
}): Promise<ProviderPricingSummary> {
  const pricingIndex = await fetchPricingIndex(mode);
  const aggregatedModels = aggregateModels(summary.daily);
  const models: PricedModelCost[] = [];
  const unresolvedModels: UnresolvedModelCost[] = [];
  const notes = new Set<string>([
    "This is a what-if comparison of the same logged usage under two billing paths: API keys versus a fixed monthly subscription.",
    "The API-key estimate is fetched live from the official OpenAI pricing docs and applied per 1M tokens.",
    "The subscription total is modeled as a fixed monthly cost across the selected window and is not added on top of the API-key estimate.",
    "Cached input tokens are treated as a subset of input tokens, so only uncached input is billed at the full input rate.",
  ]);

  for (const tokens of aggregatedModels) {
    const resolved = resolvePricingRow(tokens.model, pricingIndex.rows);

    if (!resolved) {
      unresolvedModels.push(
        createUnresolvedModel(
          tokens,
          "No matching official OpenAI API pricing row was found for this model.",
        ),
      );
      continue;
    }

    if (resolved.note) {
      notes.add(resolved.note);
    }

    models.push(createPricedModel(tokens, resolved.row));
  }

  models.sort((a, b) => b.estimatedCost.total - a.estimatedCost.total);

  const totals = models.reduce(
    (accumulator, model) => {
      accumulator.input += model.tokens.input;
      accumulator.uncachedInput += model.tokens.uncachedInput;
      accumulator.cachedInput += model.tokens.cachedInput;
      accumulator.output += model.tokens.output;
      accumulator.estimatedCost.input += model.estimatedCost.input;
      accumulator.estimatedCost.cachedInput += model.estimatedCost.cachedInput;
      accumulator.estimatedCost.output += model.estimatedCost.output;
      accumulator.estimatedCost.total += model.estimatedCost.total;

      return accumulator;
    },
    {
      input: 0,
      uncachedInput: 0,
      cachedInput: 0,
      output: 0,
      estimatedCost: {
        input: 0,
        cachedInput: 0,
        output: 0,
        total: 0,
      },
    },
  );

  if (unresolvedModels.length > 0) {
    notes.add(
      `Unpriced models are excluded from the API total until OpenAI publishes an official rate for them.`,
    );
  }

  const months = countBillingMonths(startDate, endDate);
  const totalSubscriptionCost = subscriptionPrice * months;
  const difference = totals.estimatedCost.total - totalSubscriptionCost;
  const cheaperOption =
    difference > 0 ? "subscription" : difference < 0 ? "api" : "equal";

  return {
    vendor: "openai",
    source: pricingIndex.source,
    models,
    unresolvedModels,
    totals,
    subscriptionComparison: {
      monthlyPrice: subscriptionPrice,
      months,
      totalSubscriptionCost,
      difference,
      cheaperOption,
    },
    notes: [...notes],
  };
}
