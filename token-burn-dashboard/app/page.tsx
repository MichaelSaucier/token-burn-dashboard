"use client";

import { useMemo, useState } from "react";

import rawRows from "../data/daily-burn.json";
import rawRepoRows from "../data/repo-burn.json";
import { normalizeRepoRows, normalizeRows, sourceColumns, sumSource } from "../lib/burn-data";
import { getWindowRows, type WindowKey, windows } from "../lib/date-windows";
import {
  fermiScale,
  formatTokens,
  logHeatLevel,
  movingAverage7,
  sumTokens,
  weeklyTotals,
} from "../lib/token-math";

const rows = normalizeRows(rawRows);
const repoRows = normalizeRepoRows(rawRepoRows);

export default function TokenBurnDashboard() {
  const [windowKey, setWindowKey] = useState<WindowKey>("180");

  const selectedRows = useMemo(() => getWindowRows(rows, windowKey), [windowKey]);
  const selectedRepoRows = useMemo(() => getWindowRows(repoRows, windowKey), [windowKey]);
  const total = sumTokens(selectedRows);
  const repoExactTotal = selectedRepoRows.reduce((sum, row) => sum + row.total, 0);
  const maxDay = Math.max(...selectedRows.map((row) => row.total), 0);
  const peakDay = selectedRows.reduce(
    (peak, row) => (row.total > peak.total ? row : peak),
    selectedRows[0] || rows[0],
  );
  const lastAverage =
    selectedRows.length > 0 ? movingAverage7(selectedRows, selectedRows.length - 1) : 0;
  const drivers = buildDriverRows(selectedRows, total);
  const weekly = weeklyTotals(selectedRows);
  const path = buildTrendPath(weekly.map((week) => week.total));
  const peakWeek = weekly.reduce(
    (peak, week) => (week.total > peak.total ? week : peak),
    weekly[0] || { week: "n/a", total: 0 },
  );
  const sourceTotal = sourceColumns.reduce((sum, source) => sum + sumSource(selectedRows, source.key), 0);
  const tableRows = selectedRows.slice(-30).reverse();
  const repos = buildRepoSummaryRows(selectedRepoRows, repoExactTotal);
  const nextActions = buildNextActions(selectedRows, drivers, repos, total);

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Token burn dashboard</p>
          <h1>AI usage by day, source, and work driver.</h1>
          <p className="lead">Exact local agent logs are measured. Chat estimates stay separate until you approve the assumptions.</p>
        </div>
        <div className="range" aria-label="Select time range">
          {windows.map((windowOption) => (
            <button
              key={windowOption.key}
              type="button"
              aria-pressed={windowKey === windowOption.key}
              onClick={() => setWindowKey(windowOption.key)}
            >
              {windowOption.label}
            </button>
          ))}
        </div>
      </section>

      <section className="stats" aria-label="Token burn summary">
        <Metric label="Total burn" value={formatTokens(total)} note="selected window" />
        <Metric label="Peak day" value={formatTokens(peakDay?.total || 0)} note={peakDay?.date || "n/a"} />
        <Metric label="7d average" value={formatTokens(lastAverage)} note="moving average" />
        <Metric label="Active days" value={`${selectedRows.length}`} note="rows in view" />
      </section>

      <section className="statusBand" aria-label="Data status">
        <span>Timezone: Europe/Lisbon</span>
        <span>Codex and Claude Code: exact local log totals</span>
        <span>Repo split: public-safe labels from exact cwd metadata</span>
        <span>Claude chat and ChatGPT: estimated columns pending interview</span>
      </section>

      <section className="grid">
        <Panel
          label="Daily burn"
          title="Heatmap"
          note="Log color scale so quiet days and spikes can share one surface."
        >
          <div className="heatmap" aria-label="Daily token burn heatmap">
            {selectedRows.map((row) => (
              <span
                key={row.date}
                className={`cell heat${logHeatLevel(row.total, maxDay)}`}
                title={`${row.date}: ${formatTokens(row.total)} tokens, ${row.driver}`}
              />
            ))}
          </div>
          <div className="legend" aria-hidden>
            <span>less</span>
            {[0, 1, 2, 3, 4, 5].map((level) => (
              <i key={level} className={`heat${level}`} />
            ))}
            <span>more</span>
          </div>
        </Panel>

        <Panel
          label="Weekly trend"
          title="Log-scaled trend"
          note="A smooth read on whether usage is getting sharper or merely larger."
        >
          <div className="trend">
            <svg viewBox="0 0 720 260" role="img" aria-label="Weekly token burn trend line">
              <path d="M30 40H690M30 120H690M30 200H690" stroke="rgba(240,236,228,0.12)" />
              <path d={path} fill="none" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
            </svg>
          </div>
          <p className="trendNote">Peak week: {peakWeek.week} at {formatTokens(peakWeek.total)} tokens.</p>
        </Panel>
      </section>

      <section className="grid">
        <Panel
          label="Source split"
          title="Exact beside estimated"
          note="The source labels are part of the dashboard, not a footnote."
        >
          <div className="sourceGrid">
            {sourceColumns.map((source) => {
              const value = sumSource(selectedRows, source.key);
              const share = sourceTotal ? Math.round((value / sourceTotal) * 100) : 0;
              return (
                <div key={source.key} className="source">
                  <span className={`pill ${source.fidelity}`}>{source.fidelity}</span>
                  <strong>{formatTokens(value)}</strong>
                  <span className="muted">
                    {source.label} / {share}%
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel
          label="Drivers"
          title="What is burning tokens"
          note="Keep driver labels boring and consistent: shipping, research, review, video, admin."
        >
          <div className="driverGrid">
            {drivers.map((driver) => (
              <div key={driver.label} className="driver">
                <strong>{driver.label}</strong>
                <span className="track">
                  <i style={{ width: `${driver.share}%` }} />
                </span>
                <span>{driver.share}% / {formatTokens(driver.value)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid">
        <Panel
          label="Repos"
          title="Where exact agent burn went"
          note="Public-safe labels from local cwd metadata; exact Codex and Claude Code usage only."
        >
          <div className="repoGrid">
            {repos.map((repo) => (
              <div key={repo.repo} className="repoRow">
                <strong>{repo.repo}</strong>
                <span className="track">
                  <i style={{ width: `${repo.share}%` }} />
                </span>
                <span>{repo.share}% / {formatTokens(repo.total)}</span>
                <span className="muted">
                  Codex {formatTokens(repo.codex)} / Claude {formatTokens(repo.claude)} / {repo.calls} calls
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          label="Scale equivalents"
          title="Make the number human"
          note="Approximate comparisons are useful only when the math stays visible."
        >
          <div className="equivalents">
            {fermiScale(total).map((item) => (
              <div key={item.label} className="equivalent">
                <span className="muted">{item.label}</span>
                <strong>{item.value}</strong>
                <span>{item.note}</span>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid">
        <Panel
          label="Next work"
          title="What the computer should do next"
          note="Recommendations come from the current window and data fidelity."
        >
          <ol className="actionList">
            {nextActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ol>
        </Panel>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="label">Moving-average table</p>
            <h2>Last 30 days</h2>
          </div>
          <p>Exact and estimated columns stay separate.</p>
        </div>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Total</th>
                <th>7d avg</th>
                <th>Codex exact</th>
                <th>Claude Code exact</th>
                <th>Calls</th>
                <th>Claude chat est.</th>
                <th>ChatGPT est.</th>
                <th>Driver</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => {
                const originalIndex = selectedRows.findIndex((candidate) => candidate.date === row.date);
                return (
                  <tr key={row.date}>
                    <td>
                      <strong>{row.date}</strong>
                    </td>
                    <td>{formatTokens(row.total)}</td>
                    <td>{formatTokens(movingAverage7(selectedRows, originalIndex))}</td>
                    <td>{formatTokens(row.codex_tokens)}</td>
                    <td>{formatTokens(row.claude_code_tokens)}</td>
                    <td>{row.claude_code_calls}</td>
                    <td>{formatTokens(row.claude_chat_est)}</td>
                    <td>{formatTokens(row.chatgpt_est)}</td>
                    <td>{row.driver}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <p className="footerNote">
        Data files: <code>data/daily-burn.json</code> and <code>data/repo-burn.json</code>. Raw logs and exports stay outside the app.
      </p>
    </main>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <span>{note}</span>
    </div>
  );
}

function Panel({
  label,
  title,
  note,
  children,
}: {
  label: string;
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <article className="panel">
      <div className="panelHeader">
        <div>
          <p className="label">{label}</p>
          <h2>{title}</h2>
        </div>
        <p>{note}</p>
      </div>
      {children}
    </article>
  );
}

function buildDriverRows(selectedRows: typeof rows, total: number) {
  const totals = new Map<string, number>();

  for (const row of selectedRows) {
    totals.set(row.driver, (totals.get(row.driver) || 0) + row.total);
  }

  return Array.from(totals, ([label, value]) => ({
    label,
    value,
    share: total ? Math.round((value / total) * 100) : 0,
  }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
}

function buildRepoSummaryRows(selectedRows: typeof repoRows, total: number) {
  const totals = new Map<
    string,
    { repo: string; total: number; codex: number; claude: number; calls: number }
  >();

  for (const row of selectedRows) {
    const current = totals.get(row.repo) || {
      repo: row.repo,
      total: 0,
      codex: 0,
      claude: 0,
      calls: 0,
    };
    current.total += row.total;
    current.codex += row.codex_tokens;
    current.claude += row.claude_code_tokens;
    current.calls += row.claude_code_calls;
    totals.set(row.repo, current);
  }

  return Array.from(totals.values())
    .map((repo) => ({
      ...repo,
      share: total ? Math.round((repo.total / total) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
}

function buildNextActions(
  selectedRows: typeof rows,
  drivers: ReturnType<typeof buildDriverRows>,
  repos: ReturnType<typeof buildRepoSummaryRows>,
  total: number,
) {
  const unlabeled = selectedRows.filter((row) => row.driver === "unlabeled" && row.total > 0).length;
  const estimatedTotal = selectedRows.reduce((sum, row) => sum + row.claude_chat_est + row.chatgpt_est, 0);
  const leadDriver = drivers.find((driver) => driver.label !== "unlabeled");
  const leadRepo = repos[0];
  const actions = [];

  if (unlabeled > 0) {
    actions.push(`Label ${unlabeled} measured day${unlabeled === 1 ? "" : "s"} so burn can be tied to work family.`);
  }

  if (estimatedTotal === 0) {
    actions.push("Add Claude chat and ChatGPT estimates only after exports or calibration answers are approved.");
  }

  if (leadRepo) {
    actions.push(`Focus automation on ${leadRepo.repo}, the largest exact repo burn in this window.`);
  }

  if (leadDriver && total > 0) {
    actions.push(`Turn the largest driver, ${leadDriver.label}, into a checklist or script before the next high-burn session.`);
  } else {
    actions.push("Start with exact-log automation, then add driver labels for the top token days.");
  }

  return actions.slice(0, 3);
}

function buildTrendPath(values: number[]) {
  if (values.length === 0) return "";

  const width = 660;
  const height = 190;
  const left = 30;
  const top = 35;
  const max = Math.max(...values, 1);

  const points = values.map((value, index) => {
    const x = left + (values.length === 1 ? width / 2 : (index / (values.length - 1)) * width);
    const normalized = Math.log10(value + 1) / Math.log10(max + 1);
    const y = top + height - normalized * height;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });

  return `M${points.join(" L")}`;
}
