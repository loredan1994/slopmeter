import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const cliPath = resolve(import.meta.dirname, "../dist/cli.js");
const cliRuntime = process.release.name === "node"
  ? process.execPath
  : "node";

function createTempWorkspace(label: string) {
  return mkdtempSync(join(tmpdir(), `slopmeter-${label}-`));
}

function recentIso(daysAgo = 0) {
  const date = new Date();

  date.setUTCDate(date.getUTCDate() - daysAgo);

  return date.toISOString();
}

function ensureParent(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function writeJsonlFile(path: string, records: string[]) {
  ensureParent(path);
  writeFileSync(path, `${records.join("\n")}\n`, "utf8");
}

function writeJsonFile(path: string, value: string) {
  ensureParent(path);
  writeFileSync(path, value, "utf8");
}

function codexTurnContext(model = "gpt-5") {
  return JSON.stringify({
    type: "turn_context",
    timestamp: recentIso(),
    payload: { model },
  });
}

function codexTokenCount(options: {
  model?: string;
  timestamp?: string;
  input?: number;
  output?: number;
  total?: number;
  padding?: string;
}) {
  const {
    model = "gpt-5",
    timestamp = recentIso(),
    input = 10,
    output = 5,
    total = input + output,
    padding,
  } = options;

  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      model,
      padding,
      info: {
        last_token_usage: {
          input_tokens: input,
          output_tokens: output,
          total_tokens: total,
        },
      },
    },
  });
}

function codexOversizedIrrelevantRecord(size: number) {
  return JSON.stringify({
    type: "response_item",
    timestamp: recentIso(),
    payload: {
      type: "function_call_output",
      output: "x".repeat(size),
    },
  });
}

function claudeEntry(options: {
  timestamp?: string;
  messageId: string;
  requestId: string;
  model?: string;
  input?: number;
  output?: number;
}) {
  const {
    timestamp = recentIso(),
    messageId,
    requestId,
    model = "claude-3-5-sonnet-20241022",
    input = 6,
    output = 4,
  } = options;

  return JSON.stringify({
    timestamp,
    requestId,
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
      },
    },
  });
}

function openCodeMessage(options: {
  id?: string;
  role?: string;
  modelID?: string;
  created?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}) {
  const {
    id = "msg-1",
    role = "assistant",
    modelID = "gpt-5.4",
    created = Date.now(),
    input = 6,
    output = 4,
    cacheRead = 0,
    cacheWrite = 0,
  } = options;

  return JSON.stringify({
    id,
    role,
    modelID,
    providerID: "openai",
    time: { created, completed: created + 1_000 },
    tokens: {
      total: input + output + cacheRead + cacheWrite,
      input,
      output,
      reasoning: 0,
      cache: {
        read: cacheRead,
        write: cacheWrite,
      },
    },
  });
}

async function createOpenCodeDb(
  rootDir: string,
  rows: Array<{ id: string; created?: number; data: string }>,
) {
  const { DatabaseSync } = await import("node:sqlite");
  const databasePath = join(rootDir, "opencode.db");

  ensureParent(databasePath);

  const database = new DatabaseSync(databasePath);

  try {
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);

    const insert = database.prepare(`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      const created = row.created ?? Date.now();

      insert.run(row.id, "ses-1", created, created, row.data);
    }
  } finally {
    database.close();
  }
}

async function runCli(
  args: string[],
  extraEnv: Record<string, string>,
) {
  return await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolveRun, reject) => {
    const child = spawn(cliRuntime, [cliPath, ...args], {
      env: {
        ...process.env,
        ...extraEnv,
        FORCE_COLOR: "0",
        NODE_NO_WARNINGS: "1",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

test("--codex only loads Codex and only reports Codex availability", async (t) => {
  const workspace = createTempWorkspace("codex-only");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const codexHome = join(workspace, "codex");
  const claudeConfig = join(workspace, "claude");
  const openCodeDir = join(workspace, "opencode");
  const outputPath = join(workspace, "out.json");
  const unreadableClaudeFile = join(claudeConfig, "projects", "bad.jsonl");

  writeJsonlFile(join(codexHome, "sessions", "session.jsonl"), [
    codexTurnContext(),
    codexTokenCount({ input: 12, output: 8, total: 20 }),
  ]);
  writeJsonlFile(unreadableClaudeFile, ['{"broken":true}']);
  chmodSync(unreadableClaudeFile, 0o000);
  writeJsonFile(
    join(openCodeDir, "storage", "message", "bad.json"),
    "{ this is not valid json",
  );

  const result = await runCli(
    ["--codex", "--format", "json", "--output", outputPath],
    {
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeConfig,
      OPENCODE_DATA_DIR: openCodeDir,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Codex found/);
  assert.doesNotMatch(result.stdout, /Claude code/);
  assert.doesNotMatch(result.stdout, /Open Code/);

  const payload = JSON.parse(readFileSync(outputPath, "utf8")) as {
    providers: Array<{ provider: string; daily: Array<{ total: number }> }>;
  };

  assert.deepEqual(
    payload.providers.map((provider) => provider.provider),
    ["codex"],
  );
  assert.equal(payload.providers[0]?.daily[0]?.total, 20);
});

test("Codex skips oversized irrelevant records and still counts token usage", async (t) => {
  const workspace = createTempWorkspace("codex-oversized-irrelevant");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const codexHome = join(workspace, "codex");
  const outputPath = join(workspace, "out.json");

  writeJsonlFile(join(codexHome, "sessions", "session.jsonl"), [
    codexTurnContext(),
    codexOversizedIrrelevantRecord(1024),
    codexTokenCount({ input: 9, output: 6, total: 15 }),
  ]);

  const result = await runCli(
    ["--codex", "--format", "json", "--output", outputPath],
    {
      CODEX_HOME: codexHome,
      SLOPMETER_MAX_JSONL_RECORD_BYTES: "256",
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /Skipped 1 oversized irrelevant Codex record\(s\)/,
  );

  const payload = JSON.parse(readFileSync(outputPath, "utf8")) as {
    providers: Array<{ provider: string; daily: Array<{ total: number }> }>;
  };

  assert.equal(payload.providers[0]?.daily[0]?.total, 15);
});

test("Codex fails clearly on oversized relevant records", async (t) => {
  const workspace = createTempWorkspace("codex-oversized-relevant");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const codexHome = join(workspace, "codex");
  const oversizedFile = join(codexHome, "sessions", "session.jsonl");

  writeJsonlFile(oversizedFile, [
    codexTurnContext(),
    codexTokenCount({
      input: 11,
      output: 7,
      total: 18,
      padding: "x".repeat(1024),
    }),
  ]);

  const result = await runCli(
    ["--codex", "--format", "json", "--output", join(workspace, "out.json")],
    {
      CODEX_HOME: codexHome,
      SLOPMETER_MAX_JSONL_RECORD_BYTES: "256",
    },
  );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Relevant Codex record exceeds 256 bytes/);
  assert.match(result.stderr, new RegExp(oversizedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stderr, /SLOPMETER_MAX_JSONL_RECORD_BYTES/);
});

test("Claude JSONL streaming preserves usage results across multiple files", async (t) => {
  const workspace = createTempWorkspace("claude-streaming");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const claudeConfig = join(workspace, "claude");
  const outputPath = join(workspace, "out.json");

  writeJsonlFile(join(claudeConfig, "projects", "one.jsonl"), [
    claudeEntry({ messageId: "m-1", requestId: "r-1", input: 4, output: 6 }),
    "{ malformed json",
    claudeEntry({ messageId: "m-2", requestId: "r-2", input: 3, output: 2 }),
  ]);
  writeJsonlFile(join(claudeConfig, "projects", "two.jsonl"), [
    claudeEntry({ messageId: "m-1", requestId: "r-1", input: 4, output: 6 }),
    claudeEntry({ messageId: "m-3", requestId: "r-3", input: 5, output: 5 }),
  ]);

  const result = await runCli(
    ["--claude", "--format", "json", "--output", outputPath],
    {
      CLAUDE_CONFIG_DIR: claudeConfig,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);

  const payload = JSON.parse(readFileSync(outputPath, "utf8")) as {
    providers: Array<{ provider: string; daily: Array<{ total: number }> }>;
  };

  assert.deepEqual(
    payload.providers.map((provider) => provider.provider),
    ["claude"],
  );
  assert.equal(payload.providers[0]?.daily[0]?.total, 25);
});

test("Claude fails clearly on oversized JSONL records via the shared splitter", async (t) => {
  const workspace = createTempWorkspace("claude-oversized");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const claudeConfig = join(workspace, "claude");
  const oversizedFile = join(claudeConfig, "projects", "oversized.jsonl");

  writeJsonlFile(oversizedFile, [
    claudeEntry({
      messageId: "m-1",
      requestId: "r-1",
      input: 3,
      output: 2,
    }),
    JSON.stringify({
      timestamp: recentIso(),
      requestId: "r-2",
      message: {
        id: "m-2",
        model: "claude-3-5-sonnet-20241022",
        usage: {
          input_tokens: 4,
          output_tokens: 1,
        },
        padding: "x".repeat(1024),
      },
    }),
  ]);

  const result = await runCli(
    ["--claude", "--format", "json", "--output", join(workspace, "out.json")],
    {
      CLAUDE_CONFIG_DIR: claudeConfig,
      SLOPMETER_MAX_JSONL_RECORD_BYTES: "256",
    },
  );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /JSONL record exceeds 256 bytes/);
  assert.match(
    result.stderr,
    new RegExp(oversizedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(result.stderr, /SLOPMETER_MAX_JSONL_RECORD_BYTES/);
});

test("OpenCode reads the legacy file-backed message layout", async (t) => {
  const workspace = createTempWorkspace("opencode-files");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const openCodeDir = join(workspace, "opencode");
  const outputPath = join(workspace, "out.json");

  writeJsonFile(
    join(openCodeDir, "storage", "message", "one.json"),
    openCodeMessage({
      id: "msg-1",
      input: 8,
      output: 5,
      cacheRead: 2,
    }),
  );

  const result = await runCli(
    ["--opencode", "--format", "json", "--output", outputPath],
    {
      OPENCODE_DATA_DIR: openCodeDir,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Open Code found/);

  const payload = JSON.parse(readFileSync(outputPath, "utf8")) as {
    providers: Array<{ provider: string; daily: Array<{ total: number }> }>;
  };

  assert.deepEqual(
    payload.providers.map((provider) => provider.provider),
    ["opencode"],
  );
  assert.equal(payload.providers[0]?.daily[0]?.total, 15);
});

test("OpenCode prefers the SQLite message store when opencode.db exists", async (t) => {
  const workspace = createTempWorkspace("opencode-db");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const openCodeDir = join(workspace, "opencode");
  const outputPath = join(workspace, "out.json");

  await createOpenCodeDb(openCodeDir, [
    {
      id: "msg-db-1",
      data: openCodeMessage({
        id: "msg-db-1",
        modelID: "gpt-5.4",
        input: 8,
        output: 5,
        cacheRead: 2,
      }),
    },
  ]);
  writeJsonFile(
    join(openCodeDir, "storage", "message", "bad.json"),
    "{ this is not valid json",
  );

  const result = await runCli(
    ["--opencode", "--format", "json", "--output", outputPath],
    {
      OPENCODE_DATA_DIR: openCodeDir,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Open Code found/);

  const payload = JSON.parse(readFileSync(outputPath, "utf8")) as {
    providers: Array<{ provider: string; daily: Array<{ total: number }> }>;
  };

  assert.deepEqual(
    payload.providers.map((provider) => provider.provider),
    ["opencode"],
  );
  assert.equal(payload.providers[0]?.daily[0]?.total, 15);
});

test("OpenCode fails clearly on oversized JSON documents", async (t) => {
  const workspace = createTempWorkspace("opencode-oversized");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const openCodeDir = join(workspace, "opencode");
  const oversizedFile = join(
    openCodeDir,
    "storage",
    "message",
    "oversized.json",
  );

  writeJsonFile(
    oversizedFile,
    `${openCodeMessage({
      input: 1,
      output: 1,
    }).slice(0, -1)},"padding":"${"x".repeat(1024)}"}`,
  );

  const result = await runCli(
    ["--opencode", "--format", "json", "--output", join(workspace, "out.json")],
    {
      OPENCODE_DATA_DIR: openCodeDir,
      SLOPMETER_MAX_JSONL_RECORD_BYTES: "256",
    },
  );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /JSON document exceeds 256 bytes/);
  assert.match(
    result.stderr,
    new RegExp(oversizedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(result.stderr, /SLOPMETER_MAX_JSONL_RECORD_BYTES/);
});

test("OpenCode fails clearly on oversized SQLite message payloads", async (t) => {
  const workspace = createTempWorkspace("opencode-db-oversized");

  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const openCodeDir = join(workspace, "opencode");

  await createOpenCodeDb(openCodeDir, [
    {
      id: "msg-db-oversized",
      data: `${openCodeMessage({
        id: "msg-db-oversized",
        input: 1,
        output: 1,
      }).slice(0, -1)},"padding":"${"x".repeat(1024)}"}`,
    },
  ]);

  const result = await runCli(
    ["--opencode", "--format", "json", "--output", join(workspace, "out.json")],
    {
      OPENCODE_DATA_DIR: openCodeDir,
      SLOPMETER_MAX_JSONL_RECORD_BYTES: "256",
      NODE_NO_WARNINGS: "1",
    },
  );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /JSON payload exceeds 256 bytes/);
  assert.match(result.stderr, /opencode\.db:message:msg-db-oversized/);
  assert.match(result.stderr, /SLOPMETER_MAX_JSONL_RECORD_BYTES/);
});
