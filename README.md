# Michael Saucier

A readme in the spirit of [Nat Friedman's plain personal page](https://nat.org/): short, specific, and opinionated.

Some things about me:

- I am Michael Saucier.
- I work in the Transpara world, where operational clarity matters.
- I build tools that make invisible work visible.
- AI is part of my daily working surface: Codex, Claude Code, Claude chat, and ChatGPT.
- I care enough about AI usage to measure it instead of guessing.
- My working timezone for this project is Europe/Lisbon.
- This repository is a public-safe window into private local activity: raw logs stay local, normalized totals become data.

Some things I believe:

- Measurement should earn trust.
  - Exact data and estimates belong in different columns.
  - A number with provenance beats a prettier number without it.
  - The dashboard should say what it knows and what it is still inferring.
- Speed matters because feedback decays.
  - Daily evidence is better than quarterly memory.
  - A script I can rerun is better than a spreadsheet I have to defend.
  - The right loop is: measure, inspect, adjust, ship.
- AI work should be accountable to outcomes.
  - Token burn is not a scoreboard.
  - Token burn is a signal for where friction, leverage, and automation are hiding.
  - The useful question is not "how many tokens?" but "what did that burn make possible?"
- Privacy is architecture.
  - Raw conversations and local logs should not become repo content by accident.
  - Public-safe labels are a feature, not a cosmetic layer.
  - The best tooling preserves useful signal while stripping sensitive context.
- Small, sharp tools beat sprawling dashboards.
  - If a chart cannot change the next decision, it probably does not belong.
  - If a label cannot be applied consistently, it should be boring until it is true.
  - If the computer can count it, I should not count it by hand.
- The best systems leave receipts.
  - Data files should be readable.
  - Assumptions should be explicit.
  - Re-running the pipeline should make the same kind of truth tomorrow.

Some things this repo does:

- Reads local Codex and Claude Code usage logs.
- Converts raw activity into daily token totals.
- Keeps exact local-agent usage separate from Claude chat and ChatGPT estimates.
- Splits usage by source, work driver, and public-safe repo label.
- Shows heatmaps, weekly trends, moving averages, source split, repo split, scale equivalents, and next actions.
- Keeps raw logs and private mappings outside Git.

Some things this repo refuses to do:

- Pretend estimated chat usage is exact.
- Commit raw AI logs, private exports, or local alias mappings.
- Hide uncertainty behind a single clean-looking total.
- Optimize for decorative charts over operational clarity.

## The Project

`token-burn-dashboard` is a local Next.js dashboard for understanding AI token burn by day, source, repo, and work driver.

The point is not cost accounting for its own sake. The point is to see where AI work is producing leverage, where it is getting noisy, and where a repeated pattern should become a checklist, script, or better workflow.

## Data Model

The dashboard reads normalized JSON files from `token-burn-dashboard/data`:

- `daily-burn.json` contains daily totals by source and driver.
- `repo-burn.json` contains exact local-agent usage by public-safe repo label.
- `repo-aliases.local.json` is generated locally and ignored by Git.

Exact sources:

- Codex local session logs.
- Claude Code local project logs.

Estimated sources:

- Claude chat.
- ChatGPT.

Estimated columns intentionally stay separate until exports or calibration assumptions are approved.

## Run It

From the repository root:

```powershell
cd token-burn-dashboard
npm install
npm run update:data
npm run dev
```

Then open the local URL printed by Next.js.

Useful scripts:

```powershell
npm run update:data
npm run dev
npm run build
```

## Privacy Rules

Raw logs are read from local machine paths and are not copied into the app.

The generated repo labels are public-safe aliases unless manually changed in the ignored local alias file. Data files in Git should contain normalized totals, source categories, driver labels, and scrubbed repo identifiers only.

## Working Notes

The dashboard should stay honest before it gets clever.

Add automation only when it removes repeated judgment. Add visualization only when it changes the next action. Add estimates only when the assumption is clear enough to defend later.
