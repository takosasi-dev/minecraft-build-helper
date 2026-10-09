# =====================================================================
# マルチプレイ建築支援アドオン デプロイスクリプト
# ソースの BuildHelperBP / BuildHelperRP を、ランチャーの com.mojang の
# behavior_packs / resource_packs へ直接ミラーコピーする。
# インポート不要・増殖なし。実行後は Minecraft を再起動するだけで反映。
#
# 使い方(PowerShellで):
#   powershell -ExecutionPolicy Bypass -File tools\deploy.ps1
# ※ Minecraft を完全終了してから実行すること(ファイルロック回避)
# =====================================================================

$root = Split-Path $PSScriptRoot -Parent
$mojShared = "$env:APPDATA\Minecraft Bedrock\Users\Shared\games\com.mojang"

if (-not (Test-Path $mojShared)) {
  Write-Host "com.mojang が見つかりません: $mojShared"
  Write-Host "ランチャー版以外を使っている場合は、このパスを環境に合わせて書き換えてください。"
  exit 1
}

# Minecraft 起動チェック
$proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "inecraft" }
if ($proc) {
  Write-Host "Minecraft が起動中です。完全に終了してから実行してください。"
  exit 1
}

$bpSrc = Join-Path $root "BuildHelperBP"
$rpSrc = Join-Path $root "BuildHelperRP"
$bpDst = Join-Path $mojShared "behavior_packs\BuildHelperBP"
$rpDst = Join-Path $mojShared "resource_packs\BuildHelperRP"

robocopy $bpSrc $bpDst /MIR /NFL /NDL /NJH /NJS /NP > $null
$c1 = $LASTEXITCODE
robocopy $rpSrc $rpDst /MIR /NFL /NDL /NJH /NJS /NP > $null
$c2 = $LASTEXITCODE

if ($c1 -lt 8 -and $c2 -lt 8) {
  Write-Host "デプロイ完了:"
  Write-Host "  -> $bpDst"
  Write-Host "  -> $rpDst"
  Write-Host "Minecraft を起動して、ワールドでパックが有効か確認してください。"
  exit 0
} else {
  Write-Host "robocopy エラー (BP=$c1 RP=$c2)"
  exit 1
}
