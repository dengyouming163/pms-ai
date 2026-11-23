# 本地一键启动健康检查（Windows PowerShell 版）
# 依次等待 pms-server / pms-agent / pms-web，每个最多 60 秒（间隔 2 秒）。
# 任一失败则打印该服务最近 50 行日志并退出 1。
$ErrorActionPreference = 'Continue'

function Test-Service {
    param([string]$Name, [string]$Url, [string]$Expect, [string]$Service)
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $body = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $Url).Content
            if ([string]::IsNullOrEmpty($Expect) -or $body.Contains($Expect)) {
                Write-Host "[ok] $Name -> $Url"
                return $true
            }
        } catch {
            # 服务还没起来，继续轮询
        }
        Start-Sleep -Seconds 2
    }
    Write-Host "[fail] $Name -> $Url" -ForegroundColor Red
    docker compose logs --tail=50 $Service
    return $false
}

if (-not (Test-Service 'pms-server' 'http://localhost:9090/health' '"status":"ok"' 'pms-server')) { exit 1 }
if (-not (Test-Service 'pms-agent' 'http://localhost:8000/health' '"ok":true' 'pms-agent')) { exit 1 }

$webPort = $env:WEB_PORT
if ([string]::IsNullOrEmpty($webPort)) { $webPort = '3000' }
if (-not (Test-Service 'pms-web' "http://localhost:$webPort" '' 'pms-web')) { exit 1 }

Write-Host 'all services healthy'
