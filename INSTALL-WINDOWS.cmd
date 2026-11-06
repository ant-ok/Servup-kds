@echo off
chcp 65001 >nul
rem KDS for Poster: double-click to install or update on Windows
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
