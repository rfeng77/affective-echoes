#!/bin/bash
# Double-click to start. Keep this window open during the session; close it to stop.
cd "$(dirname "$0")"
echo "Starting Affective Echoes... Chrome will open in a moment."
DETECTOR_DIR="$(dirname "$PWD")/emotion_detector"
LIGHTMER_PID=""
if ! curl -fsS http://127.0.0.1:8770/api/health >/dev/null 2>&1; then
  if [[ -x "$DETECTOR_DIR/run_lightmer.command" ]]; then
    echo "Starting the local Light-MER emotion detector..."
    nohup "$DETECTOR_DIR/run_lightmer.command" >/tmp/affective-echoes-lightmer.log 2>&1 &
    LIGHTMER_PID=$!
  fi
fi
echo "Waiting for Light-MER and local Whisper to finish loading..."
LIGHTMER_READY=0
for i in {1..300}; do
  if curl -fsS http://127.0.0.1:8770/api/health 2>/dev/null | grep -q '"status": "ready"'; then
    LIGHTMER_READY=1
    break
  fi
  sleep 1
done
if [[ "$LIGHTMER_READY" -eq 0 ]]; then
  echo "Light-MER did not become ready. Check /tmp/affective-echoes-lightmer.log"
else
  echo "Light-MER and local Whisper are ready."
fi
stop_lightmer() { [[ -n "$LIGHTMER_PID" ]] && kill "$LIGHTMER_PID" >/dev/null 2>&1; }
trap stop_lightmer EXIT INT TERM
python3 server.py || { echo; echo "Something went wrong. Check that Python 3 is installed: https://www.python.org"; read -n 1 -s -r -p "Press any key to close."; }
