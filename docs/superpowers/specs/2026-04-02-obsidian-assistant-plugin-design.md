# Obsidian AI Assistant Plugin — Design Spec

## Overview

An Obsidian plugin that reduces the friction of vault maintenance and increases the surface area of useful features through AI assistance. The plugin does **not** generate note content — it scaffolds the user's own learning, productivity, and goal tracking.

**Core philosophy:** AI handles the organizational overhead (tagging, linking, dashboarding) so the user can focus on thinking and writing.

## Feature Tiers

- **Tier 1 (highest priority):** Auto-tagging, tag auditing, connection detection
- **Tier 2:** Dashboard generation, goal tracking, habit tracking, task aggregation
- **Future tiers (out of scope for this spec):** Anki card creation, auto-MOC, deeper dive research, note review/accuracy checking

## Compatibility

- **Minimum Obsidian version:** 1.4.0+ (required for `processFrontMatter` API and modern frontmatter manipulation)
- **Obsidian API:** Uses the current plugin API (`obsidian` npm package)

## Architecture: Feature Modules with Shared Task Queue

### Layer 1: Feature Modules

Domain-specific units that each handle one concern. Each module:

- Defines its trigger conditions (note saved, vault opened, timer, manual invocation)
- Owns its prompts and knows how to parse LLM responses
- Declares its model requirements (`local-only`, `local-preferred`, `claude-required`)
- Emits tasks into the orchestrator queue

### Layer 2: Orchestrator

Central task queue and router:

- Receives tasks from feature modules
- Routes to the appropriate LLM provider based on task requirements, model availability, and user preferences
- Manages a cost budget (configurable daily/monthly token cap for Claude API)
- Batches related tasks where possible (e.g., tag 5 untagged notes in one call)
- Defers tasks when the required model isn't available
- Respects priority ordering (user-initiated > automatic)
- One LLM call at a time — sequential processing, no parallel requests

### Layer 3: LLM Service

Unified interface over both providers:

- **OllamaProvider:** Talks to local Ollama instance. Health-checked before use.
- **ClaudeProvider:** Talks to Anthropic API via the official TypeScript SDK.
- Common interface: `complete(request) → response` with token counting per call.

### Layer 4: Vault Interface

Thin abstraction over Obsidian's vault API for reading/writing notes, frontmatter, and tags.

## Model Routing Philosophy

- **Local LLM (Ollama/llama3 8B):** Tasks where the 8B model can reliably do the whole job — tagging against an existing taxonomy, simple frontmatter operations, keyword extraction, dashboard generation.
- **Claude:** Tasks requiring stronger reasoning — semantic similarity for tag audits, nuanced connection detection across the vault, complex prioritization.
- **No local-as-preprocessor pattern:** The local LLM is not used to compress or summarize content before sending to Claude. This introduces distortion and the cost savings are negligible. Each model handles complete tasks independently.
- **Privacy filtering (future consideration):** Local LLM redacting sensitive content before a Claude call is a legitimate two-model workflow, but not in scope for this version.

## Feature Module: Auto-Tagger

### Triggers

- **Automatic:** Note saved (debounced ~5s). Vault scan on startup for untagged notes (batched).
- **Manual:** Command palette "Tag this note" / "Tag all untagged notes"

### Flow

1. Read note content and existing frontmatter
2. Fetch vault's current tag taxonomy (all tags in use) and user-defined style guide from `AI-Assistant/tag-config.md`
3. Build prompt: "Given this note and these existing tags, suggest tags. Prefer existing tags. Only propose new tags if nothing fits. Follow this style guide: [rules]"
4. Emit task to orchestrator — marked as **local-preferred**
5. On response: write suggested tags into `suggested-tags` frontmatter field (does NOT auto-apply)
6. Surface a notice: "3 tags suggested for [note] — review?" Clicking opens a modal showing suggestions with accept/reject per tag
7. On accept: move accepted tags from `suggested-tags` into `tags`, set `ai-tagged: true` in frontmatter, clear `suggested-tags`
8. On reject: move rejected tags into `rejected-tags` frontmatter field (prevents re-suggestion), clear `suggested-tags`
9. Partial accept: accepted tags go to `tags`, rejected go to `rejected-tags`, `suggested-tags` cleared either way

The tagger prompt includes the `rejected-tags` list so it avoids re-suggesting them. The `ai-tagged: true` marker distinguishes AI-tagged notes from manually tagged ones (useful for audit/review).

### Tag Audit (sub-feature)

- **Manual only:** Command palette "Audit tags"
- Scans all tags in vault, groups similar ones (e.g., `#project` vs `#projects`, `#ml` vs `#machine-learning`)
- Suggests merges/renames
- Presents a review UI — user approves each change
- Before applying: shows a dry-run preview listing all affected files per tag rename
- On apply: creates a timestamped backup of affected files in `AI-Assistant/backups/tag-audit-YYYY-MM-DD/` before performing vault-wide find-and-replace
- **claude-required** — needs stronger reasoning about semantic similarity

### Style Guide

- User defines rules in `AI-Assistant/tag-config.md` (e.g., "use kebab-case", "max depth 3", "always use singular form")
- If no config exists, plugin creates a sensible default on first activation
- Style guide is included in every tagging prompt

## Feature Module: Connection Detector

### Triggers

- **Automatic:** Runs periodically (configurable, default every 30 minutes) on recently modified notes
- **Manual:** Command palette "Find connections for this note" / "Scan vault for connections"

### Flow

1. For a given note, extract key concepts: tags, title words, frontmatter fields, and a keyword extraction pass (TF-IDF style — frequent words in this note that are infrequent across the vault)
2. **Candidate selection (no LLM needed):** Score every other note against the source using a weighted composite:
   - Tag overlap (shared tags / total tags) — weight: 0.4
   - Title similarity (word overlap) — weight: 0.2
   - Keyword overlap (shared extracted keywords) — weight: 0.3
   - Folder proximity (same folder or parent) — weight: 0.1
   - Exclude notes already linked from the source
   - Rank by composite score, take top 10 candidates (configurable)
   - Minimum score threshold: 0.15 (below this, no suggestion — avoids noise)
3. Send source note frontmatter + candidate summaries (title, tags, first 100 words) to LLM: "Which of these notes are meaningfully related? Suggest `[[wiki-links]]` and briefly explain why. Return only strong connections."
4. **Single-note scans:** local-preferred
5. **Vault-wide scans:** runs single-note scan for each recently modified note in sequence; claude-required only if user explicitly requests "deep scan" which sends more candidates (top 20) per note
6. Suggestions appear in a sidebar panel or modal: source note, suggested link, explanation, accept/dismiss buttons
7. Accepting inserts the `[[link]]` into the source note under a `## Related` heading

### Cost Optimization

Token savings come from aggressive candidate pre-filtering (step 2 is pure computation, no LLM) and sending only frontmatter + truncated summaries for the filtered candidates — smart data selection, not lossy compression.

## Feature Module: Dashboard

### The File

`Dashboard.md` — auto-generated and maintained by the plugin. Location is configurable in plugin settings: default is vault root (`/Dashboard.md`), can be changed to any path (e.g., `AI-Assistant/Dashboard.md`). User can set it as their Obsidian startup note.

### Sections

- **Goals** — pulled from user-maintained `AI-Assistant/goals.md`. The plugin doesn't invent goals, it keeps them visible.
- **Active Tasks** — aggregated from `- [ ]` items across vault notes. Ranked by due date and recency. Top N displayed.
- **Habit Tracker** — streak grid for user-defined habits (defined in `AI-Assistant/habits.md`). Text-based rendering, e.g., `[x][x][x][ ][x]`.
- **Recent Activity** — notes created/modified in the last N days, auto-tagged status, pending suggestions.

### Triggers

- **Automatic:** Regenerates on vault open and periodically (configurable, default every 2 hours)
- **Manual:** Command palette "Update dashboard"

### Model Routing

Entirely **local-capable**. Dashboard generation is mostly data aggregation and templating with light LLM summarization/prioritization.

### Update Behavior

- Plugin overwrites `Dashboard.md` on each regeneration — users should not manually edit it (warning comment at top)
- Source of truth is always the individual config files and vault notes

### Habit Tracking

- User defines habits in `AI-Assistant/habits.md` with name and frequency
- Tracking via command palette "Log habit" — presents a checklist modal of today's habits to check off
- Daily note checkbox scanning deferred to a future version (fragile — requires parsing arbitrary user-formatted notes)
- Completions recorded in `AI-Assistant/habit-log.md`

### Task Aggregation

- Scans vault for `- [ ]` items, optionally filtered by tag or folder
- Ranks by due date (parses `📅 YYYY-MM-DD` inline format) and recency
- No LLM needed — pure vault querying and sorting

## Orchestrator & Task Queue

### Task Structure

Each task carries:

- **id** — unique identifier
- **type** — source feature module (`tagger`, `connection-detector`, `dashboard`)
- **action** — specific operation (`tag-note`, `audit-tags`, `scan-connections`)
- **payload** — data needed (note path, note content, candidate list, etc.)
- **modelRequirement** — `local-only`, `local-preferred`, `claude-required`
- **trigger** — `automatic` or `manual`
- **priority** — `high` (manual/user-initiated), `normal` (automatic), `low` (background scans)
- **status** — `pending`, `in-progress`, `completed`, `deferred`, `failed`
- **retryCount** — number of times this task has been retried (default 0)
- **maxRetries** — maximum retry attempts before terminal failure (default 3)
- **error** — last error message (if failed or retrying)
- **created** — timestamp

### Routing Logic

1. **Check model requirement against availability:**
   - `local-only`: send to Ollama. If unavailable, defer.
   - `local-preferred`: try Ollama. If unavailable, check user setting — either defer or fall back to Claude (with a cost warning on first occurrence per session).
   - `claude-required`: send to Claude. If no API key configured, defer and notify user.

2. **Check cost budget:**
   - If daily/monthly cap would be exceeded, defer and notify: "Daily Claude budget reached. N tasks deferred."
   - Manual/high-priority tasks can optionally bypass the cap (user confirms per-task).

3. **Batch where possible:**
   - Multiple `tag-note` tasks combined into one prompt with all note contents. Single LLM call, results split back to individual notes.
   - Batching only within the same action type.
   - **Max batch size: 10 items.** If more are queued, process in sequential batches of 10.
   - **Token-aware batching:** before building a batch, estimate total prompt tokens. If adding another item would exceed 80% of the model's context window, stop the batch there. This prevents context overflow for notes with large bodies.

### Queue Persistence

- Tasks persisted to `AI-Assistant/queue.json` — survives Obsidian restarts
- On startup: load queue, reset any `in-progress` tasks to `pending` (they were interrupted, increment retryCount), resume processing
- Tasks that exceed `maxRetries` move to terminal `failed` state with their error message preserved. Failed tasks are surfaced in the dashboard's recent activity and can be manually retried via command palette.
- Completed tasks cleaned up after 24 hours (kept briefly for dashboard's recent activity)
- Failed tasks cleaned up after 7 days

### Concurrency

- One LLM call at a time — sequential, no parallel requests
- Queue processes in priority order, FIFO within same priority
- User-initiated tasks jump to the front

## LLM Service

### Common Interface

```typescript
interface LLMProvider {
  id: string;
  isAvailable(): Promise<boolean>;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

interface LLMRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
}

interface LLMResponse {
  content: string;
  tokensUsed: { input: number; output: number };
  model: string;
  durationMs: number;
}
```

### OllamaProvider

- Endpoint: `http://localhost:{port}/api/generate` (port configurable, default 11434)
- Health check: `GET /api/tags` on startup, then cached for 30 seconds (avoids per-call latency). Cache invalidated on error.
- Model: `llama3:8b` (configurable — any Ollama-compatible model works; users may prefer quantized or fine-tuned variants)
- Token counting: estimated from Ollama response metadata

### ClaudeProvider

- Uses the Anthropic TypeScript SDK (`@anthropic-ai/sdk`)
- API key stored in plugin settings (Obsidian encrypts plugin data at rest)
- Default model: `claude-haiku-4-5-20251001` for cost efficiency
- Configurable upgrade to `claude-sonnet-4-6` for tasks needing stronger reasoning (tag audit, vault-wide scans)
- Token counting: exact, from API response `usage` field

### Cost Tracker

- Persisted to `AI-Assistant/usage.json`
- Records per-call: timestamp, model, tokens in/out, estimated cost, task type
- Running totals: daily, monthly
- Exposed in plugin settings: "Today: $0.03 (1,200 in / 800 out) | This month: $0.45"
- Budget enforcement uses dollar amounts (user-facing) calculated from token counts and per-model pricing (maintained as a config constant, updated with SDK versions)
- Orchestrator reads this before dispatching Claude tasks to enforce budget caps

### Prompt Design Principles

- System prompts are concise and role-focused ("You are a note tagging assistant...")
- User content stripped to what's needed for the task — no unnecessary data sent
- Responses requested in structured JSON format for reliable parsing
- Each module defines a response schema and validates responses — max 1 retry on malformed response

## Configuration

### Plugin Settings (Obsidian Settings UI)

| Setting | Type | Default |
|---------|------|---------|
| Claude API Key | text (encrypted) | — |
| Claude Model | dropdown | Haiku |
| Claude Daily Budget | number (dollars) | unlimited |
| Claude Monthly Budget | number (dollars) | unlimited |
| Ollama Endpoint | text | `http://localhost:11434` |
| Ollama Model | text | `llama3:8b` |
| Dashboard location | text (path) | `/Dashboard.md` |
| Auto-tag on save | toggle | on (local-preferred) |
| Auto-tag on startup | toggle | on (local-preferred) |
| Auto-connection scan | toggle | on (local-preferred) |
| Connection scan interval | slider (min) | 30 |
| Auto-dashboard refresh | toggle | on |
| Dashboard refresh interval | slider (hours) | 2 |

Claude-calling auto-features are off by default and show a cost warning when enabled.

### AI-Assistant Vault Folder

```
AI-Assistant/
├── tag-config.md          # User-editable tag style guide
├── goals.md               # User-editable goals
├── habits.md              # User-editable habit definitions
├── habit-log.md           # Plugin-managed habit completions
├── queue.json             # Task queue persistence (versioned schema)
├── usage.json             # Claude API cost tracking (versioned schema)
└── backups/               # Tag audit backups (timestamped subdirectories)
```

User-editable files are created with sensible defaults on first plugin activation. Plugin-managed files carry a frontmatter warning against manual editing.

`Dashboard.md` lives at the path configured in plugin settings (default: vault root).

**Schema versioning:** `queue.json` and `usage.json` include a top-level `schemaVersion` field (starting at `1`). On plugin update, if the schema version is older than expected, the plugin runs a migration function before proceeding. This prevents data loss on plugin updates.

## Project Structure

```
obsidian-assistant/
├── src/
│   ├── main.ts                    # Plugin entry point, lifecycle
│   ├── settings.ts                # Settings tab UI and schema
│   ├── orchestrator/
│   │   ├── orchestrator.ts        # Queue processing, routing, batching
│   │   ├── task.ts                # Task type definitions
│   │   └── cost-tracker.ts        # Budget tracking
│   ├── llm/
│   │   ├── provider.ts            # LLMProvider interface
│   │   ├── ollama.ts              # Ollama implementation
│   │   └── claude.ts              # Claude implementation
│   ├── vault/
│   │   └── vault-service.ts       # Vault read/write abstraction
│   ├── modules/
│   │   ├── tagger/
│   │   │   ├── tagger.ts          # Auto-tag logic and prompts
│   │   │   └── tag-audit.ts       # Tag audit/cleanup
│   │   ├── connections/
│   │   │   └── connections.ts     # Connection detection
│   │   └── dashboard/
│   │       ├── dashboard.ts       # Dashboard generation
│   │       ├── habits.ts          # Habit tracking
│   │       └── tasks.ts           # Task aggregation
│   └── ui/
│       ├── suggestion-modal.ts    # Accept/reject suggestion UI
│       └── notices.ts             # Notification helpers
├── tests/
│   ├── orchestrator/
│   ├── llm/
│   ├── modules/
│   └── vault/
├── manifest.json
├── package.json
├── tsconfig.json
└── esbuild.config.mjs
```

## Error Handling

Each error scenario has a defined behavior — no silent failures.

| Scenario | Behavior |
|----------|----------|
| **Ollama returns malformed JSON** | Log the raw response, retry once with the same prompt. If retry also fails, mark task as failed with error message. |
| **Claude rate limit (429)** | Pause queue processing for the duration indicated by `retry-after` header (or 60s default). Notify user: "Claude rate limited — pausing for Ns." Resume automatically. |
| **Claude auth error (401)** | Pause all Claude tasks. Notify user: "API key invalid or expired — check plugin settings." Do not retry. |
| **Claude server error (5xx)** | Retry up to maxRetries with exponential backoff (1s, 4s, 16s). If all retries fail, mark task as failed. |
| **Ollama unavailable (connection refused)** | Mark provider as unavailable (cached 30s). For `local-preferred` tasks: check user fallback setting. For `local-only` tasks: defer. |
| **Note deleted between task creation and execution** | Detect missing file before LLM call. Silently discard the task (status: `completed` with a note that the source was deleted). |
| **Vault file locked by another plugin** | Retry write after 2s, up to 3 attempts. If still locked, mark task as failed: "Could not write to [note] — file locked." |
| **LLM response fails schema validation** | Retry once with an appended instruction: "Your previous response was not valid JSON. Respond only with valid JSON matching this schema: [schema]." If retry fails, mark task as failed. |
| **Cost budget exceeded mid-batch** | Complete the current LLM call (already in-flight). Defer remaining tasks in the batch. Notify user. |

Failed tasks are surfaced in the dashboard and can be retried manually via command palette "Retry failed tasks."

## Testing Strategy

### Core Principle

**Mocks replace external boundaries (HTTP calls, Obsidian API), never internal logic.** If a test can run against the real implementation, it must. Mocks exist solely to avoid network calls and Obsidian runtime dependencies, not to shortcut verification. Every test must exercise actual behavior — a test that mocks so aggressively that it only verifies its own setup is worse than no test.

### Unit Tests

- Feature modules tested with mocked LLM responses (HTTP boundary) and mocked vault state (Obsidian API boundary), but all module-internal logic (prompt building, response parsing, batching, frontmatter manipulation) runs for real
- Orchestrator tested with mock providers to verify routing logic, batching, deferral, and priority ordering — the queue, cost tracking, and task state management all run against real implementations
- Cost tracker tested for budget enforcement and persistence against real file I/O where possible
- LLM providers tested for correct HTTP request formatting and response parsing against mocked HTTP responses

### Integration Tests

- Module → Orchestrator → mock LLM provider: verify end-to-end task flow with real orchestrator logic
- Vault service against a temporary test vault

### Test Framework

- **Vitest** — fast, TypeScript-native, good ESM support. Standard in the Obsidian plugin community.

### What We Don't Test

- Obsidian's own APIs (we trust the platform)
- LLM output quality (prompt tuning is iterative, not automated)
- The Obsidian settings UI (manual verification)

### Manual Testing Checklist

Key user flows verified against a real vault with representative notes:
- Tag a single note, review and accept/reject suggestions
- Batch-tag untagged notes on startup
- Run tag audit, review and apply merge suggestions
- Find connections for a single note, accept a suggestion
- Vault-wide connection scan
- Dashboard generation with goals, tasks, habits
- Log a habit, verify streak display
- Task deferral when Ollama unavailable
- Cost budget enforcement and warnings
