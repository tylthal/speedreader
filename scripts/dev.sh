#!/usr/bin/env bash
set -e

echo "Starting SpeedReader dev environment..."
echo "Backend: http://localhost:3000"
echo "Frontend: http://localhost:5173"
echo ""

# Install deps if needed
if [ ! -d "node_modules/.vite" ]; then
  echo "Installing npm dependencies..."
  npm install
fi

pip install -q -r requirements.txt 2>/dev/null

# Start backend
uvicorn backend.main:app --host 0.0.0.0 --port 3000 --reload &
BACKEND_PID=$!

# Start frontend
npm run dev -- --host 0.0.0.0 &
FRONTEND_PID=$!

# Cleanup on exit
cleanup() {
  echo "Shutting down..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

wait
