#!/bin/sh
set -e

echo "🚀 Starting Conway services..."

# Ensure data directory exists and is writable
mkdir -p /app/data
chmod 755 /app/data
echo "✓ Data directory ready: /app/data"

# Clear Redis queue if Redis is configured
if [ -n "$REDIS_URL" ]; then
  echo "🧹 Clearing Redis queue..."
  # Extract Redis connection details and run FLUSHDB
  redis-cli -u "$REDIS_URL" FLUSHDB 2>/dev/null && echo "✓ Redis queue cleared" || echo "⚠️  Redis clear failed (may not exist yet)"
fi

# Clear SQLite database
DB_PATH="${DB_PATH:-/app/data/conway.db}"
if [ -f "$DB_PATH" ]; then
  echo "🧹 Clearing database at $DB_PATH..."
  rm -f "$DB_PATH"
  echo "✓ Database cleared"
fi

# Start ML Service
echo "Starting ML Service on port 5001..."
cd /app/backend/ml-service
python3 app.py 2>&1 &
ML_PID=$!
echo "ML Service PID: $ML_PID"

# Wait for ML service
sleep 5

# Start Express Backend
echo "Starting Express Backend on port ${PORT}..."
cd /app/backend
npx tsx server.ts 2>&1 &
BACKEND_PID=$!
echo "Backend PID: $BACKEND_PID"

# Start Poller
echo "Starting Poller..."
npx tsx poller.ts 2>&1 &
POLLER_PID=$!
echo "Poller PID: $POLLER_PID"

echo "✅ All services started"
echo "ML: $ML_PID, Backend: $BACKEND_PID, Poller: $POLLER_PID"

# Monitor all processes - exit if any dies
while true; do
  for pid in $ML_PID $BACKEND_PID $POLLER_PID; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Process $pid exited, shutting down..."
      kill $ML_PID $BACKEND_PID $POLLER_PID 2>/dev/null
      exit 1
    fi
  done
  sleep 2
done
