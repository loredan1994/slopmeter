import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { UsageSummary } from "../interfaces";
import {
  type DailyTotalsByDate,
  type DailyTokenTotals,
  type ModelTokenTotals,
  addDailyTokenTotals,
  addModelTokenTotals,
  createUsageSummary,
  getRecentWindowStart,
  listFilesRecursive,
  normalizeModelName,
} from "./utils";

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

function createGeminiTokenTotals(tokens: GeminiTokens): DailyTokenTotals {
  const input = Math.max(tokens.input ?? 0, 0);
  const cachedInput = Math.min(Math.max(tokens.cached ?? 0, 0), input);
  const rawTotal = Math.max(tokens.total ?? 0, 0);
  const computedOutput =
    Math.max(tokens.output ?? 0, 0) +
    Math.max(tokens.thoughts ?? 0, 0) +
    Math.max(tokens.tool ?? 0, 0);

  // Gemini exposes thoughts separately, but the provider-level report only has
  // input/output/cache buckets. Treat everything beyond prompt-side tokens as
  // output-side usage so input + output stays aligned with total.
  const output = rawTotal > 0 ? Math.max(rawTotal - input, 0) : computedOutput;
  const total = rawTotal > 0 ? rawTotal : input + output;

  return {
    input,
    output,
    cache: { input: cachedInput, output: 0 },
    total,
  };
}

async function readGeminiSession(filePath: string) {
  try {
    const content = await readFile(filePath, "utf8");

    return JSON.parse(content) as GeminiSession;
  } catch {
    return null;
  }
}

export async function loadGeminiRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const baseDir = getGeminiBaseDir();
  const sessionsDir = join(baseDir, "tmp");
  const files = (await listFilesRecursive(sessionsDir, ".json")).filter(
    isGeminiSessionFile,
  );
  const totals: DailyTotalsByDate = new Map();
  const dedupe = new Set<string>();
  const recentStart = getRecentWindowStart(end, 30);
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();

  for (const file of files) {
    const session = await readGeminiSession(file);

    if (!session?.messages) {
      continue;
    }

    for (const message of session.messages) {
      const timestamp = message.timestamp?.trim();

      if (!timestamp || !message.tokens) {
        continue;
      }

      if (message.id && dedupe.has(message.id)) {
        continue;
      }

      const date = new Date(timestamp);

      if (Number.isNaN(date.getTime()) || date < start || date > end) {
        continue;
      }

      const tokenTotals = createGeminiTokenTotals(message.tokens);

      if (tokenTotals.total <= 0) {
        continue;
      }

      if (message.id) {
        dedupe.add(message.id);
      }

      const modelName = message.model?.trim()
        ? normalizeModelName(message.model.trim())
        : undefined;

      addDailyTokenTotals(totals, date, tokenTotals, modelName);

      if (!modelName) {
        continue;
      }

      addModelTokenTotals(modelTotals, modelName, tokenTotals);

      if (date >= recentStart) {
        addModelTokenTotals(recentModelTotals, modelName, tokenTotals);
      }
    }
  }

  return createUsageSummary(
    "gemini",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );
}
