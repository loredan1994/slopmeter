import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
} from "./utils";

interface TaskMetadata {
  updatedAt?: string;
}

interface RecordingMetadata {
  highlights?: Array<{
    start_time?: string;
  }>;
}

function getAntigravityBaseDir() {
  const envPath = process.env.ANTIGRAVITY_HOME?.trim();

  return envPath ? resolve(envPath) : join(homedir(), ".gemini", "antigravity");
}

function createCountTotals(count = 1): DailyTokenTotals {
  return {
    input: 0,
    output: 0,
    cache: { input: 0, output: 0 },
    total: count,
  };
}

async function readJson<T>(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function loadAntigravityRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const baseDir = getAntigravityBaseDir();
  const brainDir = join(baseDir, "brain");
  const recordingsDir = join(baseDir, "browser_recordings");
  const taskMetadataFiles = (await listFilesRecursive(brainDir, ".json")).filter(
    (filePath) => filePath.endsWith("task.md.metadata.json"),
  );
  const recordingMetadataFiles = (await listFilesRecursive(recordingsDir, ".json")).filter(
    (filePath) => filePath.endsWith("metadata.json"),
  );
  const totals: DailyTotalsByDate = new Map();
  const recentStart = getRecentWindowStart(end, 30);
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  let totalTasks = 0;
  let totalRecordings = 0;
  let totalHighlights = 0;

  for (const file of taskMetadataFiles) {
    const metadata = await readJson<TaskMetadata>(file);
    const timestamp = metadata?.updatedAt?.trim();

    if (!timestamp) {
      continue;
    }

    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime()) || date < start || date > end) {
      continue;
    }

    const countTotals = createCountTotals();

    totalTasks += 1;
    addDailyTokenTotals(totals, date, countTotals, "Task sessions");
    addModelTokenTotals(modelTotals, "Task sessions", countTotals);

    if (date >= recentStart) {
      addModelTokenTotals(recentModelTotals, "Task sessions", countTotals);
    }
  }

  for (const file of recordingMetadataFiles) {
    const metadata = await readJson<RecordingMetadata>(file);
    const firstHighlight = metadata?.highlights?.find((highlight) =>
      Boolean(highlight.start_time?.trim()),
    );
    const timestamp = firstHighlight?.start_time?.trim();

    if (!timestamp) {
      continue;
    }

    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime()) || date < start || date > end) {
      continue;
    }

    const recordingTotals = createCountTotals();
    const highlightTotals = createCountTotals(metadata?.highlights?.length ?? 0);

    totalRecordings += 1;
    totalHighlights += highlightTotals.total;

    addDailyTokenTotals(totals, date, recordingTotals, "Browser recordings");
    addModelTokenTotals(modelTotals, "Browser recordings", recordingTotals);

    if (date >= recentStart) {
      addModelTokenTotals(recentModelTotals, "Browser recordings", recordingTotals);
    }

    if (highlightTotals.total <= 0) {
      continue;
    }

    addDailyTokenTotals(totals, date, highlightTotals, "Recording highlights");
    addModelTokenTotals(modelTotals, "Recording highlights", highlightTotals);

    if (date >= recentStart) {
      addModelTokenTotals(
        recentModelTotals,
        "Recording highlights",
        highlightTotals,
      );
    }
  }

  const summary = createUsageSummary(
    "antigravity",
    totals,
    modelTotals,
    recentModelTotals,
    end,
    {
      usageUnit: "count",
      unitLabel: "activities",
      entityLabel: "activity type",
      headerMetrics: [
        { label: "Task sessions", value: totalTasks, format: "count" },
        { label: "Recordings", value: totalRecordings, format: "count" },
        { label: "Highlights", value: totalHighlights, format: "count" },
        { label: "Active days", value: totals.size, format: "count" },
      ],
      leaderboardTitle: "Top activity types",
      noBreakdownMessage: "No activity details available",
    },
  );

  return summary;
}
