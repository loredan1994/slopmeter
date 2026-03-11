import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import ora, { type Ora } from "ora";
import ow from "ow";
import sharp from "sharp";
import { heatmapThemes, renderUsageHeatmapsSvg, type ColorMode } from "./graph";
import type {
  JsonExportPayload,
  PricingMode,
  JsonUsageSummary,
  UsageSummary,
} from "./interfaces";
import { estimateProviderCosts } from "./lib/pricing";
import type { ProviderId } from "./providers";
import { formatLocalDate } from "./lib/utils";
import { aggregateUsage, providerIds, providerStatusLabel } from "./providers";

type OutputFormat = "png" | "svg" | "json";
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

interface CliArgValues {
  output?: string;
  format?: string;
  pricingMode?: string;
  subscriptionPrice?: string;
  since?: string;
  until?: string;
  help: boolean;
  dark: boolean;
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  copilot: boolean;
  antigravity: boolean;
  opencode: boolean;
  officialPricing: boolean;
  openaiPricing: boolean;
}

const PNG_BASE_WIDTH = 1000;
const PNG_SCALE = 4;
const PNG_RENDER_WIDTH = PNG_BASE_WIDTH * PNG_SCALE;
const JSON_EXPORT_VERSION = "2026-03-11";

const HELP_TEXT = `slopmeter

Generate usage heatmap image(s), optionally limited to a custom date window.

Usage:
  slopmeter [--claude] [--codex] [--gemini] [--copilot] [--antigravity] [--opencode] [--dark] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--format png|svg|json] [--output ./heatmap.png] [--official-pricing]

Options:
  --claude                    Render Claude Code graph
  --codex                     Render Codex graph
  --gemini                    Render Gemini CLI graph
  --copilot                   Render GitHub Copilot graph
  --antigravity               Render Antigravity graph
  --opencode                  Render Open Code graph
  --dark                      Render with the dark theme
  --since                     Start date in YYYY-MM-DD (default: 1 year before end date)
  --until                     End date in YYYY-MM-DD (default: today)
  --official-pricing          Fetch official vendor pricing where supported (OpenAI for Codex, Google for Gemini)
  --openai-pricing            Legacy alias for --official-pricing
  --pricing-mode              Pricing mode: standard, batch, flex, or priority (default: standard)
  --subscription-price        Monthly subscription reference price in USD (default: 200, used for OpenAI subscription comparisons)
  -f, --format                Output format: png, svg, or json (default: png)
  -o, --output                Output file path (default: ./heatmap-last-year.png)
  -h, --help                  Show this help
`;

function printHelp() {
  process.stdout.write(HELP_TEXT);
}

function validateArgs(values: unknown): asserts values is CliArgValues {
  ow(
    values,
    ow.object.exactShape({
      output: ow.optional.string.nonEmpty,
      format: ow.optional.string.nonEmpty,
      pricingMode: ow.optional.string.nonEmpty,
      subscriptionPrice: ow.optional.string.nonEmpty,
      since: ow.optional.string.nonEmpty,
      until: ow.optional.string.nonEmpty,
      help: ow.boolean,
      dark: ow.boolean,
      claude: ow.boolean,
      codex: ow.boolean,
      gemini: ow.boolean,
      copilot: ow.boolean,
      antigravity: ow.boolean,
      opencode: ow.boolean,
      officialPricing: ow.boolean,
      openaiPricing: ow.boolean,
    }),
  );
}

function inferFormat(
  formatArg: string | undefined,
  outputArg: string | undefined,
) {
  if (formatArg) {
    ow(formatArg, ow.string.oneOf(["png", "svg", "json"] as const));

    return formatArg;
  }

  if (outputArg) {
    const outputExtension = extname(outputArg).toLowerCase();

    if (outputExtension === ".svg") {
      return "svg" as const;
    }

    if (outputExtension === ".json") {
      return "json" as const;
    }
  }

  return "png" as const;
}

async function writeOutputImage(
  outputPath: string,
  format: Exclude<OutputFormat, "json">,
  svg: string,
  background: string,
) {
  if (format === "svg") {
    writeFileSync(outputPath, svg, "utf8");

    return;
  }

  const pngBuffer = await sharp(Buffer.from(svg), { density: 192 })
    .resize({ width: PNG_RENDER_WIDTH })
    .flatten({ background })
    .png()
    .toBuffer();

  writeFileSync(outputPath, pngBuffer);
}

function writeOutputJson(outputPath: string, payload: JsonExportPayload) {
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function toJsonUsageSummary(summary: UsageSummary): JsonUsageSummary {
  return {
    provider: summary.provider,
    insights: summary.insights,
    pricing: summary.pricing,
    presentation: summary.presentation,
    daily: summary.daily.map((row) => ({
      date: formatLocalDate(row.date),
      input: row.input,
      output: row.output,
      cache: row.cache,
      total: row.total,
      breakdown: row.breakdown,
    })),
  };
}

function parseDateArg(
  value: string | undefined,
  boundary: "start" | "end",
): Date | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw new Error(
      `${boundary === "start" ? "--since" : "--until"} must be in YYYY-MM-DD format.`,
    );
  }

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(
      `${boundary === "start" ? "--since" : "--until"} must be a valid calendar date.`,
    );
  }

  if (boundary === "start") {
    date.setHours(0, 0, 0, 0);
  } else {
    date.setHours(23, 59, 59, 999);
  }

  return date;
}

function getDateWindow({
  since,
  until,
}: {
  since?: string;
  until?: string;
}) {
  const end = parseDateArg(until, "end") ?? new Date();

  if (!until) {
    end.setHours(23, 59, 59, 999);
  }

  const start = parseDateArg(since, "start") ?? new Date(end);

  if (!since) {
    start.setFullYear(start.getFullYear() - 1);
    start.setHours(0, 0, 0, 0);
  }

  if (start > end) {
    throw new Error("--since must be on or before --until.");
  }

  return { start, end };
}

function printProviderAvailability(
  rowsByProvider: Record<ProviderId, UsageSummary | null>,
) {
  for (const provider of providerIds) {
    const found = rowsByProvider[provider] ? "found" : "not found";

    process.stdout.write(`${providerStatusLabel[provider]} ${found}\n`);
  }
}

function getRequestedProviders(values: CliArgValues) {
  return providerIds.filter((id) => values[id]);
}

function selectProvidersToRender(
  rowsByProvider: Record<ProviderId, UsageSummary | null>,
  requested: ProviderId[],
) {
  const providersToRender =
    requested.length > 0
      ? requested.filter((provider) => rowsByProvider[provider])
      : providerIds.filter((provider) => rowsByProvider[provider]);

  if (requested.length > 0 && providersToRender.length < requested.length) {
    const missing = requested.filter((provider) => !rowsByProvider[provider]);

    throw new Error(
      `Requested provider data not found: ${missing.map((provider) => providerStatusLabel[provider]).join(", ")}`,
    );
  }

  if (providersToRender.length === 0) {
    throw new Error(
      `No usage data found for ${providerIds.map((provider) => providerStatusLabel[provider]).join(", ")}.`,
    );
  }

  return providersToRender.map((provider) => rowsByProvider[provider]!);
}

function inferPricingMode(value: string | undefined): PricingMode {
  const normalized = value ?? "standard";

  ow(normalized, ow.string.oneOf(["batch", "flex", "standard", "priority"]));

  return normalized as PricingMode;
}

function parseSubscriptionPrice(value: string | undefined) {
  const parsed = Number(value ?? "200");

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Subscription price must be a positive number.");
  }

  return parsed;
}

function formatCompactNumber(value: number) {
  return compactFormatter.format(value);
}

function formatUsd(value: number) {
  return currencyFormatter.format(value);
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 3, 1))}...`;
}

function printPricingReport(
  providers: UsageSummary[],
) {
  const pricedProviders = providers.filter((provider) => provider.pricing);

  if (pricedProviders.length === 0) {
    return;
  }

  const combined = pricedProviders.reduce(
    (accumulator, provider) => {
      const pricing = provider.pricing!;

      accumulator.apiCost += pricing.totals.estimatedCost.total;
      accumulator.subscriptionCost +=
        pricing.subscriptionComparison?.totalSubscriptionCost ?? 0;
      accumulator.notes.push(...pricing.notes);
      accumulator.hasSubscriptionComparison ||= Boolean(pricing.subscriptionComparison);

      return accumulator;
    },
    {
      apiCost: 0,
      subscriptionCost: 0,
      hasSubscriptionComparison: false,
      notes: [] as string[],
    },
  );

  process.stdout.write("\nOfficial API pricing summary\n");

  for (const provider of pricedProviders) {
    const pricing = provider.pricing!;
    const columns = {
      model: 28,
      input: 10,
      cached: 10,
      output: 10,
      cost: 12,
    };

    process.stdout.write(`\n${heatmapThemes[provider.provider].title}\n`);
    process.stdout.write(
      `Source: ${pricing.source.url} (${pricing.vendor}${pricing.source.mode ? `, ${pricing.source.mode}` : ""}, fetched ${pricing.source.retrievedAt})\n`,
    );
    process.stdout.write(
      `${"Model".padEnd(columns.model)}${"Input".padStart(columns.input)}${"Cached".padStart(columns.cached)}${"Output".padStart(columns.output)}${"API-key est.".padStart(columns.cost)}\n`,
    );

    for (const model of pricing.models) {
      process.stdout.write(
        `${truncate(model.model, columns.model).padEnd(columns.model)}${formatCompactNumber(model.tokens.input).padStart(columns.input)}${formatCompactNumber(model.tokens.cachedInput).padStart(columns.cached)}${formatCompactNumber(model.tokens.output).padStart(columns.output)}${formatUsd(model.estimatedCost.total).padStart(columns.cost)}\n`,
      );
    }

    if (pricing.unresolvedModels.length > 0) {
      process.stdout.write(
        `Unresolved: ${pricing.unresolvedModels.map((model) => model.model).join(", ")}\n`,
      );
    }

    process.stdout.write(
      `Total if billed via API keys: ${formatUsd(pricing.totals.estimatedCost.total)}\n`,
    );

    if (pricing.subscriptionComparison) {
      process.stdout.write(
        `Total if covered by subscription: ${formatUsd(pricing.subscriptionComparison.totalSubscriptionCost)} (${pricing.subscriptionComparison.months} months)\n`,
      );
      if (pricing.subscriptionComparison.cheaperOption === "subscription") {
        process.stdout.write(
          `Subscription savings vs API keys: ${formatUsd(pricing.subscriptionComparison.difference)}\n`,
        );
      } else if (pricing.subscriptionComparison.cheaperOption === "api") {
        process.stdout.write(
          `API-key savings vs subscription: ${formatUsd(Math.abs(pricing.subscriptionComparison.difference))}\n`,
        );
      } else {
        process.stdout.write("No cost difference between the two routes.\n");
      }
    }
  }

  if (pricedProviders.length > 1) {
    const combinedDifference = combined.apiCost - combined.subscriptionCost;
    const cheaperOption =
      combinedDifference > 0
        ? "subscription"
        : combinedDifference < 0
          ? "api"
          : "equal";

    process.stdout.write("\nCombined total\n");
    process.stdout.write(`Total if billed via API keys: ${formatUsd(combined.apiCost)}\n`);

    if (combined.hasSubscriptionComparison) {
      process.stdout.write(
        `Total if covered by subscription: ${formatUsd(combined.subscriptionCost)}\n`,
      );
      if (cheaperOption === "subscription") {
        process.stdout.write(
          `Subscription savings vs API keys: ${formatUsd(combinedDifference)}\n`,
        );
      } else if (cheaperOption === "api") {
        process.stdout.write(
          `API-key savings vs subscription: ${formatUsd(Math.abs(combinedDifference))}\n`,
        );
      } else {
        process.stdout.write("No cost difference between the two routes.\n");
      }
    }
  }

  const notes = [...new Set(combined.notes)];

  if (notes.length > 0) {
    process.stdout.write("\nNotes\n");

    for (const note of notes) {
      process.stdout.write(`- ${note}\n`);
    }
  }
}

function printRunSummary(
  outputPath: string,
  format: OutputFormat,
  colorMode: ColorMode,
  startDate: Date,
  endDate: Date,
  rendered: ProviderId[],
) {
  process.stdout.write(
    `${JSON.stringify(
      {
        output: outputPath,
        format,
        colorMode,
        startDate: formatLocalDate(startDate),
        endDate: formatLocalDate(endDate),
        rendered,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  let spinner: Ora | undefined;

  const parsed = parseArgs({
    options: {
      output: { type: "string", short: "o" },
      format: { type: "string", short: "f" },
      since: { type: "string" },
      until: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      dark: { type: "boolean", default: false },
      claude: { type: "boolean", default: false },
      codex: { type: "boolean", default: false },
      gemini: { type: "boolean", default: false },
      copilot: { type: "boolean", default: false },
      antigravity: { type: "boolean", default: false },
      opencode: { type: "boolean", default: false },
      "official-pricing": { type: "boolean", default: false },
      "openai-pricing": { type: "boolean", default: false },
      "pricing-mode": { type: "string" },
      "subscription-price": { type: "string" },
    },
    allowPositionals: false,
  });

  const values: CliArgValues = {
    output: parsed.values.output,
    format: parsed.values.format,
    pricingMode: parsed.values["pricing-mode"],
    subscriptionPrice: parsed.values["subscription-price"],
    since: parsed.values.since,
    until: parsed.values.until,
    help: parsed.values.help,
    dark: parsed.values.dark,
    claude: parsed.values.claude,
    codex: parsed.values.codex,
    gemini: parsed.values.gemini,
    copilot: parsed.values.copilot,
    antigravity: parsed.values.antigravity,
    opencode: parsed.values.opencode,
    officialPricing: parsed.values["official-pricing"],
    openaiPricing: parsed.values["openai-pricing"],
  };

  validateArgs(values);

  if (values.help) {
    printHelp();

    return;
  }

  try {
    spinner = ora({
      text: "Analyzing usage data...",
      spinner: "dots",
    }).start();

    const { start, end } = getDateWindow({
      since: values.since,
      until: values.until,
    });
    const colorMode: ColorMode = values.dark ? "dark" : "light";
    const format = inferFormat(values.format, values.output);
    const rowsByProvider = await aggregateUsage({ start, end });

    spinner.stop();
    printProviderAvailability(rowsByProvider);

    const exportProviders = selectProvidersToRender(
      rowsByProvider,
      getRequestedProviders(values),
    );
    const pricingRequested = values.officialPricing || values.openaiPricing;
    const subscriptionPrice = pricingRequested
      ? parseSubscriptionPrice(values.subscriptionPrice)
      : null;

    if (pricingRequested) {
      const pricingMode = inferPricingMode(values.pricingMode);

      spinner.start("Fetching official pricing...");

      for (const provider of exportProviders) {
        const pricing = await estimateProviderCosts({
          summary: provider,
          mode: pricingMode,
          subscriptionPrice,
          startDate: start,
          endDate: end,
        });

        if (pricing && pricing.models.length > 0) {
          provider.pricing = pricing;
        }
      }

      spinner.stop();
    }

    const outputPath = resolve(
      values.output ?? `./heatmap-last-year.${format}`,
    );

    mkdirSync(dirname(outputPath), { recursive: true });

    if (format === "json") {
      spinner.start("Preparing JSON export...");

      const payload: JsonExportPayload = {
        version: JSON_EXPORT_VERSION,
        start: formatLocalDate(start),
        end: formatLocalDate(end),
        providers: exportProviders.map((provider) =>
          toJsonUsageSummary(provider),
        ),
      };

      spinner.text = "Writing output file...";
      writeOutputJson(outputPath, payload);
    } else {
      spinner.start("Rendering heatmaps...");

      const svg = renderUsageHeatmapsSvg({
        startDate: start,
        endDate: end,
        colorMode,
        sections: exportProviders.map(
          ({ provider, daily, insights, pricing, presentation }) => ({
            daily,
            insights,
            pricing,
            presentation,
            title: heatmapThemes[provider].title,
            colors: heatmapThemes[provider].colors,
          }),
        ),
      });
      const background = colorMode === "dark" ? "#171717" : "#ffffff";

      spinner.text = "Writing output file...";
      await writeOutputImage(outputPath, format, svg, background);
    }

    spinner.succeed("Analysis complete");

    if (pricingRequested) {
      printPricingReport(exportProviders);
    }

    printRunSummary(
      outputPath,
      format,
      colorMode,
      start,
      end,
      exportProviders.map(({ provider }) => provider),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (spinner) {
      spinner.fail(`Failed: ${message}`);
    } else {
      process.stderr.write(`${message}\n`);
    }

    process.exitCode = 1;
  }
}

void main();
