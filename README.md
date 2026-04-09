# SpeedReader

Mobile-first speed-reading ebook reader built with React, Vite, IndexedDB, and OPFS. The app runs fully client-side: books are parsed in-browser, stored locally, and reopened from the local library without a backend service.

## What The App Does

- Import local books in formats including EPUB, PDF, DOCX, FB2, HTML, Markdown, TXT, RTF, and CBZ.
- Store publication metadata, chapters, segments, progress, and archive state locally on-device.
- Read in phrase, RSVP, scroll, or track modes with persisted progress and per-book display mode.
- Provide a formatted reading view, TOC navigation, archive management, offline-friendly storage, and PWA/native packaging support.

## Development

```bash
npm run dev
```

The default dev server runs on `http://127.0.0.1:5173/` unless you override the host or port.

## Useful Commands

```bash
npm run build
npm run test:e2e
npm run test:e2e:reader
npm run validate:browser
```

- `test:e2e` runs the default Playwright smoke flow against the local app.
- `test:e2e:reader` runs the larger TOC-navigation reader pass.
- `validate:browser` runs the repo's headless Playwright browser pass over books in `testbook/`.

## Manual Smoke Flow

1. Open the Library page.
2. Upload a supported book file.
3. Wait for the reader to open.
4. Toggle playback or switch reading modes.
5. Return to Library, Archive, and Settings to confirm navigation still works.
