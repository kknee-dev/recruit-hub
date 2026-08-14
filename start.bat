@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo [OK] 已创建 .env（默认配置）
)
set "DB=%USERPROFILE%\.xiaozhaobao\xzb.db"
if not exist "%DB%" (
  mkdir "%USERPROFILE%\.xiaozhaobao" >nul 2>&1
  copy examples\seed.sqlite "%DB%" >nul
  echo [OK] 已加载演示数据
)
echo 启动: http://localhost:3600
node app/server.js
