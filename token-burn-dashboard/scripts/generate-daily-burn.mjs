import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const timeZone = process.env.TOKEN_BURN_TIMEZONE || "Europe/Lisbon";
const outputPath = join(process.cwd(), "data", "daily-burn.json");
const existingRows = readExistingRows(outputPath);

const codex = collectCodexUsage(timeZone);
const claude = collectClaudeCodeUsage(timeZone);
const dates = dateRange([...codex.byDate.keys(), ...claude.byDate.keys()], timeZone);

const rows = dates.map((date) => {
  const previous = existingRows.get(date);
  const codexTokens = codex.byDate.get(date) || 0;
  const claudeTokens = claude.byDate.get(date) || 0;
  const claudeCalls = claude.callsByDate.get(date) || 0;
  const claudeChat = previous?.claude_chat_est || 0;
  const chatgpt = previous?.chatgpt_est || 0;
  const driver = previous?.driver || (date === localDate(new Date(), timeZone) ? "shipping" : "unlabeled");
  const evidence =
    previous?.evidence ||
    (codexTokens || claudeTokens
      ? "Exact local agent usage; driver label pending."
      : "No measured exact agent usage.");

  return {
    date,
    codex_tokens: codexTokens,
    claude_code_tokens: claudeTokens,
    claude_code_calls: claudeCalls,
    claude_chat_est: claudeChat,
    chatgpt_est: chatgpt,
    total: codexTokens + claudeTokens + claudeChat + chatgpt,
    driver,
    evidence,
  };
});

writeFileSync(outputPath, `${JSON.stringify(rows, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      output: outputPath,
      timezone: timeZone,
      rows: rows.length,
      codexEvents: codex.events,
      claudeCodeCalls: claude.calls,
      note: "Raw logs were read locally; only normalized daily totals were written.",
    },
    null,
    2,
  ),
);

function collectCodexUsage(zone) {
  const roots = [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), ".codex", "archived_sessions"),
  ];
  const byDate = new Map();
  const seen = new Set();
  let events = 0;

  for (const file of roots.flatMap((root) => jsonlFiles(root))) {
    for (const row of readJsonl(file)) {
      const usage = row?.payload?.info?.last_token_usage;
      const tokens = numberValue(usage?.total_tokens);
      const timestamp = row?.timestamp || row?.ts || row?.time;
      if (!tokens || !timestamp) continue;

      const key = `${timestamp}|${tokens}|${row?.payload?.info?.total_token_usage?.total_tokens || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      add(byDate, localDate(new Date(timestamp), zone), tokens);
      events += 1;
    }
  }

  return { byDate, events };
}

function collectClaudeCodeUsage(zone) {
  const root = join(homedir(), ".claude", "projects");
  const byDate = new Map();
  const callsByDate = new Map();
  const seen = new Set();
  let calls = 0;

  for (const file of jsonlFiles(root)) {
    for (const row of readJsonl(file)) {
      if (row?.type !== "assistant") continue;

      const usage = row?.message?.usage;
      const timestamp = row?.timestamp || row?.createdAt || row?.message?.created_at;
      if (!usage || !timestamp) continue;

      const identity =
        row?.message?.id || row?.requestId || `${row?.sessionId || file}|${timestamp}|${JSON.stringify(usage)}`;
      if (seen.has(identity)) continue;
      seen.add(identity);

      const tokens = [
        usage.input_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
        usage.output_tokens,
      ].reduce((sum, value) => sum + numberValue(value), 0);
      if (!tokens) continue;

      const date = localDate(new Date(timestamp), zone);
      add(byDate, date, tokens);
      add(callsByDate, date, 1);
      calls += 1;
    }
  }

  return { byDate, callsByDate, calls };
}

function readExistingRows(path) {
  if (!existsSync(path)) return new Map();

  try {
    const rows = JSON.parse(readFileSync(path, "utf8"));
    return new Map(Array.isArray(rows) ? rows.map((row) => [row.date, row]) : []);
  } catch {
    return new Map();
  }
}

function jsonlFiles(root) {
  if (!existsSync(root)) return [];

  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }

  return files;
}

function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function dateRange(sourceDates, zone) {
  const uniqueDates = [...new Set(sourceDates)].sort();
  if (uniqueDates.length === 0) return [localDate(new Date(), zone)];

  const start = parseDate(uniqueDates[0]);
  const end = parseDate(localDate(new Date(), zone));
  const dates = [];

  for (const cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }

  return dates;
}

function parseDate(date) {
  return new Date(`${date}T00:00:00.000Z`);
}

function localDate(date, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function add(map, key, value) {
  map.set(key, (map.get(key) || 0) + value);
}

function numberValue(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}
