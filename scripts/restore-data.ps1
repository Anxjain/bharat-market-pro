# Load the bundled starter dataset into a fresh Bharat Market Pro install (Windows).
#
#   powershell -ExecutionPolicy Bypass -File scripts\restore-data.ps1
#
# This is the PowerShell twin of restore-data.sh, so a Windows machine needs no
# Git Bash / WSL to get set up. Both scripts do exactly the same thing:
#
#   • data\bharat_market_pro_data.sql.gz — the full research database: NSE prices,
#     filings, news, ULIP fund data with holdings, computed guidance labels.
#     No accounts, portfolios or personal data of any kind.
#   • data\raw_archive.tar.gz    — the original insurer fact-sheet PDFs, so every
#     fund's "source document" link resolves and any month can be re-parsed.
#
# Safe to re-run: refuses to overwrite a database that already holds data unless
# you pass -Force.
param(
  [switch]$Force,
  [string]$PgContainer = "bharat_market_pro_pg",
  [string]$PgUser = "bharat_market_pro",
  [string]$PgDb = "bharat_market_pro",
  [string]$DataDir = "data"
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$dump    = Join-Path $DataDir "bharat_market_pro_data.sql.gz"
$archive = Join-Path $DataDir "raw_archive.tar.gz"

if (-not (Test-Path $dump)) { Write-Host "[X] $dump not found." -ForegroundColor Red; exit 2 }

# The database must be reachable. The compose stack publishes it on 127.0.0.1:5433,
# but we talk to it through `docker exec` so no local psql client is required.
$running = (docker ps --format "{{.Names}}" 2>$null) -split "`n" | Where-Object { $_.Trim() -eq $PgContainer }
if (-not $running) {
  Write-Host "[X] Postgres container '$PgContainer' is not running." -ForegroundColor Red
  Write-Host "    Start the stack first:  docker compose up -d"
  exit 2
}

function Invoke-Psql([string]$sql) {
  return (docker exec -i $PgContainer psql -U $PgUser -d $PgDb -t -A -c $sql 2>$null)
}

# Don't silently clobber an instance that's already in use.
$existing = 0
try { $existing = [int](Invoke-Psql "select coalesce((select count(*) from prices),0)") } catch { $existing = 0 }
if ($existing -gt 0 -and -not $Force) {
  Write-Host "[!] This database already has $existing price rows." -ForegroundColor Yellow
  Write-Host "    Re-run with -Force to replace its contents with the bundled dataset."
  exit 1
}

Write-Host "-> loading database (~73 MB compressed; a few minutes)..."
# Stream the gzip through docker exec's stdin. Done with .NET streams so this works
# on a clean Windows box with no gzip/tar binaries on PATH.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "docker"
$psi.Arguments = "exec -i $PgContainer psql -U $PgUser -d $PgDb -q"
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)

$inFs = [System.IO.File]::OpenRead((Resolve-Path $dump))
$gz = New-Object System.IO.Compression.GZipStream($inFs, [System.IO.Compression.CompressionMode]::Decompress)
try {
  $gz.CopyTo($proc.StandardInput.BaseStream)
  $proc.StandardInput.BaseStream.Flush()
} finally {
  $proc.StandardInput.Close()
  $gz.Dispose(); $inFs.Dispose()
}
$proc.StandardOutput.ReadToEnd() | Out-Null
$proc.StandardError.ReadToEnd()  | Out-Null
$proc.WaitForExit()

$rows  = Invoke-Psql "select count(*) from prices"
$funds = Invoke-Psql "select count(*) from funds"
Write-Host "[ok] database loaded - $rows price rows, $funds ULIP fund rows" -ForegroundColor Green

if (Test-Path $archive) {
  # RAW_DIR defaults to .\raw locally; in Docker it's the /data/raw volume.
  $target = if ($env:RAW_DIR) { $env:RAW_DIR } else { ".\raw" }
  Write-Host "-> unpacking source fact-sheet PDFs into $target ..."
  $parent = Split-Path $target -Parent
  if (-not $parent) { $parent = "." }
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  # tar ships with Windows 10 1803+ and handles .tar.gz natively.
  tar -xzf $archive -C $parent
  $n = (Get-ChildItem $target -Recurse -Filter *.pdf -ErrorAction SilentlyContinue).Count
  Write-Host "[ok] $n PDFs unpacked" -ForegroundColor Green
} else {
  Write-Host "-  no raw_archive.tar.gz found - skipping PDFs (fund data still works;"
  Write-Host "   only the 'view source document' links need them)"
}

Write-Host ""
Write-Host "Done. Start the app and you should see a fully populated instance."
Write-Host "To keep it current: npm --prefix server run ingest   (daily prices)"
