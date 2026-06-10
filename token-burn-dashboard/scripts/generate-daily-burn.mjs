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
    const rows = readJsonl(file);
    const turnRepoHints = buildCodexTurnRepoHints(rows);
    const repoKeyCache = new Map();
    let currentCwd = "";
    let currentTurnId = "";

    for (const row of rows) {
      if (row?.type === "turn_context" && typeof row?.payload?.turn_id === "string") {
        currentTurnId = row.payload.turn_id;
      }

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
      const repoKey = repoKeyForCodexUsage(
        row?.payload?.cwd || currentCwd,
        currentTurnId,
        turnRepoHints,
        repoKeyCache,
      );
      const repo = aliases.aliasForRepoKey(repoKey);
      if (repo === "unattributed") unattributedEvents += 1;

      add(byDate, date, tokens);
      addRepoUsage(byRepoDate, date, repo, { codex_tokens: tokens });
      events += 1;
    }
  }

  return { byDate, byRepoDate, events, unattributedEvents };
}

function buildCodexTurnRepoHints(rows) {
  if (
    !rows.some(
      (row) =>
        typeof row?.payload?.cwd === "string" &&
        row.payload.cwd.toLowerCase().includes("codex-hive-refactor"),
    )
  ) {
    return new Map();
  }

  const counters = new Map();
  let currentTurnId = "";

  for (const row of rows) {
    if (row?.type === "turn_context" && typeof row?.payload?.turn_id === "string") {
      currentTurnId = row.payload.turn_id;
    }

    if (!currentTurnId) continue;

    const source = codexRepoHintSource(row);
    if (!source) continue;

    const counter = counters.get(currentTurnId) || new Map();
    for (const key of repoKeysFromCodexToolContext(source)) {
      counter.set(key, (counter.get(key) || 0) + 1);
    }
    if (counter.size > 0) counters.set(currentTurnId, counter);
  }

  const hints = new Map();
  for (const [turnId, counter] of counters) {
    const ranked = Array.from(counter, ([key, count]) => ({ key, count })).sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    );
    if (ranked[0]) hints.set(turnId, ranked[0].key);
  }

  return hints;
}

function codexRepoHintSource(row) {
  const payload = row?.payload || {};
  const payloadType = payload.type || "";

  if (row?.type === "turn_context") return { cwd: payload.cwd };

  if (row?.type === "event_msg" && payloadType === "exec_command_end") {
    return { cwd: payload.cwd, command: payload.command, parsed_cmd: payload.parsed_cmd };
  }

  if (row?.type === "event_msg" && payloadType === "patch_apply_end") {
    return { changes: payload.changes };
  }

  if (row?.type === "event_msg" && payloadType === "mcp_tool_call_end") {
    return { invocation: payload.invocation };
  }

  if (row?.type === "response_item" && payloadType === "function_call") {
    return { name: payload.name, arguments: payload.arguments };
  }

  if (row?.type === "response_item" && payloadType === "custom_tool_call") {
    return { name: payload.name, input: payload.input };
  }

  return null;
}

function repoKeysFromCodexToolContext(value) {
  const keys = [];

  function walk(node) {
    if (typeof node === "string") {
      keys.push(...repoKeysFromCodexHintString(node));
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if (!node || typeof node !== "object") return;

    for (const child of Object.values(node)) walk(child);
  }

  walk(value);
  return keys;
}

function repoKeysFromCodexHintString(value) {
  const keys = [];
  const text = String(value || "");
  const workspacePattern = /codex-hive-refactor[\\/]+([A-Za-z0-9._-]+)/gi;
  let match;

  while ((match = workspacePattern.exec(text))) {
    const key = repoKeyFromHiveWorkspaceChild(match[1]);
    if (key) keys.push(key);
  }

  const pathPattern =
    /(^|[\s"'`=:(\\/])((site|work|docs|hive|eventgraph|event-graph)(?:-[A-Za-z0-9._-]+)?)([\\/]|$)/gi;
  while ((match = pathPattern.exec(text))) {
    const key = repoKeyFromHiveWorkspaceChild(match[2]);
    if (key) keys.push(key);
  }

  return keys;
}

function repoKeyForCodexUsage(cwd, turnId, turnRepoHints, repoKeyCache) {
  if (isHiveWorkspaceRoot(cwd)) {
    return turnRepoHints.get(turnId) || repoKeyFromCwdCached(cwd, repoKeyCache);
  }

  return repoKeyFromCwdCached(cwd, repoKeyCache);
}

function repoKeyFromCwdCached(cwd, repoKeyCache) {
  const cacheKey = typeof cwd === "string" ? cwd : "";
  if (repoKeyCache.has(cacheKey)) return repoKeyCache.get(cacheKey);

  const repoKey = repoKeyFromCwd(cwd);
  repoKeyCache.set(cacheKey, repoKey);
  return repoKey;
}

function collectClaudeCodeUsage(zone, aliases) {
  const root = join(homedir(), ".claude", "projects");
  const files = jsonlFiles(root);
  const sessionRepoHints = buildClaudeSessionRepoHints(files, aliases);
  const byDate = new Map();
  const callsByDate = new Map();
  const byRepoDate = new Map();
  const seen = new Set();
  let calls = 0;
  let unattributedEvents = 0;

  for (const file of files) {
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
      const sessionId = row?.sessionId || file;
      const repo = sessionRepoHints.get(sessionId) || aliases.aliasForCwd(row?.cwd || row?.message?.cwd);
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

function buildClaudeSessionRepoHints(files, aliases) {
  const counters = new Map();

  for (const file of files) {
    for (const row of readJsonl(file)) {
      const sessionId = row?.sessionId || file;
      const keys = repoKeysFromMetadata(row);
      if (keys.length === 0) continue;

      const counter = counters.get(sessionId) || new Map();
      for (const key of keys) {
        counter.set(key, (counter.get(key) || 0) + 1);
      }
      counters.set(sessionId, counter);
    }
  }

  const hints = new Map();

  for (const [sessionId, counter] of counters) {
    const ranked = Array.from(counter, ([key, count]) => ({ key, count })).sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    );
    if (ranked.length === 0) continue;

    hints.set(sessionId, aliases.aliasForRepoKey(ranked[0].key));
  }

  return hints;
}

function repoKeysFromMetadata(value) {
  const keys = [];

  function walk(node) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if (!node || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node)) {
      const lowerKey = key.toLowerCase();
      const isRepoField =
        lowerKey === "repo" ||
        lowerKey === "prrepository" ||
        lowerKey === "repository" ||
        lowerKey === "repository_full_name" ||
        lowerKey === "repositoryfullname";

      if (isRepoField && typeof child === "string") {
        const repoKey = repoKeyFromMetadataValue(child);
        if (repoKey) keys.push(repoKey);
      }

      if (child && typeof child === "object") walk(child);
    }
  }

  walk(value);
  return keys;
}

function repoKeyFromMetadataValue(value) {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 120) return "";
  if (/[()+,]/.test(cleaned)) return "";

  const normalized = cleaned.replace(/\\/g, "/").replace(/^https?:\/\/github\.com\//i, "");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length === 1 && /^[a-z0-9._-]+$/i.test(parts[0])) return slug(parts[0]);
  if (parts.length === 2 && parts[0].toLowerCase() === "transpara-ai") return slug(parts[1]);

  return "";
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
      evidence:
        row.repo === "unattributed"
          ? "No cwd metadata available."
          : "Exact token totals; public-safe repo label from local cwd and tool context metadata.",
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
    aliasForRepoKey(key) {
      if (!key) return "unattributed";

      if (!state.repoAliases[key]) {
        state.repoAliases[key] = hashedRepoAlias(state.aliasSalt, key);
        changed = true;
      } else if (isSequentialAlias(state.repoAliases[key])) {
        state.repoAliases[key] = hashedRepoAlias(state.aliasSalt, key);
        changed = true;
      }

      return state.repoAliases[key];
    },
    aliasForCwd(cwd) {
      const cacheKey = typeof cwd === "string" ? cwd : "";
      if (cwdCache.has(cacheKey)) return cwdCache.get(cacheKey);

      const key = repoKeyFromCwd(cwd);
      if (!key) {
        cwdCache.set(cacheKey, "unattributed");
        return "unattributed";
      }

      const alias = this.aliasForRepoKey(key);
      cwdCache.set(cacheKey, alias);
      return alias;
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

  const hiveWorkspaceIndex = lowerSegments.lastIndexOf("codex-hive-refactor");
  if (hiveWorkspaceIndex >= 0) {
    const childRepoKey = repoKeyFromHiveWorkspaceChild(segments[hiveWorkspaceIndex + 1]);
    return childRepoKey || "hive";
  }

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

function isHiveWorkspaceRoot(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return false;

  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const hiveWorkspaceIndex = lowerSegments.lastIndexOf("codex-hive-refactor");

  return hiveWorkspaceIndex >= 0 && !segments[hiveWorkspaceIndex + 1];
}

function repoKeyFromHiveWorkspaceChild(value) {
  const key = slug(value || "");
  if (!key) return "";

  if (key === "site" || key.startsWith("site-")) return "site";
  if (key === "work" || key.startsWith("work-")) return "work";
  if (key === "docs" || key.startsWith("docs-")) return "docs";
  if (key === "eventgraph" || key === "event-graph" || key.startsWith("eventgraph-") || key.startsWith("event-graph-")) {
    return "eventgraph";
  }
  if (key === "hive" || key.startsWith("hive-")) return "hive";
  if (key === "tsystem-api" || key.startsWith("tsystem-api-")) return "tsystem-api";
  if (key === "tinstaller" || key.startsWith("tinstaller-")) return "tinstaller";

  return "";
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
