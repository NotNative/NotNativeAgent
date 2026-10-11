@echo off
rem Policy-free entry: PowerShell execution policies (AllSigned prompts, Restricted
rem blocks) never see this - the real installer always runs with Bypass.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
