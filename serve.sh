#!/bin/bash
# Starts a local server for the ESA Lower Third system.
#
# Usage:
#   ./serve.sh
#
# Then:
#   1. In OBS, add a Browser Source pointing to: http://localhost:8080/source.html
#   2. Open http://localhost:8080/control.html in your browser
#
PORT=8080
echo ""
echo "  ESA Lower Third Server"
echo "  ======================"
echo ""
echo "  Source (OBS Browser Source): http://localhost:$PORT/source.html"
echo "  Control Panel:              http://localhost:$PORT/control.html"
echo ""
echo "  Press Ctrl+C to stop."
echo ""
cd "$(dirname "$0")"
python3 -m http.server $PORT
