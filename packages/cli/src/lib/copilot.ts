import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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

interface CopilotSessionEvent {
  type?: string;
  timestamp?: string;
  data?: {
    newModel?: string;
  };
}

function getCopilotBaseDir() {
  const envPath = process.env.COPILOT_HOME?.trim();

  return envPath ? resolve(envPath) : join(homedir(), ".copilot");
}

function createCountTotals(count = 1): DailyTokenTotals {
  return {
    input: 0,
    output: 0,
    cache: { input: 0, output: 0 },
    total: count,
  };
}

async function countSuccessfulRequests(
  logFiles: string[],
  start: Date,
  end: Date,
): Promise<number> {
  let total = 0;

  for (const file of logFiles) {
    let content: string;

    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      if (
        !line.includes("post https://api.individual.githubcopilot.com/chat/completions succeeded with status 200")
      ) {
        continue;
      }

      const timestamp = line.slice(0, 24);
      const date = new Date(timestamp);

      if (Number.isNaN(date.getTime()) || date < start || date > end) {
        continue;
      }

      total += 1;
    }
  }

  return total;
}

async function readSessionEvents(filePath: string) {
  try {
    const content = await readFile(filePath, "utf8");

    return content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as CopilotSessionEvent);
  } catch {
    return [] as CopilotSessionEvent[];
  }
}

export async function loadCopilotRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const baseDir = getCopilotBaseDir();
  const sessionFiles = (await listFilesRecursive(join(baseDir, "session-state"), ".jsonl"))
    .filter((filePath) => basename(filePath).endsWith(".jsonl"));
  const logFiles = await listFilesRecursive(join(baseDir, "logs"), ".log");
  const totals: DailyTotalsByDate = new Map();
  const recentStart = getRecentWindowStart(end, 30);
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  let totalTurns = 0;

  for (const file of sessionFiles) {
    const events = await readSessionEvents(file);
    let currentModel: string | undefined;

    for (const event of events) {
      const timestamp = event.timestamp?.trim();

      if (event.type === "session.model_change" && event.data?.newModel?.trim()) {
        currentModel = normalizeModelName(event.data.newModel.trim());
        continue;
      }

      if (event.type !== "assistant.turn_start" || !timestamp) {
        continue;
      }

      const date = new Date(timestamp);

      if (Number.isNaN(date.getTime()) || date < start || date > end) {
        continue;
      }

      const countTotals = createCountTotals();

      totalTurns += 1;
      addDailyTokenTotals(totals, date, countTotals, currentModel);

      if (!currentModel) {
        continue;
      }

      addModelTokenTotals(modelTotals, currentModel, countTotals);

      if (date >= recentStart) {
        addModelTokenTotals(recentModelTotals, currentModel, countTotals);
      }
    }
  }

  const summary = createUsageSummary(
    "copilot",
    totals,
    modelTotals,
    recentModelTotals,
    end,
    {
      usageUnit: "count",
      unitLabel: "turns",
      entityLabel: "model",
      headerMetrics: [
        { label: "Turns", value: totalTurns, format: "count" },
        {
          label: "API requests",
          value: await countSuccessfulRequests(logFiles, start, end),
          format: "count",
        },
        { label: "Active days", value: totals.size, format: "count" },
        { label: "Models", value: modelTotals.size, format: "count" },
      ],
      leaderboardTitle: "Top models by turns",
      noBreakdownMessage: "No model activity available",
    },
  );

  return summary;
}
