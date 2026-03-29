import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


# Serve Vite build output in production
DIST_DIR = Path(__file__).resolve().parent.parent / "dist"

if DIST_DIR.is_dir():
    # Mount static files — mounts are checked AFTER all explicit routes,
    # so API routes always take priority. html=True serves index.html as
    # the fallback for SPA client-side routing.
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")
