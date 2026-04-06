import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.database import init_db

app = FastAPI(title="SpeedReader API")

# CORS middleware — allow all origins for dev mode
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


IMAGES_DIR = "/workspace/data/images"
os.makedirs(IMAGES_DIR, exist_ok=True)


@app.on_event("startup")
async def startup():
    await init_db()
    os.makedirs("/workspace/data/uploads", exist_ok=True)


from backend.routers import publications, segments, progress, bookmarks, highlights

app.include_router(publications.router, prefix="/api/v1")
app.include_router(segments.router, prefix="/api/v1")
app.include_router(progress.router, prefix="/api/v1")
app.include_router(bookmarks.router, prefix="/api/v1")
app.include_router(highlights.router, prefix="/api/v1")


# Serve extracted comic/image pages
app.mount("/api/v1/images", StaticFiles(directory=IMAGES_DIR), name="images")


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


# Serve Vite build output in production
DIST_DIR = Path(__file__).resolve().parent.parent / "dist"

if DIST_DIR.is_dir():
    # Serve static assets (JS, CSS, manifest, etc.)
    app.mount("/assets", StaticFiles(directory=str(DIST_DIR / "assets")), name="assets")

    # Serve top-level static files (sw.js, manifest, icons, etc.)
    _TOP_LEVEL_STATIC = {
        f.name for f in DIST_DIR.iterdir() if f.is_file() and f.name != "index.html"
    }

    @app.exception_handler(404)
    async def spa_fallback(request: Request, exc):
        path = request.url.path.lstrip("/")
        # Serve top-level static files from dist
        if path in _TOP_LEVEL_STATIC:
            return FileResponse(str(DIST_DIR / path))
        # SPA fallback for non-API routes
        if not request.url.path.startswith("/api/"):
            return FileResponse(str(DIST_DIR / "index.html"))
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
