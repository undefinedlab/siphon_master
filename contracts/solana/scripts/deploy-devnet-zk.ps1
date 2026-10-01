# Deploy Siphon Solana Devnet ZK vault (Poseidon + Groth16, no scaffold-verify).
param(
  [string]$Mint = "",
  [string]$ToolsVersion = "v1.54"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Prog = Join-Path $Root "programs\siphon-vault-zk"
$OutDir = Join-Path $Root "target\deploy"
Set-Location $Prog

if (-not (Get-Command cargo-build-sbf -ErrorAction SilentlyContinue)) {
  throw "cargo-build-sbf not found. Install Solana/Agave CLI."
}
if (-not (Get-Command solana -ErrorAction SilentlyContinue)) {
  throw "solana CLI not found."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Kp = Join-Path $OutDir "siphon_vault_zk-keypair.json"
if (-not (Test-Path $Kp)) {
  Write-Host "Generating new program keypair → $Kp"
  solana-keygen new --no-bip39-passphrase -o $Kp --force | Out-Null
}

Write-Host "Building siphon_vault_zk (NO scaffold-verify)..."
cargo-build-sbf --tools-version $ToolsVersion --manifest-path Cargo.toml --sbf-out-dir $OutDir

$So = Join-Path $OutDir "siphon_vault_zk.so"
if (-not (Test-Path $So)) {
  # cargo-build-sbf names output from crate name
  $alt = Join-Path $OutDir "siphon_vault_zk.so"
  if (-not (Test-Path $alt)) { throw "Missing BPF .so in $OutDir" }
}

$ProgramId = (solana-keygen pubkey $Kp).Trim()
Write-Host "Deploying ZK program $ProgramId to Devnet..."
solana program deploy $So --program-id $Kp --url https://api.devnet.solana.com

if (-not $Mint) {
  $Mint = $env:NEXT_PUBLIC_SOLANA_USDC_MINT
  if (-not $Mint) { $Mint = "DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie" }
}

$EnvSnippet = @"
# Solana Devnet ZK vault (product path). Do not overwrite legacy devnet.env (FHE Eip1D6…).
SIPHON_ZK_PROGRAM_ID=$ProgramId
NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID=$ProgramId
NEXT_PUBLIC_SIPHON_SOLANA_ZK=1
NEXT_PUBLIC_SOLANA_USDC_MINT=$Mint
NEXT_PUBLIC_DEVNET_VAULT_CHAIN_ID=900002
LEGACY_FHE_PROGRAM_ID=Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
"@
$EnvPath = Join-Path $OutDir "devnet-zk.env"
$EnvSnippet | Set-Content -Path $EnvPath -Encoding utf8
Write-Host "Wrote $EnvPath"
Write-Host "Next: node scripts/init-vault-devnet-zk.mjs"
Write-Host "Then: node scripts/deploy-vk-accounts.mjs && node scripts/register-vk-devnet-zk.mjs"
