@echo off
REM Clipper auf dem Gaming-PC starten (Docker Desktop mit NVIDIA-GPU)
cd /d "%~dp0"
where docker >nul 2>&1 || (echo Docker Desktop fehlt: https://www.docker.com/products/docker-desktop/ & pause & exit /b 1)
if not exist .env copy .env.example .env >nul
echo Baue und starte Clipper (beim ersten Mal dauert das einige Minuten) ...
docker compose up -d --build
if errorlevel 1 (pause & exit /b 1)
echo.
echo Clipper laeuft: http://localhost:8000
echo Logs: docker compose logs -f clipper   ^|   Stoppen: docker compose down
timeout /t 5 >nul
start "" http://localhost:8000
