# Local relayer for the v5 Sepolia stack. The prod executor at api.siphon.money is wired to the
# OLD kernel (programVersion 4) and predates the compliance-split encoder, so it reverts a v5
# spend with BadProgramVersion (0x5f160aa6) and would drop the compliance half regardless.
import os
os.environ["ETH_SEPOLIA_VAULT_KERNEL"] = "0x586dFaa329D71de7368617C9f00395C040bCf84a"
# publicnode, NOT the Alchemy key the browser uses. Free-tier Alchemy meters by compute unit, and
# a submission is a burst — gasPrice, estimateGas, getTransactionCount, sendRawTransaction, then
# receipt polling — so the relayer and the browser sharing one key trips 429 on both. publicnode
# has no monthly cap and serves every method this path needs.
os.environ["ETH_SEPOLIA_RPC"] = "https://ethereum-sepolia-rpc.publicnode.com"
# The v5 Sepolia ASP now lives on EC2 behind Caddy. The laptop instance it used to name is
# deliberately stopped: two ASPs against one hub is a split-brain, and whichever postman wins
# publishes ITS root. createStrategy validates note_label against this URL, so a stale pointer
# surfaces as "ASP label rejected" — which reads like a compliance decision, not a dead host.
os.environ["ASP_URL"] = "https://api.siphon.money/aspv5"
os.environ["ASP_SCREEN_TOKEN"] = "16af7528aa54de91e904ca1bd7ee4cadad72cf105fb8f9d3"
# The v3 admission gate reads a DIFFERENT pair. asp_membership._assert_label_in_asp_v3 goes to
# ASP_V2_URL / ASP_V2_SCREEN_TOKEN, because on v1 chains the v1 ASP answers "not a member" for
# every v3 label ever minted. Leaving these unset with ASP_ORACLE_FAIL_CLOSED on rejects every
# arm with "ASP label rejected" — which reads as a compliance decision about the note.
os.environ["ASP_V2_URL"] = "https://api.siphon.money/aspv5"
os.environ["ASP_V2_SCREEN_TOKEN"] = "16af7528aa54de91e904ca1bd7ee4cadad72cf105fb8f9d3"
# Sepolia is admin-gated by default (config.ADMIN_GATED_CHAIN_IDS = "11155111"), so
# createStrategy 403s any wallet not in the seed or the AdminWallet table. Seed the test
# wallet rather than ungating the chain — the gate is the right default for a testnet that
# shares an executor with mainnet traffic.
os.environ["ETH_SEPOLIA_ADMIN_WALLETS"] = "0xc5b7b574ee84a9b59b475fe32eaf908c246d3859"
from app import app, start_scheduler

# app.py only starts the scheduler from its own `__main__` block, from gunicorn's post_fork
# hook, or from scheduler_main.py. Importing `app` and calling app.run() gets NEITHER, so the
# API answers, strategies arm, legs sit PENDING forever and nothing anywhere logs a reason.
start_scheduler()
app.run(host="127.0.0.1", port=5015, debug=False, use_reloader=False)
