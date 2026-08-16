#!/usr/bin/env bash
# One-shot server setup for the arb bot. Ubuntu 24.04, run as the default user.
#   scp this repo to the box, then: bash deploy.sh
set -euo pipefail
echo "== installing Node 24 + git + tmux =="
sudo apt-get update -y
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git tmux
node --version
echo "== npm install =="
npm install
echo
echo "== NEXT (manual, secrets are NOT in git) =="
echo "  1. Put wallet.json and .env in this directory (scp them from your laptop):"
echo "       scp wallet.json .env  ubuntu@THIS_BOX:~/sol-arb-scout/"
echo "  2. Point Jito at the co-located region (edit .env):"
echo "       JITO_REGIONS=https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles"
echo "  3. Prove the latency win:   node --import tsx server-latency.mts   (want <10ms)"
echo "  4. Run it, surviving disconnect:   tmux new -s bot 'npm start | tee live.log'"
echo "       detach: Ctrl-b then d   |   reattach: tmux attach -t bot"
