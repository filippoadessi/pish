#!/usr/bin/env bash
# =============================================================================
# pish-config — wizard interattivo di configurazione PISH
# -----------------------------------------------------------------------------
# Permette di cambiare:
#   • Provider e modello (ollama locale · Anthropic Claude · OpenAI GPT · custom)
#   • API key per i provider cloud
#   • Porta del web UI (tau-mirror)
#   • Relay remote-pi (accesso mobile)
#   • Nome sessione e workspace
#
# Scrive:  ~/.pi/agent/models.json (provider custom)
#          ~/.pi/settings.json    (defaultProvider/defaultModel + timeout)
#          ~/.pi/agent/auth.json  (API key cloud)
#          /etc/systemd/system/pish.service (env) — se presente
# Poi riavvia la sessione pish.
#
# Uso:    pish config            wizard interattivo
#         pish config --show     mostra la configurazione attuale
#         pish config --noninteractive --provider anthropic --api-key sk-... \
#              --model claude-sonnet-4-6
# =============================================================================
set -euo pipefail

# ------------------------------ paths ---------------------------------------
AGENT_DIR="${PI_AGENT_DIR:-/root/.pi/agent}"
PI_DIR="${PI_DIR:-/root/.pi}"
SETTINGS="$PI_DIR/settings.json"
MODELS="$AGENT_DIR/models.json"
AUTH="$AGENT_DIR/auth.json"
SVC=/etc/systemd/system/pish.service
PISH_DIR="${PISH_DIR:-/opt/pish}"

# ------------------------------ colors --------------------------------------
C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
C_RED=$'\033[31m'; C_MAG=$'\033[35m'

say()  { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }
hdr()  { printf '\n%s══ %s ══%s\n' "$C_CYAN" "$*" "$C_RESET"; }
item() { printf '  %s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
dim()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

[ "$(id -u)" = 0 ] || die "serve root: sudo pish config"

# ------------------------------ helpers --------------------------------------
ask() { # ask "prompt" "default" → stdout
  local q="$1" d="${2:-}" r
  if [ -n "$d" ]; then printf '%s [%s]: ' "$q" "$d"; else printf '%s: ' "$q"; fi >&2
  read -r r || r=""
  printf '%s\n' "${r:-$d}"
}

pick() { # pick "prompt" "default" "opzione|desc" ...
  local q="$1" d="$2"; shift 2
  local i=1 opt desc
  printf '%s\n' "$q" >&2
  for opt in "$@"; do
    desc="${opt#*|}"
    printf '  %s) %s\n' "$i" "${opt%%|*}" >&2
    i=$((i+1))
  done
  local r
  printf 'Scelta [%s]: ' "$d" >&2
  read -r r || r=""
  r="${r:-$d}"
  # ritorna la chiave della scelta (prima parte prima di |)
  i=1
  for opt in "$@"; do
    if [ "$i" = "$r" ]; then printf '%s\n' "${opt%%|*}"; return 0; fi
    i=$((i+1))
  done
  # fallback: accetta anche la chiave testuale
  for opt in "$@"; do
    [ "${opt%%|*}" = "$r" ] && { printf '%s\n' "$r"; return 0; }
  done
  printf '%s\n' "$r"
}

json_get() { python3 -c "
import json,sys
try: d=json.load(open('$1'))
except: d={}
def g(o,k):
    for p in k.split('.'):
        if isinstance(o,dict) and p in o: o=o[p]
        else: return None
    return o
v=g(d,'$2')
print('' if v is None else v)
" 2>/dev/null; }

# ------------------------------ show -----------------------------------------
show_config() {
  hdr "Configurazione attuale"
  item "Provider:    $(json_get "$SETTINGS" defaultProvider || echo '—')"
  item "Modello:     $(json_get "$SETTINGS" defaultModel || echo '—')"
  local port; port=$(json_get "$SETTINGS" _pish_port 2>/dev/null)
  [ -z "$port" ] && port="${PISH_PORT:-3810}"
  item "Tau web:     http://$(hostname -I 2>/dev/null | awk '{print $1}'):$port"
  if [ -f "$MODELS" ]; then
    hdr "models.json"
    python3 -c "
import json
d=json.load(open('$MODELS'))
for pid,p in d.get('providers',{}).items():
    ms=[m['id'] for m in p.get('models',[])]
    print(f'  • {pid}: {p.get(\"baseUrl\",\"?\")} → {ms}')
" 2>/dev/null || echo "  (non leggibile)"
  fi
  if [ -f "$AUTH" ]; then
    hdr "API key cloud (auth.json)"
    python3 -c "
import json
d=json.load(open('$AUTH'))
for pid,v in d.items():
    if isinstance(v,dict) and v.get('type')=='api_key':
        k=str(v.get('key','')); print(f'  • {pid}: {k[:8]}…{k[-4:] if len(k)>12 else \"\"}')
" 2>/dev/null
  fi
}

# ------------------------------ write helpers --------------------------------
# scrive/aggiorna un JSON in modo sicuro
json_merge() { # file.json '{"chiave":"valore"}'
  mkdir -p "$(dirname "$1")"
  python3 - "$1" "$2" <<'PYEOF'
import json, sys
path, patch = sys.argv[1], json.loads(sys.argv[2])
try:
    d = json.load(open(path))
except Exception:
    d = {}
def merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            merge(a[k], v)
        else:
            a[k] = v
merge(d, patch)
open(path, "w").write(json.dumps(d, indent=1))
PYEOF
}

restart_pish() {
  if systemctl list-unit-files 2>/dev/null | grep -q '^pish.service'; then
    systemctl restart pish 2>/dev/null && say "✓ sessione pish riavviata" || warn "⚠ riavvio manuale: pish restart"
  elif tmux has-session -t "${PISH_NAME:-pish}" 2>/dev/null; then
    tmux kill-session -t "${PISH_NAME:-pish}" 2>/dev/null || true
    tmux new-session -d -s "${PISH_NAME:-pish}" "bash $PISH_DIR/pish.sh" 2>/dev/null && say "✓ sessione pish riavviata" || true
  else
    say "✓ configurazione salvata (sessione non attiva: avviala con 'pish start')"
  fi
}

# ------------------------------ wizard provider -------------------------------
wizard_provider() {
  hdr "Provider LLM"
  dim "Scegli il motore di intelligenza per PISH:"
  local choice
  choice=$(pick "Provider:" "1" \
    "ollama|Ollama locale (MiniCPM-V 4.6, scaricato automaticamente — offline)" \
    "anthropic|Anthropic Claude (cloud — richiede API key)" \
    "openai|OpenAI GPT (cloud — richiede API key)" \
    "custom|Endpoint OpenAI-compatibile (es. OpenRouter, vLLM, LiteLLM)")

  case "$choice" in
    ollama)
      local base model
      base=$(ask "Base URL ollama" "http://localhost:11434/v1")
      model=$(ask "Modello" "minicpm-v4.6")
      # pull + pre-warm
      if command -v ollama >/dev/null; then
        say "  • Scarico $model (se non presente)..."
        ollama pull "$model" >/dev/null 2>&1 || warn "  ⚠ pull fallito (ollama aggiornato? serve >= 0.28)"
        say "  • Pre-warm del modello (primo load)..."
        ollama run "$model" "ok" >/dev/null 2>&1 || true
      else
        warn "  ⚠ ollama non trovato: esegui 'pish reinstall' o installa ollama"
      fi
      # aggiorna il servizio: ollama deve essere attivo
      systemctl enable ollama >/dev/null 2>&1 || true
      systemctl start ollama >/dev/null 2>&1 || true
      json_merge "$MODELS" "{\"providers\":{\"ollama\":{\"api\":\"openai-completions\",\"apiKey\":\"local\",\"baseUrl\":\"$base\",\"models\":[{\"id\":\"$model\",\"contextWindow\":200000,\"input\":[\"text\"]}]}}}"
      json_merge "$SETTINGS" "{\"defaultProvider\":\"ollama\",\"defaultModel\":\"$model\"}"
      ;;
    anthropic)
      local key model
      key=$(ask "API key Anthropic (sk-ant-...)" "")
      [ -n "$key" ] || die "API key richiesta"
      model=$(ask "Modello" "claude-sonnet-4-6")
      # salva key in auth.json (formato pi)
      json_merge "$AUTH" "{\"anthropic\":{\"type\":\"api_key\",\"key\":\"$key\"}}"
      json_merge "$SETTINGS" "{\"defaultProvider\":\"anthropic\",\"defaultModel\":\"$model\"}"
      say "  ✓ API key salvata in auth.json"
      ;;
    openai)
      local key model
      key=$(ask "API key OpenAI (sk-...)" "")
      [ -n "$key" ] || die "API key richiesta"
      model=$(ask "Modello" "gpt-4o-mini")
      json_merge "$AUTH" "{\"openai\":{\"type\":\"api_key\",\"key\":\"$key\"}}"
      json_merge "$SETTINGS" "{\"defaultProvider\":\"openai\",\"defaultModel\":\"$model\"}"
      say "  ✓ API key salvata in auth.json"
      ;;
    custom)
      local base key model pid
      base=$(ask "Base URL (OpenAI-compatibile)" "")
      model=$(ask "ID modello" "")
      [ -n "$base" ] && [ -n "$model" ] || die "base-url e modello richiesti"
      key=$(ask "API key (vuoto se non serve)" "")
      pid=$(ask "Nome provider (per models.json)" "custom")
      local keyjson="\"apiKey\":\"$key\""
      [ -z "$key" ] && keyjson="\"apiKey\":\"local\""
      json_merge "$MODELS" "{\"providers\":{\"$pid\":{\"api\":\"openai-completions\",$keyjson,\"baseUrl\":\"$base\",\"models\":[{\"id\":\"$model\",\"contextWindow\":200000,\"input\":[\"text\"]}]}}}"
      json_merge "$SETTINGS" "{\"defaultProvider\":\"$pid\",\"defaultModel\":\"$model\"}"
      ;;
    *) die "scelta non valida" ;;
  esac
  # timeout provider alto (modelli locali lenti)
  json_merge "$SETTINGS" '{"retry":{"provider":{"timeoutMs":600000}}}'
  say "✓ Provider configurato"
}

# ------------------------------ wizard base -----------------------------------
wizard_base() {
  hdr "Impostazioni di base"
  local port name ws relay
  port=$(ask "Porta web UI (tau-mirror)" "${PISH_PORT:-3810}")
  name=$(ask "Nome sessione" "${PISH_NAME:-pish}")
  ws=$(ask "Workspace" "${PISH_WS:-/root}")
  relay=$(ask "Relay remote-pi (mobile)" "${PISH_RELAY:-https://relay.adessi.it}")

  # aggiorna il servizio systemd se presente
  if [ -f "$SVC" ]; then
    sed -i "s/Environment=PISH_PORT=.*/Environment=PISH_PORT=$port/" "$SVC"
    sed -i "s/Environment=PISH_NAME=.*/Environment=PISH_NAME=$name/" "$SVC"
    sed -i "s/Environment=PISH_WS=.*/Environment=PISH_WS=$ws/" "$SVC"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  # persistenza per il comando pish
  json_merge "$SETTINGS" "{\"_pish_port\":\"$port\",\"_pish_name\":\"$name\",\"_pish_ws\":\"$ws\"}"
  say "✓ Impostazioni salvate"
}

# ------------------------------ main ------------------------------------------
case "${1:-}" in
  --show|-s) show_config; exit 0 ;;
  --noninteractive|-n)
    # uso scripted: --provider X --api-key Y --model Z --base-url B
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --provider) prov="$2"; shift 2 ;;
        --api-key)  akey="$2"; shift 2 ;;
        --model)    amodel="$2"; shift 2 ;;
        --base-url) abase="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    case "$prov" in
      anthropic|openai)
        json_merge "$AUTH" "{\"$prov\":{\"type\":\"api_key\",\"key\":\"$akey\"}}"
        json_merge "$SETTINGS" "{\"defaultProvider\":\"$prov\",\"defaultModel\":\"${amodel:-}\"}"
        ;;
      ollama)
        json_merge "$MODELS" "{\"providers\":{\"ollama\":{\"api\":\"openai-completions\",\"apiKey\":\"local\",\"baseUrl\":\"${abase:-http://localhost:11434/v1}\",\"models\":[{\"id\":\"${amodel:-minicpm-v4.6}\",\"contextWindow\":200000,\"input\":[\"text\"]}]}}}"
        json_merge "$SETTINGS" "{\"defaultProvider\":\"ollama\",\"defaultModel\":\"${amodel:-minicpm-v4.6}\"}"
        ;;
      *) die "provider non valido: ${prov:-?} (ollama|anthropic|openai|custom)" ;;
    esac
    json_merge "$SETTINGS" '{"retry":{"provider":{"timeoutMs":600000}}}'
    restart_pish
    ;;
  -h|--help)
    sed -n '1,25p' "$0" | sed 's/^# \{0,1\}//' | grep -v '^='
    ;;
  *)
    hdr "PISH — Configurazione"
    dim "Cosa vuoi cambiare?"
    what=$(pick "Sezione:" "1" \
      "provider|Provider e modello LLM (ollama / Claude / GPT / custom)" \
      "base|Impostazioni di base (porta, nome, workspace, relay)" \
      "show|Mostra configurazione attuale" \
      "exit|Esci")
    case "$what" in
      provider) wizard_provider ;;
      base) wizard_base ;;
      show) show_config ;;
      exit) exit 0 ;;
      *) die "scelta non valida" ;;
    esac
    restart_pish
    say "✅ Fatto. Per verificare: pish config --show"
    ;;
esac
