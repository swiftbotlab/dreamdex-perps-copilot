#!/bin/bash
# Refresh the public evidence (evidence/orders.*, docs/index.html, README evidence blocks) after scheduled demo trades,
# and push it, but ONLY when there are new orders and the working tree holds no other change. Run by
# ddmvp-evidence.timer until 2026-11-02. Never touches anything but the generated files.
set -euo pipefail
PROD=/home/agent/agent/products/dreamdex-mvp
cd "$PROD"
[ "$(date -u +%s)" -lt "$(date -u -d 2026-11-02 +%s)" ] || { echo "past the end date; nothing to do"; exit 0; }
[ ! -e data/evidence_refresh.off ] || { echo "off switch present"; exit 0; }
GEN="evidence/orders.md evidence/orders.csv evidence/orders.json docs/index.html README.md"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "working tree has other changes; skipping"; exit 0; fi
git fetch -q origin main
if [ "$(git rev-list --count origin/main..HEAD)" != "0" ] || [ "$(git rev-list --count HEAD..origin/main)" != "0" ]; then echo "local and origin/main differ; skipping"; exit 0; fi
before=$(python3 -c "import json;print(sorted(o['hash'] for o in json.load(open('evidence/orders.json'))['orders']))" | sha256sum)
timeout 300 node --import tsx scripts/evidence.ts 0x2A11e7388D1D2F9690f2636846d44b478f61bF08 0x0e7E8DF6Eac2E14165b4fA4CB2BD4e445d0E3817
after=$(python3 -c "import json;print(sorted(o['hash'] for o in json.load(open('evidence/orders.json'))['orders']))" | sha256sum)
if [ "$before" = "$after" ]; then git checkout -- evidence/; echo "no new orders"; exit 0; fi
timeout 300 node --import tsx scripts/evidence_page.ts
n=$(python3 -c "import json;d=json.load(open('evidence/orders.json'));print(d['verified'],'of',d['total'])")
git add $GEN
git -c user.name=Swiftbot -c user.email=344366013+swiftbotlab@users.noreply.github.com commit -q -m "Evidence: $n orders verified on chain (refresh after scheduled demo trades)"
git push -q origin HEAD:main
echo "pushed: $n"
