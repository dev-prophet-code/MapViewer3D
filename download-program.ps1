# Lädt das Programm (bin\) vom neuesten Release auf GitHub, wenn es fehlt (z. B. weil nur der Quelltext entpackt wurde).
# Wird von start.bat aufgerufen. Prüft die SHA-256-Summe des Downloads.
$ErrorActionPreference = 'Stop'
$repo = 'dev-prophet-code/MapViewer3D'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host '-> Programm fehlt: lade die neueste Version von GitHub ...'
    $rels = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=30"
    $best = $null; $bestN = -1
    foreach ($r in $rels) {
        foreach ($a in $r.assets) {
            if ($a.name -match '^MapViewer3D-update-Beta\.(\d+)\.zip$' -and [int]$Matches[1] -gt $bestN) { $best = $a; $bestN = [int]$Matches[1] }
        }
    }
    if (-not $best) { throw 'kein Release mit Programm gefunden' }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('mv3d-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'u.zip'
    Invoke-WebRequest $best.browser_download_url -OutFile $zip
    $want = ((Invoke-WebRequest ($best.browser_download_url + '.sha256')).Content -split '\s+')[0].Trim().ToLower()
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) { throw 'Pruefsumme des Downloads stimmt nicht - abgebrochen' }
    Expand-Archive $zip -DestinationPath (Join-Path $tmp 'x')
    $src = Get-ChildItem (Join-Path $tmp 'x') -Recurse -Directory -Filter bin | Select-Object -First 1
    if (-not $src) { throw 'bin\ fehlt im Paket' }
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'bin') | Out-Null
    Copy-Item (Join-Path $src.FullName '*') (Join-Path $root 'bin') -Recurse -Force
    Remove-Item $tmp -Recurse -Force
    exit 0
} catch {
    Write-Host ('Download fehlgeschlagen: ' + $_.Exception.Message)
    exit 1
}
