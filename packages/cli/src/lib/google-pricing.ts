import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type {
  PricedModelCost,
  PricingMode,
  PricingSource,
  ProviderPricingSummary,
  UnresolvedModelCost,
} from "../interfaces";
import { listFilesRecursive, normalizeModelName } from "./utils";

const GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const TIER_THRESHOLD = 200_000;

interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

interface GeminiMessage {
  id?: string;
  timestamp?: string;
  tokens?: GeminiTokens;
  model?: string;
}

interface GeminiSession {
  messages?: GeminiMessage[];
}

interface RatePair {
  small: number | null;
  large: number | null;
}

interface GooglePricingRow {
  model: string;
  input: RatePair;
  cachedInput: RatePair;
  output: RatePair;
}

interface TieredTokenBucket {
  input: number;
  uncachedInput: number;
  cachedInput: number;
  output: number;
  total: number;
}

interface AggregatedModelUsage {
  model: string;
  total: TieredTokenBucket;
  small: TieredTokenBucket;
  large: TieredTokenBucket;
}

interface PricingIndex {
  source: PricingSource;
  rows: Map<string, GooglePricingRow>;
}

const pricingIndexCache = new Map<"batch" | "standard", Promise<PricingIndex>>();

function getGeminiBaseDir() {
  const envPath = process.env.GEMINI_HOME?.trim();

  return envPath ? resolve(envPath) : join(homedir(), ".gemini");
}

function isGeminiSessionFile(filePath: string) {
  return (
    filePath.includes(`${sep}chats${sep}`) &&
    basename(filePath).startsWith("session-")
  );
}

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
      .replace(/<\/(small|span|em|sup)>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function toCost(tokens: number, ratePer1M: number | null) {
  if (!ratePer1M || tokens <= 0) {
    return 0;
  }

  return (tokens / 1_000_000) * ratePer1M;
}

function parseRatePair(cellHtml: string): RatePair {
  const normalized = stripHtml(cellHtml);

  if (
    normalized === "" ||
    normalized === "-" ||
    normalized.includes("Not available") ||
    normalized.includes("Free of charge")
  ) {
    return { small: null, large: null };
  }

  const values = [...normalized.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)].map(
    (match) => Number(match[1]),
  );

  if (values.length === 0) {
    return { small: null, large: null };
  }

  if (values.length === 1) {
    return { small: values[0], large: values[0] };
  }

  return { small: values[0], large: values[1] };
}

function extractModeTable(sectionHtml: string, mode: "batch" | "standard") {
  const heading = mode === "batch" ? "Batch" : "Standard";
  const match = sectionHtml.match(
    new RegExp(
      `<section>[\\s\\S]*?<h3 id="[^"]+" data-text="${heading}"[^>]*>${heading}<\\/h3>[\\s\\S]*?<table class="pricing-table">[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>[\\s\\S]*?<\\/table>[\\s\\S]*?<\\/section>`,
    ),
  );

  return match?.[1] ?? null;
}

function extractModelSection(html: string, model: string) {
  const marker = `id="${model}"`;
  const start = html.indexOf(marker);

  if (start === -1) {
    return null;
  }

  const next = html.indexOf('<div class="models-section">', start + marker.length);

  return next === -1 ? html.slice(start) : html.slice(start, next);
}

function parsePricingRow(
  model: string,
  sectionHtml: string,
  mode: "batch" | "standard",
): GooglePricingRow | null {
  const tbodyHtml = extractModeTable(sectionHtml, mode);

  if (!tbodyHtml) {
    return null;
  }

  const rows = [...tbodyHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]),
  );
  const rowMap = new Map(
    rows
      .filter((cells) => cells.length >= 3)
      .map((cells) => [stripHtml(cells[0]).toLowerCase(), cells[2]]),
  );
  const input = rowMap.get("input price");
  const output = rowMap.get("output price (including thinking tokens)");
  const cachedInput = rowMap.get("context caching price");

  if (!input || !output) {
    return null;
  }

  return {
    model,
    input: parseRatePair(input),
    cachedInput: cachedInput ? parseRatePair(cachedInput) : { small: null, large: null },
    output: parseRatePair(output),
  };
}

async function fetchPricingIndex(
  mode: "batch" | "standard",
  models: string[],
): Promise<PricingIndex> {
  const cached = pricingIndexCache.get(mode);

  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const response = await fetch(GOOGLE_PRICING_URL);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Google Gemini pricing docs: ${response.status} ${response.statusText}`,
      );
    }

    const html = await response.text();
    const rows = new Map<string, GooglePricingRow>();

    for (const model of models) {
      const section = extractModelSection(html, model);

      if (!section) {
        continue;
      }

      const row = parsePricingRow(model, section, mode);

      if (row) {
        rows.set(model, row);
      }
    }

    return {
      source: {
        url: response.url || GOOGLE_PRICING_URL,
        retrievedAt: new Date().toISOString(),
        vendor: "google" as const,
        mode,
      },
      rows,
    };
  })();

  pricingIndexCache.set(mode, pending);

  try {
    return await pending;
  } catch (error) {
    pricingIndexCache.delete(mode);
    throw error;
  }
}

function createTokenBucket(): TieredTokenBucket {
  return {
    input: 0,
    uncachedInput: 0,
    cachedInput: 0,
    output: 0,
    total: 0,
  };
}

function createUsage(tokens: GeminiTokens) {
  const input = Math.max(tokens.input ?? 0, 0);
  const cachedInput = Math.min(Math.max(tokens.cached ?? 0, 0), input);
  const rawTotal = Math.max(tokens.total ?? 0, 0);
  const computedOutput =
    Math.max(tokens.output ?? 0, 0) +
    Math.max(tokens.thoughts ?? 0, 0) +
    Math.max(tokens.tool ?? 0, 0);
  const output = rawTotal > 0 ? Math.max(rawTotal - input, 0) : computedOutput;
  const total = rawTotal > 0 ? rawTotal : input + output;

  return {
    input,
    cachedInput,
    uncachedInput: Math.max(input - cachedInput, 0),
    output,
    total,
    isLargePrompt: input > TIER_THRESHOLD,
  };
}

function addBucket(target: TieredTokenBucket, source: TieredTokenBucket) {
  target.input += source.input;
  target.uncachedInput += source.uncachedInput;
  target.cachedInput += source.cachedInput;
  target.output += source.output;
  target.total += source.total;
}

function aggregateMessages(
  messages: Array<{
    model: string;
    usage: ReturnType<typeof createUsage>;
  }>,
) {
  const aggregates = new Map<string, AggregatedModelUsage>();

  for (const message of messages) {
    const bucket = message.usage.isLargePrompt ? "large" : "small";
    const usageBucket = {
      input: message.usage.input,
      uncachedInput: message.usage.uncachedInput,
      cachedInput: message.usage.cachedInput,
      output: message.usage.output,
      total: message.usage.total,
    };
    const existing = aggregates.get(message.model);

    if (!existing) {
      aggregates.set(message.model, {
        model: message.model,
        total: { ...usageBucket },
        small: bucket === "small" ? { ...usageBucket } : createTokenBucket(),
        large: bucket === "large" ? { ...usageBucket } : createTokenBucket(),
      });
      continue;
    }

    addBucket(existing.total, usageBucket);
    addBucket(existing[bucket], usageBucket);
  }

  return [...aggregates.values()].sort((a, b) => b.total.total - a.total.total);
}

function createPricedModel(
  aggregate: AggregatedModelUsage,
  pricing: GooglePricingRow,
): PricedModelCost {
  const inputCost =
    toCost(aggregate.small.uncachedInput, pricing.input.small) +
    toCost(aggregate.large.uncachedInput, pricing.input.large);
  const cachedInputCost =
    toCost(aggregate.small.cachedInput, pricing.cachedInput.small) +
    toCost(aggregate.large.cachedInput, pricing.cachedInput.large);
  const outputCost =
    toCost(aggregate.small.output, pricing.output.small) +
    toCost(aggregate.large.output, pricing.output.large);

  return {
    model: aggregate.model,
    pricingModel: pricing.model,
    vendor: "google",
    tokens: {
      input: aggregate.total.input,
      uncachedInput: aggregate.total.uncachedInput,
      cachedInput: aggregate.total.cachedInput,
      output: aggregate.total.output,
      total: aggregate.total.total,
    },
    ratesPer1M: {
      input: pricing.input.small ?? 0,
      cachedInput: pricing.cachedInput.small,
      output: pricing.output.small ?? 0,
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
  aggregate: AggregatedModelUsage,
  reason: string,
): UnresolvedModelCost {
  return {
    model: aggregate.model,
    vendor: "google",
    reason,
    tokens: {
      input: aggregate.total.input,
      cachedInput: aggregate.total.cachedInput,
      output: aggregate.total.output,
      total: aggregate.total.total,
    },
  };
}

async function collectGeminiMessages(startDate: Date, endDate: Date) {
  const files = (await listFilesRecursive(join(getGeminiBaseDir(), "tmp"), ".json")).filter(
    isGeminiSessionFile,
  );
  const dedupe = new Set<string>();
  const messages: Array<{ model: string; usage: ReturnType<typeof createUsage> }> = [];

  for (const file of files) {
    let session: GeminiSession;

    try {
      session = JSON.parse(await readFile(file, "utf8")) as GeminiSession;
    } catch {
      continue;
    }

    for (const message of session.messages ?? []) {
      const timestamp = message.timestamp?.trim();
      const model = message.model?.trim();

      if (!timestamp || !model || !message.tokens) {
        continue;
      }

      if (message.id && dedupe.has(message.id)) {
        continue;
      }

      const date = new Date(timestamp);

      if (Number.isNaN(date.getTime()) || date < startDate || date > endDate) {
        continue;
      }

      const usage = createUsage(message.tokens);

      if (usage.total <= 0) {
        continue;
      }

      if (message.id) {
        dedupe.add(message.id);
      }

      messages.push({ model: normalizeModelName(model), usage });
    }
  }

  return messages;
}

export async function estimateGoogleCosts({
  mode,
  startDate,
  endDate,
}: {
  mode: PricingMode;
  startDate: Date;
  endDate: Date;
}): Promise<ProviderPricingSummary | null> {
  if (mode !== "standard" && mode !== "batch") {
    return null;
  }

  const messages = await collectGeminiMessages(startDate, endDate);
  const aggregatedModels = aggregateMessages(messages);

  if (aggregatedModels.length === 0) {
    return null;
  }

  const pricingIndex = await fetchPricingIndex(
    mode,
    aggregatedModels.map((aggregate) => aggregate.model),
  );
  const models: PricedModelCost[] = [];
  const unresolvedModels: UnresolvedModelCost[] = [];
  const notes = new Set<string>([
    "The API estimate is fetched live from the official Google Gemini pricing docs and applied per message.",
    "For tiered Gemini models, the estimate uses the actual per-message prompt size bucket (<=200k or >200k input tokens).",
    "Cached input tokens are treated as a subset of input tokens, so only uncached input is billed at the full input rate.",
  ]);

  for (const aggregate of aggregatedModels) {
    const pricing = pricingIndex.rows.get(aggregate.model);

    if (!pricing) {
      unresolvedModels.push(
        createUnresolvedModel(
          aggregate,
          "No current matching Google Gemini pricing row was found for this model.",
        ),
      );
      continue;
    }

    models.push(createPricedModel(aggregate, pricing));
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
      "Unpriced Gemini models are excluded from the API total until Google publishes a current official rate for them.",
    );
  }

  return {
    vendor: "google",
    source: pricingIndex.source,
    models,
    unresolvedModels,
    totals,
    notes: [...notes],
  };
}
