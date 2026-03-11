# slopmeter

`slopmeter` is a Node.js CLI that scans local Claude Code, Codex, and Open Code usage data and generates a contribution-style heatmap for the rolling past year.

## Requirements

- Node.js `>=22`

## Run with npm

Use it without installing:

```bash
npx slopmeter
```

Install it globally:

```bash
npm install -g slopmeter
slopmeter
```

## Usage

```bash
slopmeter [--claude] [--codex] [--opencode] [--dark] [--format png|svg|json] [--output ./heatmap-last-year.png]
```

By default, the CLI:

- scans all supported providers
- writes `./heatmap-last-year.png`
- infers the date window as the rolling last year ending today

## Options

- `--claude`: include only Claude Code data
- `--codex`: include only Codex data
- `--opencode`: include only Open Code data
- `--dark`: render the image with the dark theme
- `-f, --format <png|svg|json>`: choose the output format
- `-o, --output <path>`: write output to a custom path
- `-h, --help`: print the help text

## Examples

Generate the default PNG:

```bash
npx slopmeter
```

Write an SVG:

```bash
npx slopmeter --format svg --output ./out/heatmap.svg
```

Write JSON for custom rendering:

```bash
npx slopmeter --format json --output ./out/heatmap.json
```

Render only Codex usage:

```bash
npx slopmeter --codex
```

When provider flags are present, `slopmeter` only loads those providers and only prints availability for those providers.

Render a dark-theme SVG:

```bash
npx slopmeter --dark --format svg --output ./out/heatmap-dark.svg
```

## Output behavior

- If `--format` is omitted, the format is inferred from the `--output` extension when possible.
- Supported extensions are `.png`, `.svg`, and `.json`.
- If neither `--format` nor a recognized output extension is provided, PNG is used.

## Data locations

- Claude Code: `$CLAUDE_CONFIG_DIR/*/projects` or `~/.config/claude/projects`, `~/.claude/projects`
- Codex: `$CODEX_HOME/sessions` or `~/.codex/sessions`
- Open Code: prefers `$OPENCODE_DATA_DIR/opencode.db` or `~/.local/share/opencode/opencode.db`, and falls back to `$OPENCODE_DATA_DIR/storage/message` or `~/.local/share/opencode/storage/message`

## Exit behavior

- If no provider flags are passed, `slopmeter` renders every provider with available data.
- If provider flags are passed and a requested provider has no data, the command exits with an error.
- If no provider has data, the command exits with an error.

## Environment variables

- `SLOPMETER_FILE_PROCESS_CONCURRENCY`: positive integer file-processing limit for Claude Code and Codex JSONL files. Default: `4`.
- `SLOPMETER_MAX_JSONL_RECORD_BYTES`: byte cap for Claude Code and Codex JSONL records, OpenCode JSON documents, and OpenCode SQLite `message.data` payloads. Default: `67108864` (`64 MB`).

## JSONL record handling

- Claude Code and Codex JSONL files are streamed through the same bounded record splitter; `slopmeter` does not materialize whole files in memory.
- Oversized Claude Code JSONL records fail the file with a clear error that names the file, line number, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.
- OpenCode prefers the current SQLite store (`opencode.db`) and falls back to the legacy file-backed message layout.
- OpenCode legacy JSON message files are read through a bounded JSON document reader before `JSON.parse`.
- OpenCode SQLite `message.data` payloads use the same byte cap before `JSON.parse`.
- Oversized OpenCode JSON documents and SQLite message payloads fail clearly with the source path or row label, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.
- Only Codex `turn_context` and `event_msg` `token_count` records are parsed for usage aggregation.
- Oversized irrelevant Codex records are skipped and reported in a warning summary.
- Oversized relevant Codex records fail the file with a clear error that names the file, line number, byte cap, and `SLOPMETER_MAX_JSONL_RECORD_BYTES`.

## License

MIT
