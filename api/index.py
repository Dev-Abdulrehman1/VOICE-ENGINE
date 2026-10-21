"""Vercel entrypoint.

Vercel's Python runtime looks for a FastAPI instance named `app` at a recognised
entry file (api/index.py is one). The real app lives in backend/main.py so the
project can still be run locally with `uvicorn backend.main:app`.
"""

from backend.main import app  # noqa: F401
