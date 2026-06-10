@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo.
echo ╔══════════════════════════════════════════╗
echo ║   Serenity Views — 每日更新脚本        ║
echo ╚══════════════════════════════════════════╝
echo.

REM 检查是否有新的 JSON 文件
set JSON_FILE=
for %%f in (scraper\serenity_tweets_*.json) do set JSON_FILE=%%f

if "%JSON_FILE%"=="" (
    echo ❌ 未找到抓取的 JSON 文件！
    echo.
    echo 📋 请先执行以下步骤：
    echo    1. 浏览器打开 https://x.com/aleabitoreddit
    echo    2. 按 F12 → Console
    echo    3. 复制粘贴 scraper\x_scraper.js 全部内容
    echo    4. 按回车，等待自动下载 JSON
    echo    5. 把下载的 JSON 文件移到 scraper\ 目录下
    echo    6. 重新运行本脚本
    echo.
    pause
    exit /b 1
)

echo 📖 找到数据文件: %JSON_FILE%
echo.

REM 运行 Python 转换脚本
echo 🔄 正在转换数据...
C:\Users\77909\.workbuddy\binaries\python\versions\3.13.12\python.exe scraper\generate_data.py "%JSON_FILE%"

if %ERRORLEVEL% NEQ 0 (
    echo ❌ 数据转换失败
    pause
    exit /b 1
)

echo.
echo 📤 准备推送到 GitHub...

REM 检查 Git 状态
git status --short

echo.
echo ⚠️  即将执行 git add data.js && git commit && git push
echo.
set /p CONFIRM="确认推送? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo ⏭️  已取消推送
    pause
    exit /b 0
)

git add data.js
git commit -m "Update Serenity views data - %date%"
git push

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ 更新成功！等待 1-2 分钟后刷新网站：
    echo    https://kingszero.github.io/serenity-views/
) else (
    echo.
    echo ❌ 推送失败，请检查 Git 配置
)

echo.
pause
