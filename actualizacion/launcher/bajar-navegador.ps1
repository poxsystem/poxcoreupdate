# PoxScore — descarga LibreWolf portable a <instalacion>\browser\
# Corre sin instalar nada: baja el zip oficial (bsys6) y lo extrae.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # launcher\ → raíz de la instalación
$dest = Join-Path $root 'browser'
New-Item -ItemType Directory -Force $dest | Out-Null

Write-Host 'Buscando la ultima version de LibreWolf portable...'
$rels = Invoke-RestMethod 'https://gitlab.com/api/v4/projects/librewolf-community%2Fbrowser%2Fbsys6/releases?per_page=1'
$link = $rels[0].assets.links | Where-Object { $_.name -match 'windows-x86_64-portable\.zip$' } | Select-Object -First 1
if (-not $link) { throw 'No se encontro el zip portable en el release.' }

$zip = Join-Path $env:TEMP 'librewolf-portable.zip'
Write-Host "Descargando $($link.name) (~120 MB)..."
Invoke-WebRequest $link.url -OutFile $zip -UseBasicParsing

Write-Host "Extrayendo en $dest ..."
Expand-Archive $zip -DestinationPath $dest -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue

$exe = Get-ChildItem $dest -Recurse -Filter 'librewolf.exe' | Select-Object -First 1
if ($exe) {
    Write-Host ''
    Write-Host "Listo: $($exe.FullName)"
    Write-Host 'La proxima vez que el panel abra PoxScore lo hara en su propio navegador (pantalla completa).'
} else {
    Write-Warning 'Se extrajo pero no se encontro librewolf.exe — revisa la carpeta browser\.'
}
