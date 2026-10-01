# Deploy the retired scaffold (siphon-vault-onchain). Not the product.
# spend and strategy_swap fail closed. Product deploy is deploy-devnet-zk.ps1.
# Requires: solana CLI with cargo-build-sbf, funded Devnet wallet.
# Optional: Agave 4.x + platform-tools v1.54+ (edition2024-capable).
param(
  [string]$Mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  [string]$ToolsVersion = "v1.54"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Prog = Join-Path $Root "programs\siphon-vault-onchain"
$OutDir = Join-Path $Root "target\deploy"
Set-Location $Prog

if (-not (Get-Command cargo-build-sbf -ErrorAction SilentlyContinue)) {
  throw "cargo-build-sbf not found. Install Solana/Agave CLI and add it to PATH."
}
if (-not (Get-Command solana -ErrorAction SilentlyContinue)) {
  throw "solana CLI not found. Install https://docs.solanalabs.com/cli/install"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "Building retired siphon_vault (spend and strategy_swap fail closed)..."
cargo-build-sbf --tools-version $ToolsVersion --manifest-path Cargo.toml --sbf-out-dir $OutDir

$ProgramId = "Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj"
$So = Join-Path $OutDir "siphon_vault.so"
$Kp = Join-Path $OutDir "siphon_vault-keypair.json"
if (-not (Test-Path $So)) { throw "Missing $So after build" }
if (-not (Test-Path $Kp)) { throw "Missing program keypair $Kp" }

Write-Host "Deploying $ProgramId to Devnet..."
solana program deploy $So --program-id $Kp --url https://api.devnet.solana.com

$VaultPda = "5WaifRrg4CrGLSbyqVYcjUQystjj5HigMn1mgUWjPa2k"
$CompliancePda = "2a4x2vx4W9pqa1M7CnXiVKuPhS5RcnVKXBiK9dt1MBvv"
$EnvSnippet = @"
SIPHON_PROGRAM_ID=$ProgramId
NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID=$ProgramId
NEXT_PUBLIC_SOLANA_USDC_MINT=$Mint
NEXT_PUBLIC_DEVNET_VAULT_CHAIN_ID=900002
SIPHON_SOLANA_VAULT_PDA=$VaultPda
SIPHON_SOLANA_COMPLIANCE_PDA=$CompliancePda
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
"@
$EnvSnippet | Set-Content -Path (Join-Path $OutDir "devnet.env") -Encoding utf8
Write-Host "Wrote $OutDir\devnet.env"
Write-Host "Next: node scripts/init-vault-devnet.mjs (from siphon-app cwd if needed)"
Write-Host "  vault PDA: $VaultPda"
Write-Host "  allowed mint: $Mint"
