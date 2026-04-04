# Dashboard Custom View — Design Spec

## Overview

Replace the auto-generated `Dashboard.md` markdown file with a custom Obsidian `ItemView` that renders an interactive dashboard using HTML and CSS Grid. The dashboard opens on startup and serves as the daily landing screen — surfacing actionable information, tracking progress, and providing quick access to daily notes.

## Goals

- Spatial layout with mixed content types (text, charts, interactive inputs)
- Interactive habit toggles and metric logging directly on the dashboard
- Unified config for boolean habits and numeric tracking
- Quick links to open or create daily/periodic notes
- Rediscovery section surfacing forgotten notes
- AI-generated briefing summarizing deadlines, trends, and themes
- No external dependencies for rendering — SVG charts, CSS Grid, inline styles

## Layout

Two-column grid below a full-width hero banner:

```
┌─────────────────────────────────────────────────────┐
│                   AI Briefing                        │
├──────────────────────────────┬──────────────────────┤
│  Quick Links                 │  Habits (boolean)    │
│  [Journal] [Dream] [Review]  │  Exercise  ■■■□■■■   │
├──────────────────────────────│  Read 30m  ■■■■■■■   │
│  Active Tasks                │  Meditate  ■■□□■□□   │
│  ☐ Fix auth bug · due Fri   ├──────────────────────┤
│  ☐ Review PR #42            │  Sitting Time        │
│  ☐ Write tests              │  [3.8] Goal: <3h     │
├──────────────────────────────│  ~~~~~~~~~ graph     │
│  Rediscovery                 ├──────────────────────┤
│  The Problem with Multi...   │  Screen Time         │
│  Rust Ownership Mental...    │  [6.2] Goal: <6h     │
│  Dream: Flying Over Water    │  ~~~~~~~~~ graph     │
└──────────────────────────────┴──────────────────────┘
```

- Left column: fluid width
- Right column: fixed ~280px
- AI Briefing spans full width at top

## Rendering Approach

Custom `ItemView` subclass registered via `this.registerView()`. Opened via ribbon icon, command palette, or automatically on startup (configurable). Renders HTML directly using Obsidian's `createEl`/`createDiv` DOM APIs. Layout via CSS Grid. Charts via inline SVG.

No Canvas plugin, no markdown file, no Dataview dependency.

## Sections

### AI Briefing (Hero Banner)

Full-width card at the top. Contains an LLM-generated summary of:
- Upcoming deadlines from active tasks
- Tracking trends (e.g., "Sitting time trending down, on track for 3h goal")
- Recent themes from notes (e.g., "Water imagery in 4 of 7 dream entries")

**Generation:** On dashboard open (or manual refresh), the plugin assembles context from: active tasks (with due dates), last 7 days of tracking data (values and trends), and titles + tags of notes modified in the last 7 days. This context is sent to Ollama with a system prompt instructing it to produce a 2-3 sentence briefing highlighting what's urgent, what's trending, and any notable patterns. The summary is cached for a configurable period (default 2 hours) to avoid regenerating on every tab switch.

**When Ollama is unavailable:** Display "AI briefing unavailable — Ollama not running" in muted text. Do not block dashboard rendering.

### Quick Links

Row of pill-shaped buttons. Each opens or creates a note based on a date pattern. If the note exists, open it. If not, create it (empty or from a template if one exists at the expected path).

**Config file:** `AI-Assistant/quick-links.md`

```
# Quick Links

- Journal (daily, use daily note settings)
- Dream Journal (daily, folder: Dreams/, format: YYYY-MM-DD)
- Weekly Review (weekly, folder: Reviews/, format: YYYY-[W]ww)
```

**Parser extracts per entry:**
- `label` — the display name
- `frequency` — `daily` or `weekly` (determines date granularity)
- `folder` — target folder for note creation. If "use daily note settings", read from Obsidian's Daily Notes core plugin config.
- `format` — date format string for the filename. If "use daily note settings", read from Daily Notes config.

**Date resolution:** `daily` uses today's date. `weekly` uses the current ISO week start.

### Active Tasks

Unchecked `- [ ]` items aggregated from across the vault. Each task row shows the task text, due date (if present, parsed from `📅 YYYY-MM-DD` inline format), and source note path. Clicking a task navigates to the source note.

**Data source:** Query vault markdown files at render time using `VaultService.getMarkdownFiles()` and regex extraction. Exclude `AI-Assistant/` folder and the dashboard view itself.

**Display:** Sorted by due date ascending (dated tasks first), then by file modification time. Limit to 25 tasks.

### Rediscovery

3 random notes the user hasn't opened recently, from configured folders. Clicking opens the note.

**Config (plugin settings):**
- `rediscoveryFolders: string[]` — folders to draw from (e.g., `["Notes/", "Ideas/", "Projects/"]`). Default: `[""]` (entire vault).
- `rediscoveryMinAgeDays: number` — minimum days since last opened. Default: 30.
- `rediscoveryCount: number` — how many notes to show. Default: 3.

**Selection:** On first dashboard render of the day, select `count` random notes matching the criteria. Persist the selection for the day by storing `{ date: "YYYY-MM-DD", paths: [...] }` in `AI-Assistant/rediscovery.json`. On subsequent renders the same day, read from the persisted selection.

**Display:** Each note shows its title (filename without extension), folder path, and "last opened X days ago." If a persisted note no longer exists, skip it and don't replace (avoids re-randomizing mid-day).

### Habits (Right Column — Top)

Boolean habits displayed as a 7-day streak grid. Each habit shows: name, 7 squares (filled = completed, empty = not), and a count (e.g., "6/7").

**Today's square is clickable** — click to toggle today's completion. Updates the tracking log immediately.

**Data source:** Entries with `(boolean)` type in the unified tracking config.

### Tracking Graphs (Right Column — Below Habits)

One card per numeric tracked metric. Each card contains:
- Header row: metric name (left), goal label (right, e.g., "Goal: <3h")
- Current value display: large number with trend arrow (↑/↓ compared to previous day, colored green if trending toward goal, red if away)
- **Inline input field:** text input showing today's logged value (or empty placeholder). User types a value and presses Enter to log. Accepts: integers (`1`), floats (`1.3`), time format (`2:23` → parsed as hours:minutes → stored as decimal 2.383).
- SVG line chart: 7-day view with data points, connecting line, and dashed goal line

**One value per metric per day.** If the user enters a new value on the same day, it replaces the previous one.

**Data source:** Entries with a unit (non-boolean) in the unified tracking config.

## Unified Tracking Config

**File:** `AI-Assistant/tracking.md`

```
# Tracking

- Sitting Time (hours, goal: <3)
- Screen Time (hours, goal: <6)
- Push-ups (reps, goal: >50)
- Leetcode (problems, goal: >1)
- Exercise (boolean)
- Read 30m (boolean)
```

**Parser extracts per entry:**
- `name` — display label
- `type` — `"boolean"` if the unit is "boolean", otherwise `"numeric"`
- `unit` — the unit label string (e.g., "hours", "reps", "problems"). Displayed on the graph but not used for calculation.
- `goalDirection` — `"<"` or `">"` parsed from the goal prefix
- `goalValue` — the numeric goal target

**This replaces the current `AI-Assistant/habits.md` config.** Booleans are rendered as streak grids in the Habits section. Numerics are rendered as graph cards in the Tracking section. One config, two renderings.

## Tracking Data Storage

**File:** `AI-Assistant/tracking-log.json`

```json
{
  "schemaVersion": 1,
  "entries": {
    "Exercise": [
      { "date": "2026-04-01", "value": 1 },
      { "date": "2026-04-02", "value": 1 },
      { "date": "2026-04-03", "value": 0 }
    ],
    "Sitting Time": [
      { "date": "2026-04-01", "value": 4.2 },
      { "date": "2026-04-02", "value": 3.9 },
      { "date": "2026-04-03", "value": 3.8 }
    ]
  }
}
```

- Boolean habits: `1` = completed, `0` = not completed
- Numeric metrics: the logged value (float). Time inputs (`2:23`) are converted to decimal (`2.383`) before storage.
- One entry per metric per day. Logging a new value for the same day replaces the previous entry.
- **This replaces the current `AI-Assistant/habit-log.md`.** The schema is different — migration from the old format on first load.

## SVG Chart Rendering

Pure SVG, no dependencies. Generated by a chart rendering function that takes an array of data points, a goal value, and dimensions.

**Elements:**
- Polyline connecting data points
- Circle at each data point
- Dashed horizontal line at the goal value
- Day-of-week labels along the x-axis (M T W T F S S)
- Goal label at the right edge of the goal line

**Scaling:** Y-axis auto-scales to fit the data range with padding above and below. The goal line is positioned relative to the data range.

**Colors:** Line color per metric (configurable or auto-assigned from a palette). Goal line in muted gray. Data points match the line color. Trend arrow: green if moving toward goal, red if moving away.

## Input Parsing

The inline input field for numeric metrics accepts three formats:

| Input | Parsed Value | Rule |
|-------|-------------|------|
| `1` | `1` | Integer |
| `1.3` | `1.3` | Float |
| `2:23` | `2.383` | Hours:minutes → `hours + minutes/60` |

Validation: reject non-numeric input, negative values, and times with minutes > 59. Show a brief red flash on the input border for invalid input.

## Plugin Lifecycle

### onload

- Register the dashboard view type via `this.registerView()`
- Add ribbon icon to open the dashboard
- Add command "Open dashboard"

### onLayoutReady

- If "open on startup" setting is enabled and dashboard is not already open, open it as the active leaf

### Settings

| Setting | Type | Default |
|---------|------|---------|
| `openDashboardOnStartup` | boolean | true |
| `aiBriefingCacheMinutes` | number | 120 |
| `rediscoveryFolders` | string (comma-separated) | "" (entire vault) |
| `rediscoveryMinAgeDays` | number | 30 |
| `rediscoveryCount` | number | 3 |

## Migration from Current Dashboard

The current `DashboardModule` generates a markdown `Dashboard.md` file. This is replaced entirely:

- `DashboardModule` class and its rendering logic are removed
- The `updateDashboard` method in `main.ts` is removed
- The `autoDashboardRefresh` and `dashboardRefreshIntervalHours` settings are removed
- The `dashboardPath` setting is removed
- `Dashboard.md` is no longer generated or managed by the plugin. If one exists, it's left in place (not deleted) but the plugin stops writing to it.
- The habit log migration: on first load, if `AI-Assistant/habit-log.md` exists and `AI-Assistant/tracking-log.json` does not, convert the old format to the new schema.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| **Ollama unavailable for AI briefing** | Show "AI briefing unavailable" in muted text. Dashboard renders normally without it. |
| **tracking.md missing or empty** | Habits and tracking sections show "No metrics configured. Edit AI-Assistant/tracking.md to add habits and metrics." |
| **quick-links.md missing or empty** | Quick Links section is hidden. |
| **Daily note settings not configured** | Quick link entries with "use daily note settings" show a warning: "Configure Daily Notes core plugin." |
| **Invalid input in tracking field** | Red flash on input border, value not saved. |
| **tracking-log.json corrupt** | Start fresh. Same pattern as other JSON stores. |
| **Rediscovery note deleted mid-day** | Skip it in the display. Don't re-randomize. |

## What Is Not In Scope

- AI-generated dashboard layout — the layout is fixed, not dynamically arranged
- Drag-and-drop reordering of sections
- Multiple dashboard views or tabs
- Calendar widget — may be added later but not in this version
- Graph time ranges beyond 7 days — future enhancement
- Template support for quick-link note creation — creates empty notes for now
