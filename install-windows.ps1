# KDS для Poster: установка на компьютер с Windows (режим локальной сети).
# Запускается из INSTALL-WINDOWS.cmd. Повторный запуск обновляет систему; данные и пароли сохраняются.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Say($text) { Write-Host "`n-> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`n$text" -ForegroundColor Red; Read-Host 'Нажмите Enter, чтобы закрыть'; exit 1 }
function Rand($n) { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count $n | ForEach-Object { [char]$_ }) }

# Docker Desktop runs the same containers as on a Linux server.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Start-Process 'https://www.docker.com/products/docker-desktop/'
  Fail "Нужен Docker Desktop. Страница загрузки открыта в браузере: установите его, перезагрузите компьютер, запустите Docker Desktop и снова откройте INSTALL-WINDOWS.cmd."
}
$ErrorActionPreference = 'Continue'
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop не запущен. Откройте его, дождитесь надписи «Engine running» и снова откройте INSTALL-WINDOWS.cmd.' }

# The address tablets and the TV use on the local network.
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|VirtualBox|VMware' } |
  Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = 'localhost' }

if (-not (Test-Path .env)) {
  Say 'Настройка (один раз)'
  $token = Read-Host 'Токен Poster («Доступ» -> «Интеграция»). Enter — пропустить и добавить позже'
  $account = Read-Host 'Имя аккаунта Poster (то, что стоит перед .joinposter.com)'
  $type = Read-Host 'Тип заведения: bar, restaurant или fastfood [fastfood]'
  if (-not $type) { $type = 'fastfood' }
  $set = @{
    APP_SECRET = (Rand 40); DB_PASSWORD = (Rand 32); PLATFORM_PASSWORD = (Rand 12); ADMIN_PASSWORD = (Rand 10)
    PUBLIC_URL = "http://$ip"; DOMAIN = ''; POSTER_TOKEN = $token.Trim(); POSTER_ACCOUNT = $account.Trim(); VENUE_TYPE = $type.Trim()
  }
  $out = foreach ($line in (Get-Content .env.example -Encoding UTF8)) {
    if ($line -match '^([A-Z_]+)=' -and $set.ContainsKey($Matches[1])) { "$($Matches[1])=$($set[$Matches[1]])" } else { $line }
  }
  [IO.File]::WriteAllLines((Join-Path $PSScriptRoot '.env'), $out)
}
New-Item -ItemType Directory -Force -Path backups | Out-Null

Say 'Сборка и запуск. В первый раз 5-10 минут'
docker compose --env-file .env up -d --build
if ($LASTEXITCODE -ne 0) { Fail 'Docker не смог запустить систему. Если занят порт 80 (Skype, IIS), закройте эту программу и запустите снова.' }

Say 'Жду, пока система поднимется'
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try { if ((Invoke-WebRequest 'http://localhost/health' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $ok = $true; break } } catch { }
  Start-Sleep -Seconds 2
}
if (-not $ok) { Fail 'Система не ответила за 3 минуты. Посмотрите журнал: docker compose logs app' }

$envMap = @{}
Get-Content .env -Encoding UTF8 | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $envMap[$Matches[1]] = $Matches[2] } }
$login = if ($envMap.POSTER_ACCOUNT) { $envMap.POSTER_ACCOUNT } else { '1' }

Write-Host "`nГотово, система работает." -ForegroundColor Green
Write-Host "  Админка:          http://localhost/admin/   (заведение «$login», пароль $($envMap.ADMIN_PASSWORD))"
Write-Host "  Экран кухни/бара: http://$ip/kds/   — откройте на планшете в той же сети Wi-Fi"
Write-Host "  Демо для клиента: http://$ip/demo/"
Write-Host "  Платформа:        http://localhost/platform/   (пароль $($envMap.PLATFORM_PASSWORD))"
if (-not $envMap.POSTER_TOKEN) { Write-Host "  Токен Poster не указан: добавьте заведение в /platform/ (кнопка «Добавить заведение»)." -ForegroundColor Yellow }
Write-Host "  Пароли сохранены в файле .env в этой папке."
Write-Host "  Если Windows спросит про доступ к сети для Docker — разрешите, иначе планшеты не подключатся."
Start-Process 'http://localhost/admin/'
Read-Host "`nНажмите Enter, чтобы закрыть это окно (система продолжит работать)"
