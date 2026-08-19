#!/usr/bin/env bash
# =============================================================================
# build.sh — genera le due versioni di PISH da un unico source
# -----------------------------------------------------------------------------
#   pish.app        → installer completo (engine locale Ollama di default)
#   pish-lite.app   → versione leggera cloud-only (niente Ollama)
#
# Uso:   bash build.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# la versione piena è il source (contiene già i base64 embedded)
[ -f pish.app ] || { echo "✗ pish.app mancante"; exit 1; }

# pish-lite.app = pish.app con default engine=none
sed 's/PISH_ENGINE="${PISH_ENGINE:-ollama}"/PISH_ENGINE="${PISH_ENGINE:-none}"/' pish.app > pish-lite.app
chmod +x pish-lite.app

# header dedicato
python3 - <<'PYEOF'
p = 'pish-lite.app'
s = open(p).read()
old = """# PISH.app — Pi Intelligent SHell
# -----------------------------------------------------------------------------
# Trasforma un server Linux in una shell intelligente basata su pi: l'admin
# imparte direttive in linguaggio naturale invece di comandi, da browser
# (tau-mirror) o da app mobile (remote-pi).
#"""
new = """# PISH-lite.app — Pi Intelligent SHell (versione leggera, cloud-only)
# -----------------------------------------------------------------------------
# Come PISH.app ma SENZA engine locale (niente Ollama): pish lavora con un
# provider cloud (Anthropic Claude, OpenAI GPT, OpenRouter, DeepSeek, Groq,
# Mistral, xAI). Ideale per server piccoli o dove il modello gira altrove.
# Installazione: sudo bash pish-lite.app --provider=anthropic --api-key=sk-ant-...
# (o senza flag: il wizard chiede provider/modello durante l'install)
#"""
assert old in s, "header non trovato"
s = s.replace(old, new)
open(p, 'w').write(s)
print("✓ pish-lite.app generato")
PYEOF

chmod +x pish-lite.app
bash -n pish.app && bash -n pish-lite.app && echo "✓ sintassi OK (entrambe)"
ls -la pish.app pish-lite.app
