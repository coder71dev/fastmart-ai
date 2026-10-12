# Restores the production n8n Postgres dump into the local stack.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\restore-n8n.ps1
$ErrorActionPreference = 'Stop'
$dump  = 'C:\Users\monar\Downloads\n8n-2026-10-12.sql.gz'
$store = 'https://stg-admin.perfectobd.com'
Set-Location $PSScriptRoot
if (-not (Test-Path $dump)) { throw "Dump not found: $dump" }

# 1. point the store at staging (keeps every other .env value)
$env = Get-Content .env -Raw
if ($env -match '(?m)^STORE_BASE_URL=') { $env = $env -replace '(?m)^STORE_BASE_URL=.*$', "STORE_BASE_URL=$store" }
else { $env += "`nSTORE_BASE_URL=$store`n" }
Set-Content .env $env -NoNewline

# 2. start only Postgres and wait for it
docker compose up -d postgres
do { Start-Sleep 2; docker exec fastmart-n8n-postgres pg_isready -U n8n *> $null } until ($LASTEXITCODE -eq 0)

# 3. recreate the database and restore
docker exec fastmart-n8n-postgres psql -U n8n -d postgres -c "DROP DATABASE IF EXISTS fastmart_n8n WITH (FORCE);" -c "CREATE DATABASE fastmart_n8n OWNER n8n;"
cmd /c "docker exec -i fastmart-n8n-postgres sh -c ""gunzip | psql -U n8n -d fastmart_n8n -q"" < ""$dump"""

# 4. sanity check, then start everything
docker exec fastmart-n8n-postgres psql -U n8n -d fastmart_n8n -tc "select count(*) as workflows from workflow_entity;"
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
Write-Host "Done. Open http://localhost:5678 (login = production n8n owner account)."
