# SpeedReader

Mobile-first speed-reading ebook web app (PWA).

## Quick Start

```bash
# Development (both servers)
bash scripts/dev.sh

# Or run separately:
uvicorn backend.main:app --host 0.0.0.0 --port 3000 --reload  # Backend
npm run dev                                                       # Frontend

# Production build
npm run build
uvicorn backend.main:app --host 0.0.0.0 --port 3000
```

## Usage

1. Open http://localhost:5173 (dev) or http://localhost:3000 (production)
2. Upload an EPUB file from the Library page
3. Click a book to open the reader
4. Tap to play/pause, swipe up/down to adjust speed
