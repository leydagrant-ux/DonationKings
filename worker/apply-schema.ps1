# Apply schema.sql to D1 without using the bulk-import endpoint.
#
# `wrangler d1 execute --file` uploads through D1's import API, which an OAuth
# token from `wrangler login` is not always allowed to use: it fails with
# "Authentication error [code: 10000]" even when the token shows d1 (write).
# The ordinary query endpoint works fine with the same token, so this sends
# the whole schema as one --command instead.
#
# Comments have to go first. Joining the file onto one line would otherwise
# leave a trailing `-- ...` commenting out the rest of the statement, which
# fails in a way that looks like a SQL error rather than a formatting one.
#
# Usage:
#   .\apply-schema.ps1            # local development database
#   .\apply-schema.ps1 -Remote    # the real one

param([switch]$Remote)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$file = Join-Path $here 'schema.sql'

if (-not (Test-Path $file)) {
    Write-Host "Could not find schema.sql next to this script." -ForegroundColor Red
    exit 1
}

$raw = Get-Content $file -Raw

# Strip `--` to end of line, then collapse all whitespace to single spaces.
# Safe for this schema specifically: it has no `--` inside a string literal.
$sql = $raw -replace '(?m)--[^\r\n]*', ''
$sql = $sql -replace '\s+', ' '
$sql = $sql.Trim()

$statements = ($sql.ToCharArray() | Where-Object { $_ -eq ';' }).Count
$where = 'local'
if ($Remote) { $where = 'REMOTE' }

Write-Host ""
Write-Host "Applying schema to the $where database" -ForegroundColor Cyan
Write-Host "  $($sql.Length) characters, $statements statements"
Write-Host ""

if ($Remote) {
    npx --yes wrangler@latest d1 execute donationkings --remote --command $sql
} else {
    npx --yes wrangler@latest d1 execute donationkings --local --command $sql
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Done. Schema applied to the $where database." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Failed with exit code $LASTEXITCODE." -ForegroundColor Red
}
exit $LASTEXITCODE
