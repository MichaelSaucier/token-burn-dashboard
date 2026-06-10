import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const timeZone = process.env.TOKEN_BURN_TIMEZONE || "Europe/Lisbon";
const outputPath = join(process.cwd(), "data", "daily-burn.json");
const repoOutputPath = join(process.cwd(), "data", "repo-burn.json");
const aliasPath = join(process.cwd(), "data", "repo-aliases.local.json");
const existingRows = readExistingRows(outputPath);
const repoAliases = createRepoAliasResolver(aliasPath);

const codex = collectCodexUsage(timeZone, repoAliases);
const claude = collectClaudeCodeUsage(timeZone, repoAliases);
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

const repoRows = buildRepoRows([codex.byRepoDate, claude.byRepoDate]);

writeFileSync(outputPath, `${JSON.stringify(rows, null, 2)}\n`);
writeFileSync(repoOutputPath, `${JSON.stringify(repoRows, null, 2)}\n`);
repoAliases.save();

console.log(
  JSON.stringify(
    {
      output: outputPath,
      repoOutput: repoOutputPath,
      timezone: timeZone,
      rows: rows.length,
      repoRows: repoRows.length,
      repoAliases: repoAliases.count,
      codexEvents: codex.events,
      claudeCodeCalls: claude.calls,
      unattributedEvents: codex.unattributedEvents + claude.unattributedEvents,
      note: "Raw logs were read locally; only normalized daily totals and scrubbed repo aliases were written.",
    },
    null,
    2,
  ),
);

function collectCodexUsage(zone, aliases) {
  const roots = [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), ".codex", "archived_sessions"),
  ];
  const byDate = new Map();
  const byRepoDate = new Map();
  const seen = new Set();
  let events = 0;
  let unattributedEvents = 0;

  for (const file of roots.flatMap((root) => jsonlFiles(root))) {
    let currentCwd = "";

    for (const row of readJsonl(file)) {
      if (typeof row?.payload?.cwd === "string" && row.payload.cwd.trim()) {
        currentCwd = row.payload.cwd;
      }

      const usage = row?.payload?.info?.last_token_usage;
      const tokens = numberValue(usage?.total_tokens);
      const timestamp = row?.timestamp || row?.ts || row?.time;
      if (!tokens || !timestamp) continue;

      const key = `${timestamp}|${tokens}|${row?.payload?.info?.total_token_usage?.total_tokens || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const date = localDate(new Date(timestamp), zone);
      const repo = aliases.aliasForCwd(row?.payload?.cwd || currentCwd);
      if (repo === "unattributed") unattributedEvents += 1;

      add(byDate, date, tokens);
      addRepoUsage(byRepoDate, date, repo, { codex_tokens: tokens });
      events += 1;
    }
  }

  return { byDate, byRepoDate, events, unattributedEvents };
}

function collectClaudeCodeUsage(zone, aliases) {
  const root = join(homedir(), ".claude", "projects");
  const byDate = new Map();
  const callsByDate = new Map();
  const byRepoDate = new Map();
  const seen = new Set();
  let calls = 0;
  let unattributedEvents = 0;

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
      const repo = aliases.aliasForCwd(row?.cwd || row?.message?.cwd);
      if (repo === "unattributed") unattributedEvents += 1;

      add(byDate, date, tokens);
      add(callsByDate, date, 1);
      addRepoUsage(byRepoDate, date, repo, {
        claude_code_tokens: tokens,
        claude_code_calls: 1,
      });
      calls += 1;
    }
  }

  return { byDate, callsByDate, byRepoDate, calls, unattributedEvents };
}

function buildRepoRows(repoMaps) {
  const merged = new Map();

  for (const repoMap of repoMaps) {
    for (const row of repoMap.values()) {
      addRepoUsage(merged, row.date, row.repo, {
        codex_tokens: row.codex_tokens,
        claude_code_tokens: row.claude_code_tokens,
        claude_code_calls: row.claude_code_calls,
      });
    }
  }

  return Array.from(merged.values())
    .map((row) => ({
      date: row.date,
      repo: row.repo,
      codex_tokens: row.codex_tokens,
      claude_code_tokens: row.claude_code_tokens,
      claude_code_calls: row.claude_code_calls,
      total: row.codex_tokens + row.claude_code_tokens,
      evidence: row.repo === "unattributed" ? "No cwd metadata available." : "Public-safe repo label from local cwd metadata.",
    }))
    .filter((row) => row.total > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.repo.localeCompare(b.repo));
}

function addRepoUsage(map, date, repo, values) {
  const key = `${date}\u0000${repo}`;
  const row =
    map.get(key) || {
      date,
      repo,
      codex_tokens: 0,
      claude_code_tokens: 0,
      claude_code_calls: 0,
    };

  row.codex_tokens += numberValue(values.codex_tokens);
  row.claude_code_tokens += numberValue(values.claude_code_tokens);
  row.claude_code_calls += numberValue(values.claude_code_calls);
  map.set(key, row);
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
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }

  return files.sort();
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

function createRepoAliasResolver(path) {
  const state = readAliasState(path);
  const cwdCache = new Map();
  let changed = !state.aliasSalt;

  if (!state.aliasSalt) {
    state.aliasSalt = randomBytes(16).toString("hex");
  }

  return {
    get count() {
      return Object.keys(state.repoAliases).length;
    },
    aliasForCwd(cwd) {
      const cacheKey = typeof cwd === "string" ? cwd : "";
      if (cwdCache.has(cacheKey)) return cwdCache.get(cacheKey);

      const key = repoKeyFromCwd(cwd);
      if (!key) {
        cwdCache.set(cacheKey, "unattributed");
        return "unattributed";
      }

      if (!state.repoAliases[key]) {
        state.repoAliases[key] = hashedRepoAlias(state.aliasSalt, key);
        changed = true;
      } else if (isSequentialAlias(state.repoAliases[key])) {
        state.repoAliases[key] = hashedRepoAlias(state.aliasSalt, key);
        changed = true;
      }

      cwdCache.set(cacheKey, state.repoAliases[key]);
      return state.repoAliases[key];
    },
    save() {
      if (!changed && existsSync(path)) return;

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            note: "Private local mapping. Edit alias values only if they are safe to publish, then rerun npm run update:data. This file is gitignored.",
            aliasSalt: state.aliasSalt,
            repoAliases: state.repoAliases,
          },
          null,
          2,
        )}\n`,
      );
    },
  };
}

function readAliasState(path) {
  if (!existsSync(path)) return { aliasSalt: "", repoAliases: {} };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      aliasSalt: typeof parsed?.aliasSalt === "string" ? parsed.aliasSalt : "",
      repoAliases:
        parsed && typeof parsed.repoAliases === "object" && !Array.isArray(parsed.repoAliases)
          ? parsed.repoAliases
          : {},
    };
  } catch {
    return { aliasSalt: "", repoAliases: {} };
  }
}

function hashedRepoAlias(salt, key) {
  return `repo-${createHash("sha256").update(`${salt}:${key}`).digest("hex").slice(0, 8)}`;
}

function isSequentialAlias(value) {
  return /^repo-\d+$/.test(String(value));
}

function repoKeyFromCwd(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return "";

  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const claudeIndex = lowerSegments.lastIndexOf(".claude");

  if (claudeIndex > 0) return slug(segments[claudeIndex - 1]);

  const reposIndex = lowerSegments.lastIndexOf("repos");
  if (reposIndex >= 0 && segments[reposIndex + 1]) return slug(segments[reposIndex + 1]);

  const projectsIndex = lowerSegments.lastIndexOf("projects");
  if (projectsIndex >= 0 && segments[projectsIndex + 1]) return slug(segments[projectsIndex + 1]);

  const gitRoot = gitTopLevel(cwd);
  if (gitRoot) {
    const gitSegments = gitRoot.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
    return slug(gitSegments.at(-1) || "");
  }

  return slug(segments.at(-1) || "");
}

function gitTopLevel(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    return "";
  }
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
