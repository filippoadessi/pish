#!/usr/bin/env bash
# =============================================================================
# PISH.app — Pi Intelligent SHell
# -----------------------------------------------------------------------------
# Trasforma un server Linux in una shell intelligente basata su pi: l'admin
# imparte direttive in linguaggio naturale invece di comandi, da browser
# (tau-mirror) o da app mobile (remote-pi).
#
# Installazione interattiva:
#   sudo bash pish.app
#
# Installazione non interattiva (tutti i parametri forniti):
#   sudo bash pish.app --provider ollama --base-url http://localhost:11434/v1 \
#        --model qwen2.5:0.5b --port 3810 --relay https://relay.adessi.it
#
# Opzioni:
#   --engine <engine>      Engine LLM locale (ollama default | vllm | llama.cpp)
#   --provider <id>        Provider LLM (ollama | openai | custom)
#   --base-url <url>       Base URL API (OpenAI-compatibile)
#   --api-key <key>        API key (per openai/custom)
#   --model <id>           Modello di default
#   --port <n>             Porta web UI tau-mirror (default 3810)
#   --relay <url>          Relay remote-pi (default https://relay.adessi.it)
#   --name <nome>          Nome sessione/servizio (default pish)
#   --workspace <dir>      Directory di lavoro (default /root)
#   --yes, -y              Non interattivo (usa i default per ciò che manca)
#   --no-systemd           Non installare il servizio systemd
#   --dry-run              Mostra le azioni senza eseguirle
# =============================================================================
set -euo pipefail

# ============================== CONFIG =====================================
PISH_PORT="${PISH_PORT:-3810}"
PISH_NAME="${PISH_NAME:-pish}"
PISH_WS="${PISH_WS:-/root}"
PISH_RELAY="${PISH_RELAY:-https://relay.adessi.it}"
PISH_SYSTEMD=1
PISH_DRYRUN=0
PISH_YES=0
PISH_PROVIDER="${PISH_PROVIDER:-}"
PISH_MODEL="${PISH_MODEL:-}"
PISH_BASE_URL="${PISH_BASE_URL:-}"
PISH_API_KEY="${PISH_API_KEY:-}"
PISH_ENGINE="${PISH_ENGINE:-ollama}"
PISH_DIR="${PISH_DIR:-/opt/pish}"
PI_AGENT_DIR="${PI_AGENT_DIR:-/root/.pi/agent}"
PI_SESSIONS_DIR="${PI_SESSIONS_DIR:-/root/.pi}"

for arg in "$@"; do
  case "$arg" in
    --port=*) PISH_PORT="${arg#*=}" ;;
    --name=*) PISH_NAME="${arg#*=}" ;;
    --workspace=*) PISH_WS="${arg#*=}" ;;
    --relay=*) PISH_RELAY="${arg#*=}" ;;
    --provider=*) PISH_PROVIDER="${arg#*=}" ;;
    --model=*) PISH_MODEL="${arg#*=}" ;;
    --base-url=*) PISH_BASE_URL="${arg#*=}" ;;
    --api-key=*) PISH_API_KEY="${arg#*=}" ;;
    --engine=*) PISH_ENGINE="${arg#*=}" ;;
    --no-systemd) PISH_SYSTEMD=0 ;;
    --dry-run) PISH_DRYRUN=1 ;;
    --yes|-y) PISH_YES=1 ;;
    -h|--help) sed -n '1,30p' "$0" | sed 's/^# \{0,1\}//' | grep -v '^=' ; exit 0 ;;
    *) echo "✗ argomento sconosciuto: $arg" >&2; exit 1 ;;
  esac
done

# ============================== HELPERS ====================================
say()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

run() {
  if [ "$PISH_DRYRUN" = 1 ]; then echo "   [dry-run] $*"; return 0; fi
  "$@"
}

need_root() {
  [ "$(id -u)" = 0 ] || die "serve root: sudo bash pish.app"
}

have() { command -v "$1" >/dev/null 2>&1; }

# Prompt con default: invio = default
ask() { # ask "domanda" "default" — prompt su stderr, risposta su stdout
  local q="$1" d="${2:-}"
  local r
  if [ "$PISH_YES" = 1 ]; then
    printf '%s\n' "$d"
    return 0
  fi
  if [ -n "$d" ]; then printf '%s [%s]: ' "$q" "$d" >&2; else printf '%s: ' "$q" >&2; fi
  read -r r
  printf '%s\n' "${r:-$d}"
}

# ============================== 1. DIPENDENZE ==============================
install_deps() {
  say "→ [1/8] Dipendenze di sistema (node ≥ 20, npm, tmux, git)"
  if [ "$PISH_DRYRUN" = 1 ]; then echo "   [dry-run] apt-get/dnf install node npm tmux git"; return 0; fi

  if have apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq nodejs npm tmux git curl ca-certificates zstd python3
  elif have dnf; then
    dnf install -y nodejs npm tmux git curl zstd python3
  elif have yum; then
    yum install -y nodejs npm tmux git curl zstd python3
  else
    warn "⚠ distribuzione non riconosciuta — assumo node/npm/tmux già presenti"
  fi

  # pi richiede node >= 20 (`import ... with { type: "json" }`)
  local ver
  ver=$(node --version 2>/dev/null | sed 's/v//;s/\..*//') || true
  if [ -z "${ver:-}" ] || [ "$ver" -lt 20 ]; then
    say "   node $(node --version 2>/dev/null || echo nessuno) troppo vecchio (serve >= 20) — installo node 22 LTS"
    if have apt-get && have curl; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y -qq nodejs
    elif { have dnf || have yum; } && have curl; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
      { have dnf && dnf install -y nodejs; } || yum install -y nodejs
    else
      die "node >= 20 richiesto (trovato: $(node --version 2>/dev/null || echo nessuno)). Installa via Nodesource o nvm e riprova."
    fi
    ver=$(node --version 2>/dev/null | sed 's/v//;s/\..*//')
    [ "$ver" -ge 20 ] || die "node ancora < 20 dopo l'install (trovato $(node --version))"
  fi
  say "   ✓ node $(node --version), npm $(npm --version), tmux $(tmux -V 2>/dev/null || echo '?')"
}

# ============================== 2. PI + ESTENSIONI =========================
install_pi() {
  say "→ [2/8] pi (coding agent) + estensioni tau-mirror / remote-pi"
  if ! have pi; then
    run npm install -g @earendil-works/pi-coding-agent
  else
    say "   ✓ pi già presente ($(pi --version 2>/dev/null || echo '?'))"
  fi
  # estensioni: installate globalmente (default) — customizzazione via pi config
  run pi install npm:tau-mirror || warn "⚠ tau-mirror install fallita"
  run pi install npm:remote-pi  || warn "⚠ remote-pi install fallita"
  say "   ✓ estensioni: tau-mirror (web UI), remote-pi (mesh mobile)"
}

# ============================== 3. ENGINE LLM ==============================
# Installa il motore di inferenza locale (default: ollama). vLLM/llama.cpp
# sono documentati ma richiedono GPU o setup manuale.
install_engine() {
  say "→ [3/8] Engine LLM ($PISH_ENGINE)"
  case "$PISH_ENGINE" in
    ollama)
      if have ollama; then
        say "   ✓ ollama già presente ($(ollama --version 2>/dev/null | head -1 || echo '?'))"
      else
        say "   Installo ollama (script ufficiale)..."
        if [ "$PISH_DRYRUN" = 1 ]; then
          echo "   [dry-run] curl -fsSL https://ollama.com/install.sh | sh"
        else
          curl -fsSL https://ollama.com/install.sh | sh || die "installazione ollama fallita"
        fi
        if [ "$PISH_DRYRUN" != 1 ]; then
          have ollama || die "ollama non trovato dopo l'install"
        fi
        say "   ✓ ollama $(ollama --version 2>/dev/null | head -1 || echo 'installato')"
      fi
      # assicura che il servizio sia attivo
      if [ "$PISH_DRYRUN" != 1 ]; then
        systemctl enable ollama 2>/dev/null || true
        systemctl start ollama 2>/dev/null || true
        sleep 2
      fi
      ;;
    vllm|llama.cpp)
      warn "⚠ engine '$PISH_ENGINE' non installato automaticamente: richiede GPU (vLLM) o setup manuale."
      warn "   Usa ollama (default) o configura l'endpoint OpenAI-compatibile con --base-url."
      ;;
    *) die "engine sconosciuto: $PISH_ENGINE (ollama | vllm | llama.cpp)" ;;
  esac
}

# ============================== 4. PROVIDER / MODELLO ======================
# Chiede all'utente provider+modello e scrive models.json + settings.json.
# Formato models.json (pi): { providers: { <id>: { api, apiKey, baseUrl, models: [{id,...}] } } }
# Posizione: $PI_AGENT_DIR/models.json
write_provider_config() {
  say "→ [4/8] Provider e modello LLM"
  mkdir -p "$PI_AGENT_DIR"

  local prov="$PISH_PROVIDER"
  local base="$PISH_BASE_URL"
  local key="$PISH_API_KEY"
  local model="$PISH_MODEL"
  local prov_id=""

  if [ -z "$prov" ]; then
    say "   Scegli il provider LLM per pi:"
    printf '     1) ollama         (locale — base URL http://localhost:11434/v1)\n'
    printf '     2) openai         (OpenAI o compatibile — richiede API key)\n'
    printf '     3) custom         (qualunque endpoint OpenAI-compatibile)\n'
    local choice
    choice=$(ask "   Scelta" "1")
    case "$choice" in
      1) prov="ollama";  base="${base:-http://localhost:11434/v1}" ;;
      2) prov="openai";  base="${base:-https://api.openai.com/v1}" ;;
      3) prov="custom" ;;
      *) die "scelta non valida: $choice" ;;
    esac
  fi

  # parametri mancanti → chiedi (se --yes, usa i default)
  case "$prov" in
    ollama)
      prov_id="ollama"
      base=$(ask "   Base URL ollama" "${base:-http://localhost:11434/v1}")
      # se possibile, elenca i modelli dall'API
      local candidates=""
      candidates=$(curl -s -m 5 "$base/models" 2>/dev/null | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin)
  print(" ".join(m.get("name","") for m in d.get("models",[])))
except Exception: pass' 2>/dev/null) || true
      if [ -n "$candidates" ]; then
        say "   Modelli disponibili: $candidates"
      fi
      model=$(ask "   Modello di default" "${model:-minicpm-v4.6}")
      # pull automatico se il modello è locale (ollama)
      if echo "$base" | grep -qE 'localhost|127\.0\.0\.1|172\.' && have ollama; then
        say "   Scarico il modello $model (può richiedere qualche minuto)..."
        run ollama pull "$model" || warn "⚠ pull modello fallito — verifica che ollama sia aggiornato (>= 0.28)"
        # pre-warm: carica il modello in RAM così il primo uso di pi non va in
        # timeout (il load di un modello 1-2GB su CPU richiede 30-60s)
        say "   Pre-warm del modello (primo caricamento, ~30-60s)..."
        run ollama run "$model" "rispondi ok" >/dev/null 2>&1 || true
      elif echo "$base" | grep -qE 'localhost|127\.0\.0\.1|172\.'; then
        warn "⚠ ollama non trovato nel PATH: pull del modello va fatto a mano (ollama pull $model)"
      fi
      ;;
    *) die "provider sconosciuto: $prov" ;;
    openai)
      prov_id="openai"
      base=$(ask "   Base URL" "${base:-https://api.openai.com/v1}")
      key=$(ask "   API key" "$key")
      [ -n "$key" ] || die "API key richiesta per provider openai"
      model=$(ask "   Modello di default" "${model:-gpt-4o-mini}")
      ;;
    custom)
      prov_id="custom"
      base=$(ask "   Base URL (OpenAI-compatibile)" "$base")
      key=$(ask "   API key (lascia vuoto se non serve)" "$key")
      model=$(ask "   ID modello" "$model")
      [ -n "$base" ] && [ -n "$model" ] || die "base-url e modello richiesti per provider custom"
      ;;
    *) die "provider sconosciuto: $prov" ;;
  esac

  # scrivi models.json
  if [ "$PISH_DRYRUN" = 1 ]; then
    echo "   [dry-run] scrivo $PI_AGENT_DIR/models.json con provider $prov_id"
    return 0
  fi

  local models_json
  models_json=$(python3 - "$prov_id" "$base" "$key" "$model" <<'PYEOF'
import json, sys
prov_id, base, key, model = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
prov = {
  "api": "openai-completions",
  "baseUrl": base,
  "models": [{"id": model, "contextWindow": 200000, "input": ["text"]}],
}
# pi richiede apiKey con almeno 1 carattere; per endpoint senza key (es. ollama
# locale) usa un placeholder non vuoto che l'endpoint ignora
prov["apiKey"] = key if key else "local
cfg = {"providers": {prov_id: prov}}
print(json.dumps(cfg, indent=1))
PYEOF
)
  printf '%s\n' "$models_json" > "$PI_AGENT_DIR/models.json"
  chmod 600 "$PI_AGENT_DIR/models.json"

  # settings.json: default provider/modello
  local settings_file="$PI_SESSIONS_DIR/settings.json"
  local settings="{}"
  if [ -f "$settings_file" ]; then
    settings=$(cat "$settings_file")
  fi
  python3 - "$settings_file" "$prov_id" "$model" <<'PYEOF'
import json, sys
path, prov, model = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path))
except Exception:
    d = {}
d["defaultProvider"] = prov
d["defaultModel"] = model
# timeout provider alto: per modelli locali su CPU il prefill può superare il
# default (~60s); 600s evita "Request timed out" sul primo uso
d.setdefault("retry", {}).setdefault("provider", {})["timeoutMs"] = 600000
json.dump(d, open(path, "w"), indent=1)
PYEOF
  say "   ✓ models.json scritto (provider $prov_id, modello $model)"
}

# ============================== 4. LAUNCHER SESSIONE =======================
write_pish_sh() {
  say "→ [5/8] Launcher sessione ($PISH_DIR/pish.sh)"
  run mkdir -p "$PISH_DIR"
  run tee "$PISH_DIR/pish.sh" > /dev/null <<PISH_EOF
#!/usr/bin/env bash
# pish — sessione pi persistente (launch da systemd o da tmux). NON eseguire a
# mano: pi deve ereditare il pty di tmux come stdin (VIETATO sleep|pipe o
# redirect su file).
set -u
PORT="\${PISH_PORT:-$PISH_PORT}"
NAME="\${PISH_NAME:-$PISH_NAME}"
WS="\${PISH_WS:-$PISH_WS}"
export TAU_MIRROR_PORT="\$PORT"

# PATH con node moderno in priorità (il node di sistema /usr/bin può essere
# troppo vecchio per pi: serve >= 20 per `import ... with { type: \"json\" }`)
NODE_BIN=""
for d in /usr/local/lib/nodejs/node-*/bin /root/.nvm/versions/node/*/bin; do
  [ -d "\$d" ] && NODE_BIN="\$d:\$NODE_BIN"
done
export PATH="\${NODE_BIN}/usr/local/bin:/usr/bin:/bin"

# workspace
mkdir -p "\$WS" || exit 1
cd "\$WS" || exit 1

# remote-pi: config di default per QUALSIASI workspace
mkdir -p "\$WS/.pi/remote-pi" "\$WS/.pi/remote"
if [ ! -f "\$WS/.pi/remote-pi/config.json" ]; then
cat > "\$WS/.pi/remote-pi/config.json" <<EOF
{
  "agent_name": "\$(basename "\$WS")",
  "auto_start_relay": true
}
EOF
fi
[ -n "$PISH_RELAY" ] && echo '{"relay":"$PISH_RELAY"}' > "\$WS/.pi/remote/config.json" 2>/dev/null

# prompt di sistema: shell intelligente
PROMPT='Sei PISH, la shell intelligente di questo server. L'\''admin ti imparte
DIRETTIVE in linguaggio naturale, non comandi. Quando ricevi una direttiva:
1) comprendi l'\''intento, 2) esegui i comandi necessari (bash/ssh/docker),
3) verifica il risultato, 4) riassumi in modo chiaro cosa hai fatto.
Regole: conferma SEMPRE prima di azioni distruttive (rm -rf, DROP, DELETE,
reboot, kill di servizi, docker rm); non inventare comandi; se un task è lungo
lancia in background con nohup e riporta il PID; usa i tool a disposizione.
Non avviare team/crew/subagent (pi-crew): rispondi direttamente.'

# modello/provider opzionali (override via env)
EXTRA=()
[ -n "\${PISH_PROVIDER:-}" ] && EXTRA+=(--provider "\$PISH_PROVIDER")
[ -n "\${PISH_MODEL:-}" ] && EXTRA+=(--model "\$PISH_MODEL")

exec pi --name "\$NAME" --append-system-prompt "\$PROMPT" "\${EXTRA[@]}" "\$@"
PISH_EOF
  run chmod +x "$PISH_DIR/pish.sh"
}

# ============================== 5. COMANDO SHELL pish ======================
# Installa /usr/local/bin/pish: la shell è usabile come tutte le altre
# (pish start/stop/status/attach/web/pair + chsh -s /usr/local/bin/pish).
write_pish_cmd() {
  say "→ [6/8] Comando shell /usr/local/bin/pish"
  run tee /usr/local/bin/pish > /dev/null <<CMD_EOF
#!/usr/bin/env bash
# pish — shell intelligente (Pi Intelligent SHell)
# Uso:
#   pish                 attach alla sessione (avvia se necessario)
#   pish start|stop|restart|status
#   pish web             stampa l'URL del web UI (tau-mirror)
#   pish pair            pairing remote-pi (app mobile)
#   pish config          wizard interattivo (provider/modello/impostazioni)
#   pish config --show   mostra la configurazione attuale
#   pish log             tail del log di sistema
# Come shell di login: chsh -s /usr/local/bin/pish
set -euo pipefail
NAME="\${PISH_NAME:-$PISH_NAME}"
SVC="pish"
LAUNCH="$PISH_DIR/pish.sh"

start_sess() {
  if ! tmux has-session -t "\$NAME" 2>/dev/null; then
    tmux new-session -d -s "\$NAME" "bash \$LAUNCH"
  fi
}

case "\${1:-}" in
  start)  start_sess; echo "✓ sessione \$NAME avviata (tau: http://\$(hostname -I 2>/dev/null | awk '{print \$1}'):\${TAU_MIRROR_PORT:-$PISH_PORT})" ;;
  stop)   tmux kill-session -t "\$NAME" 2>/dev/null && echo "✓ sessione \$NAME terminata" || echo "sessione non attiva" ;;
  restart) tmux kill-session -t "\$NAME" 2>/dev/null || true; start_sess; echo "✓ sessione riavviata" ;;
  status) if tmux has-session -t "\$NAME" 2>/dev/null; then echo "● attiva (tmux: \$NAME)"; else echo "○ ferma"; fi ;;
  web)    echo "http://\$(hostname -I 2>/dev/null | awk '{print \$1}'):\${TAU_MIRROR_PORT:-$PISH_PORT}" ;;
  pair)   tmux send-keys -t "\$NAME" "/remote-pi pair --ttl 600" Enter; echo "✓ comando di pairing inviato alla sessione \$NAME" ;;
  config) exec bash "$PISH_DIR/pish-config.sh" "\${@:2}" ;;
  show)   exec bash "$PISH_DIR/pish-config.sh" --show ;;
  log)    journalctl -u "\$SVC" -f ;;
  *)      start_sess; exec tmux attach -t "\$NAME" ;;
esac
CMD_EOF
  run chmod +x /usr/local/bin/pish

  # wizard di configurazione interattivo
  say "   ✓ wizard pish-config installato"
  if [ "$PISH_DRYRUN" = 1 ]; then
    echo "   [dry-run] copio pish-config.sh in $PISH_DIR/"
  else
    mkdir -p "$PISH_DIR"
    cp "$(dirname "$0")/pish-config.sh" "$PISH_DIR/pish-config.sh" 2>/dev/null \
      || curl -fsSL https://raw.githubusercontent.com/filippoadessi/pish/master/pish-config.sh -o "$PISH_DIR/pish-config.sh" \
      || warn "⚠ pish-config.sh non copiato (usa: pish config --show per info)"
    chmod +x "$PISH_DIR/pish-config.sh"
  fi
  say "   ✓ /usr/local/bin/pish — start/stop/status/web/pair/config/log + wizard"
}

# ============================== 6. SYSTEMD =================================
write_service() {
  [ "$PISH_SYSTEMD" = 1 ] || { warn "⏭ --no-systemd: avvio manuale con 'pish start'"; return 0; }
  say "→ [7/8] Servizio systemd pish.service"
  local env_provider="" env_model="" env_extra=""
  [ -n "$PISH_PROVIDER" ] && env_provider="Environment=PISH_PROVIDER=$PISH_PROVIDER"
  [ -n "$PISH_MODEL" ] && env_model="Environment=PISH_MODEL=$PISH_MODEL"
  run tee /etc/systemd/system/pish.service > /dev/null <<SVC_EOF
[Unit]
Description=PISH - Pi Intelligent SHell (admin assistant, tau-mirror :$PISH_PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=PISH_PORT=$PISH_PORT
Environment=PISH_NAME=$PISH_NAME
Environment=PISH_WS=$PISH_WS
${env_provider}
${env_model}
ExecStart=$PISH_DIR/pish.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC_EOF
  run systemctl daemon-reload
  run systemctl enable pish
  run systemctl restart pish
}

# ============================== 7. VERIFICA + ISTRUZIONI ===================
verify() {
  say "→ [8/8] Verifica"
  [ "$PISH_DRYRUN" = 1 ] && { echo "   [dry-run] skip"; return 0; }
  sleep 6
  if systemctl is-active --quiet pish 2>/dev/null || tmux has-session -t "$PISH_NAME" 2>/dev/null; then
    say "   ✓ sessione pish attiva"
  else
    warn "   ⚠ sessione non attiva — log: journalctl -u pish -n 50"
  fi
  if curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PISH_PORT/" 2>/dev/null | grep -q 200; then
    say "   ✓ Tau web risponde su http://127.0.0.1:$PISH_PORT"
  else
    warn "   ⚠ Tau web non ancora su :$PISH_PORT (attendi 20-40s o: pish start)"
  fi
}

instructions() {
  echo
  say "  PISH installata. Accessi:"
  echo
  echo "  🌐 TAU WEB (browser):  http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PISH_PORT"
  echo "  📱 REMOTE-PI (mobile): app Remote Pi → relay $PISH_RELAY → 'pish pair'"
  echo "  🖥  COMANDO:           pish (attach) · pish start|stop|status|web|pair|log"
  echo "  🔄  LOG:               journalctl -u pish -f"
  echo "  🐚  COME SHELL LOGIN:  chsh -s /usr/local/bin/pish  (poi ri-loggati)"
  echo
  [ "$PISH_SYSTEMD" = 1 ] && echo "  ⚙  Servizio: systemctl restart pish" || echo "  ⚙  Avvio: pish start"
  echo
}

# ============================== MAIN =======================================
main() {
  need_root
  say "═══ PISH.app — Pi Intelligent SHell installer ═══"
  say "  porta tau: $PISH_PORT · nome: $PISH_NAME · ws: $PISH_WS · relay: $PISH_RELAY"
  [ "$PISH_DRYRUN" = 1 ] && warn "  MODALITÀ DRY-RUN (nessuna modifica)"
  echo
  install_deps
  install_pi
  install_engine
  write_provider_config
  write_pish_sh
  write_pish_cmd
  write_service
  verify
  instructions
  say "═══ Installazione completata ═══"
}

main "$@"
