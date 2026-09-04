#!/bin/bash
cd "$(dirname "$0")"
echo "http://127.0.0.1:8799"
python3 -m http.server 8799 --bind 127.0.0.1
