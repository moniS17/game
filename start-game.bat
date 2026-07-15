@echo off
title Battlegrid Server
echo Starting Battlegrid on http://localhost:8080 ...
start "" http://localhost:8080
python -m http.server 8080
