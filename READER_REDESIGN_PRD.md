# Reader Redesign PRD

A long-term redesign of the speed-reader's content model and reading experience. The goal is faithful representation of every book the user uploads, with two display modes (a clean speed-reader text view and a formatted view that respects the book's original structure), and a clean separation between the two without losing the speed-reading capabilities the app is built around.

This document is the source of truth for the redesign. It assumes a clean slate: the database will be wiped and books will be re-uploaded.

---

## 1. Goals

1. **Preserve everything in the source.** Front matter, copyright, table of contents, dedications, epigraphs, body, back matter — all of it. Nothing is filtered or auto-named.
2. **Two display modes per book.** Plain text (the existing speed-reader view) and Formatted (renders the book with its real structure). The user toggles between them at any time.
3. **One source of truth for "where am I."** Reading position is segment-based, regardless of which display mode is active. Switching modes lands you at the same place.
4. **Honest section names.** Section titles come from the book itself (NCX/PDF outline or actual headings). When neither exists, the section is labeled "Untitled" — never "Chapter 1" or "Section 3."
5. **Continuous reading by default.** The book reads end-to-end as one stream. A TOC sidebar lets users jump to sections.

## 2. Non-goals

- Search (deferred — no full-text search across the book or library)
- Bookmarks and highlights (removed — `db.bookmarks` and `db.highlights` go away)
- Migration of existing data (the DB will be wiped)
- Cloud sync, accounts, sharing

---

## 3. Content model

### 3.1 Sections

- A section is a unit of content **derived from the source's spine** (EPUB) or **outline** (PDF, if present). It's not derived from the NCX/TOC entries themselves.
- A book is an ordered list of sections. Sections are flat at the section level; hierarchy (if any) lives in the TOC sidebar (see §6.4), not in the section list.
- **EPUB:** one section per linear spine item. Non-linear spine items (`linear="no"`) are still included.
- **HTML / MD / TXT / RTF:** the whole document is one section.
- **DOCX:** one section per document; future work could split on `<h1>` boundaries.
- **FB2:** one section per top-level `<section>` in the source.
- **PDF with outline:** one section per top-level outline entry. The section spans from that entry's page to the next entry's page (exclusive).
- **PDF without outline:** the whole PDF is **one section**, named after the document title (or filename).
- **CBZ:** one section. CBZ is always rendered in formatted view (see §5.4).

### 3.2 Section titles

Resolved in this priority order:

1. The book's NCX / PDF outline entry that points to this spine item, if any.
2. The first `<h1>`, `<h2>`, or `<h3>` found in the spine item's content.
3. The literal string `"Untitled"`.

The string `"Untitled"` is never modified. We do not append numbers, file names, or fall-through labels like "Section 3."

### 3.3 No content filtering

The `SKIP_PATTERNS` regex in the EPUB parser (and any equivalent in other parsers) is removed. Cover pages, copyright, table of contents, dedication, "also by," "about the author," "praise for," etc. are all preserved as their own sections (named per §3.2). Sections shorter than 50 characters are still preserved — the current minimum-length filter is removed.

### 3.4 Cover image

For each book that has one, extract a cover image at upload time and store it alongside the book. Sources:

- **EPUB:** the manifest item with `properties="cover-image"`, or the item referenced by `<meta name="cover" content="...">` in the OPF. Fall back to the first image in the manifest if neither is present.
- **PDF:** render page 1 to a canvas at thumbnail size and store as PNG/JPEG.
- **CBZ:** the first image in the archive (sorted by filename).
- **DOCX / FB2:** the first inline image, if any.
- **HTML / MD / TXT / RTF:** no cover.

The cover (if present) is shown on the book card in the **Library** and **Archive** pages. If absent, the existing placeholder/treatment is used.

### 3.5 Storage strategy

**Parse once at upload, store both representations.** Each parser produces:

- A **structured representation** for formatted view:
  - For EPUB / HTML / MD / DOCX / FB2 / TXT / RTF: sanitized HTML per section, with inline images preserved at their source positions and headings preserved as `<h1>`/`<h2>`/`<h3>`.
  - For PDF: the original PDF file (already in OPFS) is the source; pages are rendered on demand by pdf.js.
  - For CBZ: the list of page images (already in OPFS).
- A **flat segment stream** for plain text view, derived from the same source. Each segment carries an offset into the structured representation so the two views can map to each other for progress tracking (see §7).

Both representations are written at upload time. There is no lazy re-parse path. Storage cost roughly doubles compared to today; this is acceptable.

The original file is also kept in OPFS (already done today) for cover extraction, PDF rendering, and any future re-processing.

---

## 4. Display modes

### 4.1 Top-level toggle

A single binary toggle switches the entire reader between **Plain text** and **Formatted**. The toggle lives in the **reader page header** (next to the back button and book title) and is visible at all times during reading.

The toggle persists **per book**. There is also a global setting **"Default display mode for new books"** in the Settings page (default: Plain text).

### 4.2 Plain text view

The existing speed-reader experience, with these formatting rules in Scroll mode:

- Paragraph breaks from the source are preserved (blank line between paragraphs).
- Section titles appear inline at the section boundary (see §6.2).
- Heading breaks (the existence of an `<h1>`/`<h2>`/`<h3>`) introduce extra vertical whitespace before/after, but the heading text itself uses the **default body font and size** — no styling, no bigger type, no bold.
- **Inline images are not shown** in plain text view.

In Phrase and RSVP modes, the chunked phrase / single word is shown the same as today; paragraph breaks and headings don't apply because only one phrase is visible at a time.

### 4.3 Formatted view

Renders the book using its original structure, themed with the **app's current theme** (Light, Dark, Evening, Bedtime, Forest, Ocean). The book's own CSS, colors, and fonts are not applied; only structure is preserved.

Per format:

- **EPUB / HTML / MD / DOCX / FB2 / TXT / RTF:** sanitized HTML rendered as a continuous scrollable column. Paragraphs, headings, italics, bold, blockquotes, lists, and inline images all appear. Images are **centered** with the preceding text above and following text below.
- **PDF:** real rendered PDF pages (pdf.js canvas) stacked vertically in continuous scroll. No pagination, no swipe — one long scroll through every page.
- **CBZ:** comic page images stacked vertically in continuous scroll.

All formats use **continuous scroll**. There is no paginated mode.

The formatted view uses the existing app font stack (Literata for body, Outfit for UI). Body text is rendered in a centered column constrained to a comfortable max width (target: ~680px on wide screens, edge-to-edge on mobile).

### 4.4 Reading mode interaction

The four reading modes (Phrase, RSVP, Scroll, Track) interact with the top-level toggle as follows:

| Reading mode | Plain text view | Formatted view |
|---|---|---|
| **Phrase** | One chunked phrase at a time (chunked-text source) | **Forced to plain text** — formatted view doesn't apply at the phrase level |
| **RSVP** | One word at a time (chunked-text source) | **Forced to plain text** — same reason |
| **Scroll** | Continuous flat text (per §4.2) | Continuous formatted HTML / PDF / CBZ |
| **Track** | Eye-tracked plain text scroll | Eye-tracked formatted scroll |

Practically, Phrase and RSVP **ignore the top-level toggle** — they always use plain text, since their visual unit (a phrase or word) has no meaningful "formatting." If the user is in formatted view and switches to Phrase or RSVP, the reader temporarily uses plain text rendering for the duration of those modes; switching back to Scroll or Track restores the formatted view.

### 4.5 CBZ exception

CBZ books always use formatted view. The top-level toggle is hidden for CBZ. Phrase, RSVP, Scroll, and Track all just step/scroll through the comic pages.

---

## 5. Reading state

### 5.1 Source of truth

Reading position is a **(book, segment_index)** pair, regardless of display mode. Segments are derived at parse time and stored in the database the same as today. Section boundaries are part of the segment metadata (each segment knows which section it belongs to).

### 5.2 Initial position

When a user opens a book for the first time, the reader starts at **segment 0** — the absolute first segment of the book. No auto-skip past front matter. (The user can manually navigate forward if they want to skip.)

When a user reopens a book, the reader resumes at the last segment they were on, the same as today.

### 5.3 Progress mapping between modes

When the user toggles from Plain text → Formatted (or vice versa), the reader keeps the same `segment_index` and scrolls the new view to the position that corresponds to that segment.

- **Plain text → Formatted:** the reader scrolls the formatted view to the element containing the segment's text.
- **Formatted → Plain text:** the reader inspects the visible portion of the formatted view, finds the segment whose text best matches the topmost visible text, and sets `segment_index` to that segment.

This requires segments to carry an offset into the structured representation (HTML element ID or character offset). That mapping is computed and stored at parse time.

### 5.4 Track mode in formatted view

Track mode works the same in formatted view as in plain text scroll: the user's gaze on the visible portion of the rendered HTML / PDF / CBZ controls scroll speed. The underlying segment cursor advances as new content scrolls into view (using the same Formatted → Plain text mapping from §5.3).

---

## 6. Navigation

### 6.1 Continuous reading

The book reads end-to-end as one continuous stream. There is no "you've reached the end of Chapter 3, tap to continue" gate. Section boundaries are crossed transparently during play.

### 6.2 Section title display at boundaries

When the reader crosses a section boundary in continuous play, **two things** happen:

1. **Inline title:** the new section's title appears inline as content. In formatted view, this is naturally the section's `<h1>`. In plain text view, the title is rendered on its own line with extra vertical whitespace, in the default body font and size (per §4.2).
2. **Persistent indicator:** a small "now reading" indicator at the top of the reader updates to show the current section's title. Visible at all times during reading. Subtle styling — small text, secondary color.

### 6.3 Section title in Phrase / RSVP modes

When entering a new section, the section title is shown as **its own segment** for one tick, then playback continues with the section's first content phrase. The persistent indicator at the top of the reader also updates.

### 6.4 TOC sidebar

A button in the reader header opens a TOC sidebar / sheet. Contents:

- One entry per section, in reading order.
- Entry display name follows §3.2 (NCX/outline → first heading → "Untitled").
- If the source's NCX (EPUB) or PDF outline is **hierarchical** (has nested entries), the sidebar renders the hierarchy as a tree with expand/collapse. The leaf entries map to actual sections; the parent entries are display-only groupings.
- If the NCX/outline is **flat** (or absent), the sidebar is a flat list.
- Tapping an entry jumps the reader to the first segment of that section.
- The current section is highlighted.

### 6.5 No bookmarks, no highlights

`db.bookmarks` and `db.highlights` are removed from the schema. The corresponding UI is removed from the reader.

---

## 7. Parser changes

Each parser is updated to produce both representations described in §3.5. Concretely, the new `ParsedBook` shape grows:

```ts
interface ParsedBook {
  title: string
  author: string
  cover?: { blob: Blob; mimeType: string }   // NEW: §3.4
  sections: ParsedSection[]                   // RENAMED from chapters
}

interface ParsedSection {
  title: string                               // §3.2 — never auto-numbered
  // Plain text representation
  text: string                                // flat text for chunker
  // Structured representation for formatted view
  html: string                                // sanitized HTML, or empty for PDF/CBZ
  // Maps segment offsets in `text` to positions in `html`
  // (computed at chunk time, not parser time)
}
```

`inlineImages` moves into the `html` field — images are referenced by their original `<img src>` and resolved to the correct blob via the manifest. The placeholder (`{{IMG_N}}`) approach used today is removed; in plain text view, images simply don't appear (per §4.2).

Per-format parser changes:

- **EPUB:** stop using `SKIP_PATTERNS` and the 50-char minimum. Stop renaming "Section 1" / "Chapter 1." Emit one section per linear+nonlinear spine item. Capture the cover image. Sanitize HTML for the formatted view.
- **PDF:** capture the outline. If present, sections = top-level outline entries. If absent, one section. Keep the original PDF in OPFS and render via pdf.js for formatted view. Capture page 1 as cover.
- **HTML / MD / TXT / RTF / FB2 / DOCX:** one section (or per-`<section>` for FB2). Sanitize and preserve HTML. Capture first inline image as cover where available.
- **CBZ:** one section. Always formatted view. Capture first image as cover.

The DOMParser-in-worker issue we hit earlier is moot — parsing already runs on the main thread today.

---

## 8. Schema changes

Wipe and recreate. The new tables:

- **publications:** add `cover_blob_id?` (FK to a blob store) and `display_mode_pref?` ('plain' | 'formatted').
- **sections:** new table replacing today's `chapters`. Fields: `id`, `publication_id`, `index`, `title`, `text`, `html`.
- **segments:** today's table, with one new field: `html_anchor` (an HTML element ID or character offset into `sections.html` for the §5.3 mapping).
- **drop:** `bookmarks`, `highlights`.
- **settings:** add `default_display_mode` ('plain' | 'formatted', default 'plain').

OPFS layout is unchanged: `/books/{pubId}/original.{ext}` continues to exist.

---

## 9. UI changes

### 9.1 Library and Archive

- Book card displays the cover image (§3.4) if available, else current placeholder.

### 9.2 Reader header

- New: top-level **Plain ↔ Formatted** toggle (§4.1).
- New: TOC button that opens the sidebar (§6.4).
- New: persistent "now reading" section indicator (§6.2).
- Existing: back button, book title.

### 9.3 Reader controls (bottom sheet)

- Mode dropdown still has Phrase, RSVP, Scroll, Track. **Image** mode is removed (CBZ now uses formatted view per §4.5).
- Behavior of Phrase/RSVP is forced to plain text per §4.4.
- Play/pause, speed, etc. unchanged.

### 9.4 Settings

- Add **Default display mode for new books** (Plain / Formatted).
- Remove anything related to bookmarks/highlights.

### 9.5 What's unchanged

- Theme system (Light/Dark/Evening/Bedtime/Forest/Ocean)
- Speed/WPM controls
- Wake lock during reading
- Audio cues / haptics (if any)
- Font stack (Literata + Outfit)

---

## 10. Open questions / future work

These are intentionally deferred:

- Search (full-text within a book and across the library)
- Highlights / annotations (a different model than today's segment-range highlights)
- Sync across devices
- Audio narration / TTS
- Reader settings: line height, font, column width overrides
- Sub-section splitting for very long DOCX / single-file HTML
- Hierarchical sections beyond the TOC sidebar (e.g., the persistent indicator showing "Part Two › Chapter 5")

---

## 11. Migration

The database will be wiped on the first run with the new schema. Users re-upload their books. There is no migration script.
