# Anki Card Suggestions & Persistent Suggestions Panel — Design Spec

## Overview

Two integrated features for the Obsidian AI Assistant plugin:

1. **Anki Card Suggestion Module** — uses Claude to generate high-yield flashcards from note content, presented for user approval before insertion
2. **Persistent Suggestions Panel** — a sidebar view that aggregates all suggestion types (tags, connections, Anki cards) with contextual filtering by active note

The suggestions panel is the delivery mechanism for Anki cards and replaces the ephemeral toast-based notification flow for all existing suggestion types.

## Anki Card Module

### Triggers

- **Manual:** Command palette "Suggest Anki cards for this note"
- **Automatic (opt-in):** On note save, debounced 10s. Off by default — requires explicit enable in settings with cost warning.

### Flow

1. Read note content and frontmatter
2. Check if note already has a `## Flashcards` section — include existing cards in the prompt to avoid duplicates
3. Build prompt with full note content, existing cards, user's format preference, and instruction to return structured JSON
4. Emit task to orchestrator — **claude-required**
5. On response: parse suggested cards, emit each as a `Suggestion` with `type: "anki-card"` and `editable: true` into the suggestions store
6. User reviews in the panel — can edit card text inline, accept, or dismiss
7. On accept: append the card markdown to the source note under `## Flashcards` heading (creates the heading if it doesn't exist)

### Model Routing

Always **claude-required**. An 8B local model cannot reliably identify what's worth remembering or formulate good pedagogical questions. This is a single Claude call per note — no back-and-forth.

### Prompt Design

Single call per note. The prompt includes:
- Full note content
- Any existing cards under `## Flashcards` (to avoid duplicates)
- User's preferred card format setting (both, basic-only, or cloze-only)
- Instruction to return JSON:

```json
{
  "cards": [
    { "type": "basic", "front": "What is X?", "back": "X is Y" },
    { "type": "cloze", "text": "The capital of France is {{c1::Paris}}." }
  ]
}
```

System prompt: "You are a spaced repetition expert. Analyze the note and suggest high-yield flashcards that test understanding, not just recall. Focus on concepts worth remembering long-term. Avoid trivial or surface-level cards. Respond with valid JSON only."

### Card Insertion Format

Accepted cards are appended under `## Flashcards` at the bottom of the source note:

```markdown
## Flashcards

Capital of France::Paris

The largest planet in our solar system is {{c1::Jupiter}}.
```

- Basic cards: `Front::Back` on a single line
- Cloze cards: `{{c1::...}}` syntax inline
- One blank line between cards for readability
- The `## Flashcards` heading is created if it doesn't exist

### Card Location Setting

- **Global setting:** "Card location" — `in-note` (default) or `separate-file`
- `in-note`: cards go under `## Flashcards` in the source note
- `separate-file`: cards go to `AI-Assistant/cards/{note-basename}-cards.md`
- **On setting change:** plugin queues a migration task through the orchestrator that moves existing `## Flashcards` sections to/from separate files. A confirmation notice is shown before executing. Migration is a background task processed by the orchestrator.

### Anki Plugin Detection

On startup and when Anki features are first enabled, check for the Obsidian-to-Anki plugin:

```typescript
const ankiPlugin = this.app.plugins.getPlugin("obsidian-to-anki-plugin");
```

Three states:

| State | Behavior |
|-------|----------|
| **Installed & enabled** | Full functionality, no warnings |
| **Installed but disabled** | One-time notice: "Enable the Obsidian-to-Anki plugin to sync cards to Anki." |
| **Not installed** | Setup guide pinned at top of suggestions panel: install Obsidian-to-Anki from community plugins, install AnkiConnect add-on in Anki (code `2055492159`), have Anki running when syncing |

Card suggestion and insertion works regardless of plugin status — the markdown is valid study material either way. Detection only controls whether the setup guide is shown.

## Persistent Suggestions Panel

### Suggestion Data Model

```typescript
interface Suggestion {
  id: string;
  type: "tag" | "connection" | "anki-card";
  sourceNotePath: string;
  title: string;
  detail: string;
  editable?: string;             // for Anki cards: the card text, user can edit before accepting
  created: number;
  status: "pending" | "accepted" | "dismissed";
}
```

### Persistence

- Stored in `AI-Assistant/suggestions.json` (versioned schema, same pattern as `queue.json`)
- Pending suggestions survive Obsidian restarts
- Accepted and dismissed suggestions cleaned up after 24 hours

### Sidebar View

An Obsidian `ItemView` registered as a right-sidebar leaf with two sections:

**1. Current Note**
- Filters suggestions where `sourceNotePath` matches the active note
- Updates dynamically when the user switches notes
- Shows "No suggestions for this note" when empty

**2. All Pending**
- Grouped by type: Tags, Connections, Cards
- Collapsed by default with count badges
- Expanding a group shows all pending suggestions of that type

### Suggestion Row UI

Each suggestion row displays:
- Title + detail preview
- For Anki cards: an inline editable text area showing the card content (user can modify before accepting). Edits update the `editable` field on the Suggestion in the store. The edited text is what gets inserted into the note on acceptance — not the original LLM output.
- Accept button (checkmark) / Dismiss button (X)
- Clicking the title navigates to the source note

### Migration from Toasts

Existing tag and connection suggestion flows currently use `showClickableNotice` → `SuggestionModal`. Migration path:

- Modules emit suggestions into the suggestions store instead of triggering toasts directly
- The panel replaces the modal for accept/reject interactions
- A compact toast still fires as a notification: "3 new suggestions — check the panel" (dismissible, links to panel)
- The `SuggestionModal` remains available as a fallback when the panel is closed or for bulk operations

### Suggestion Acceptance Handlers

When a suggestion is accepted in the panel, the handler depends on the type:

| Type | On Accept |
|------|-----------|
| `tag` | Move tag from `suggested-tags` to `tags` in frontmatter, set `ai-tagged: true` |
| `connection` | Insert `[[link]]` under `## Related` heading in source note |
| `anki-card` | Append card markdown (possibly user-edited) under `## Flashcards` in source note (or separate file per setting) |

When dismissed:

| Type | On Dismiss |
|------|------------|
| `tag` | Move tag to `rejected-tags` in frontmatter |
| `connection` | Remove from suggestions store (no vault change) |
| `anki-card` | Remove from suggestions store (no vault change) |

## Configuration

### Settings (Obsidian Settings UI)

Anki settings section is **only visible when the Anki enable toggle is on**.

| Setting | Type | Default |
|---------|------|---------|
| Enable Anki card suggestions | toggle | off |
| Auto-suggest cards on save | toggle | off (cost warning when enabled) |
| Card format | dropdown: Both / Basic only / Cloze only | Both |
| Card location | dropdown: In-note / Separate file | In-note |

### New Files

```
AI-Assistant/
├── suggestions.json              # Suggestions store (versioned schema)
└── cards/                        # Separate card files (when card location = separate-file)
    └── {note-basename}-cards.md
```

## Project Structure (New/Modified Files)

```
src/
├── modules/
│   └── anki/
│       ├── anki.ts               # AnkiModule: prompt building, response parsing, card formatting
│       └── card-migration.ts     # Handles moving cards between in-note and separate-file
├── suggestions/
│   ├── store.ts                  # SuggestionsStore: CRUD, persistence, filtering
│   └── panel.ts                  # SuggestionsPanel: Obsidian ItemView, sidebar rendering
├── ui/
│   └── suggestion-modal.ts       # (existing, kept as fallback)
├── main.ts                       # (modified: register panel, add Anki commands/triggers, wire acceptance handlers)
└── settings.ts                   # (modified: add Anki settings section with conditional visibility)

tests/
├── modules/
│   ├── anki.test.ts
│   └── card-migration.test.ts
├── suggestions/
│   └── store.test.ts
└── integration/
    └── anki-flow.test.ts
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Claude returns malformed JSON for cards | Retry once with corrective prompt. If retry fails, mark task failed, notify user in panel. |
| Note deleted before card insertion | Check note exists before writing. If deleted, remove pending suggestions for that note. |
| Card location set to separate-file but cards/ folder missing | Create `AI-Assistant/cards/` folder on first write. |
| Migration fails mid-way (e.g., note locked) | Migration task retries per orchestrator retry logic. Partially migrated state is safe — cards exist in one location or both, never lost. |
| Obsidian-to-Anki plugin not found | Show setup guide in panel. Cards still work as markdown. |

## Testing Strategy

### Core Principle

Same as the main plugin: mocks replace external boundaries (HTTP calls, Obsidian API), never internal logic.

### Unit Tests

- **Anki module:** prompt building (with/without existing cards, all format settings), response parsing (basic, cloze, mixed, malformed JSON), card markdown generation
- **Suggestions store:** add/get/update/dismiss/cleanup, filtering by note path, filtering by type, persistence round-trip, schema versioning
- **Card migration:** moving cards from in-note to separate file and back, handling notes without existing cards

### Integration Tests

- Anki module → orchestrator → mock Claude → suggestions store: full flow from note content to pending suggestion
- Suggestion acceptance → vault write: verify card markdown appears correctly under `## Flashcards`

### What We Don't Test

- Sidebar view rendering (Obsidian UI — manual verification)
- Obsidian-to-Anki plugin detection (depends on Obsidian runtime)
- Actual Anki sync (other plugin's responsibility)

### Manual Testing Checklist

- Suggest cards for a note, review in panel, accept/edit/dismiss
- Verify cards appear under `## Flashcards` heading correctly
- Verify existing cards aren't duplicated on re-run
- Switch card location setting, verify migration runs correctly
- Verify panel updates when switching active notes
- Verify panel shows tag/connection suggestions after migration
- Verify Anki settings section hidden when feature disabled
- Verify setup guide appears when Anki plugin not installed
- Verify auto-suggest on save with debounce works
