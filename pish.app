#!/usr/bin/env bash
# =============================================================================
# PISH.app — Pi Intelligent SHell: installer self-contained per server vergine
# -----------------------------------------------------------------------------
# Cosa fa, su un server Linux appena creato:
#   1. Installa le dipendenze (node, npm, tmux, git)
#   2. Installa pi (npm: @earendil-works/pi-coding-agent) + estensioni
#      tau-mirror (web UI browser) e remote-pi (mesh + app mobile)
#   3. Crea il servizio systemd `pish` che avvia una sessione pi persistente
#      in tmux, con tau-mirror su TAU_MIRROR_PORT (default 3810)
#   4. Configura il system prompt della sessione come "shell intelligente":
#      l'admin impartisce DIRETTIVE in linguaggio naturale, non comandi
#   5. Stampa come accedervi (tau web, pairing mobile, tmux attach)
#
# Uso:   sudo bash pish.app [--port 3810] [--name pish] [--workspace /root]
#        --dry-run   mostra cosa farebbe senza eseguire
#        --relay URL usa un relay remote-pi personalizzato
#        --no-systemd  non installa il servizio (avvio manuale)
# -----------------------------------------------------------------------------
set -euo pipefail

# ============================== CONFIG =====================================
PISH_PORT="${PISH_PORT:-3810}"
PISH_NAME="${PISH_NAME:-pish}"
PISH_WS="${PISH_WS:-/root}"
PISH_RELAY="${PISH_RELAY:-https://relay.adessi.it}"
PISH_SYSTEMD=1
PISH_DRYRUN=0
PISH_PROVIDER="${PISH_PROVIDER:-}"
PISH_MODEL="${PISH_MODEL:-}"
PISH_DIR="${PISH_DIR:-/opt/pish}"

for arg in "$@"; do
  case "$arg" in
    --port=*) PISH_PORT="${arg#*=}" ;;
    --name=*) PISH_NAME="${arg#*=}" ;;
    --workspace=*) PISH_WS="${arg#*=}" ;;
    --relay=*) PISH_RELAY="${arg#*=}" ;;
    --provider=*) PISH_PROVIDER="${arg#*=}" ;;
    --model=*) PISH_MODEL="${arg#*=}" ;;
    --no-systemd) PISH_SYSTEMD=0 ;;
    --dry-run) PISH_DRYRUN=1 ;;
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

# ============================== 1. DIPENDENZE ==============================
install_deps() {
  say "→ [1/6] Dipendenze di sistema (node, npm, tmux, git)"
  if [ "$PISH_DRYRUN" = 1 ]; then echo "   [dry-run] apt-get install -y nodejs npm tmux git"; return 0; fi

  if have apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq nodejs npm tmux git curl ca-certificates
  elif have dnf; then
    dnf install -y nodejs npm tmux git curl
  elif have yum; then
    yum install -y nodejs npm tmux git curl
  else
    warn "⚠ distribuzione non riconosciuta — assumo node/npm/tmux già presenti"
  fi

  # node minimo
  local ver
  ver=$(node --version 2>/dev/null | sed 's/v//;s/\..*//') || true
  if [ -z "${ver:-}" ] || [ "$ver" -lt 18 ]; then
    die "node >= 18 richiesto (trovato: $(node --version 2>/dev/null || echo nessuno)). Installalo via nodesource o nvm e riprova."
  fi
  say "   ✓ node $(node --version), npm $(npm --version), tmux $(tmux -V 2>/dev/null || echo '?')"
}

# ============================== 2. PI + ESTENSIONI =========================
install_pi() {
  say "→ [2/6] pi (coding agent) + estensioni tau-mirror / remote-pi"
  if ! have pi; then
    run npm install -g @earendil-works/pi-coding-agent
  else
    say "   ✓ pi già presente ($(pi --version 2>/dev/null || echo '?'))"
  fi
  run pi install npm:tau-mirror || warn "⚠ tau-mirror install fallita"
  run pi install npm:remote-pi  || warn "⚠ remote-pi install fallita"
}

# ============================== 3. SESSIONE PERSISTENTE ====================
write_pish_sh() {
  say "→ [3/6] Launcher sessione ($PISH_DIR/pish.sh)"
  run mkdir -p "$PISH_DIR"
  run tee "$PISH_DIR/pish.sh" > /dev/null <<PISH_EOF
#!/usr/bin/env bash
# pish — sessione pi persistente (launch da systemd). NON eseguire a mano:
# pi deve ereditare il pty di tmux come stdin (VIETATO sleep|pipe o redirect).
set -u
PORT="\${PISH_PORT:-$PISH_PORT}"
NAME="\${PISH_NAME:-$PISH_NAME}"
WS="\${PISH_WS:-$PISH_WS}"
export TAU_MIRROR_PORT="\$PORT"

# PATH con node moderno in priorità (il node di sistema /usr/bin può essere
# troppo vecchio per pi: serve >= 20 per `import ... with { type: "json" }`)
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

# modello/provider opzionali
EXTRA=()
[ -n "$PISH_PROVIDER" ] && EXTRA+=(--provider "$PISH_PROVIDER")
[ -n "$PISH_MODEL" ] && EXTRA+=(--model "$PISH_MODEL")

exec pi --name "\$NAME" --append-system-prompt "\$PROMPT" "\${EXTRA[@]}" "\$@"
PISH_EOF
  run chmod +x "$PISH_DIR/pish.sh"
}

# ============================== 4. SYSTEMD =================================
write_service() {
  [ "$PISH_SYSTEMD" = 1 ] || { warn "⏭ --no-systemd: salto unit (avvio manuale: sudo -u root tmux new -d -s pish '$PISH_DIR/pish.sh')"; return 0; }
  say "→ [4/6] Servizio systemd pish.service"
  local env_provider="" env_model=""
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

# ============================== 5. VERIFICA ================================
verify() {
  say "→ [5/6] Verifica"
  [ "$PISH_DRYRUN" = 1 ] && { echo "   [dry-run] skip"; return 0; }
  sleep 6
  if systemctl is-active --quiet pish 2>/dev/null; then
    say "   ✓ servizio pish attivo"
  else
    warn "   ⚠ servizio non attivo — log: journalctl -u pish -n 50"
  fi
  if curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PISH_PORT/" 2>/dev/null | grep -q 200; then
    say "   ✓ Tau web risponde su http://127.0.0.1:$PISH_PORT"
  else
    warn "   ⚠ Tau web non ancora su :$PISH_PORT (attendi 20-40s: systemctl restart pish)"
  fi
}

# ============================== 6. ISTRUZIONI ==============================
instructions() {
  say "→ [6/6] Accesso"
  echo
  echo "  PISH è in esecuzione. Accessi:"
  echo
  echo "  🌐 TAU WEB (browser):  http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PISH_PORT"
  echo "                          chat diretta in linguaggio naturale con la shell"
  echo
  echo "  📱 REMOTE-PI (mobile): apri l'app Remote Pi → relay $PISH_RELAY"
  echo "                          poi nella sessione: /remote-pi pair"
  echo
  echo "  🖥  TMUX:               tmux attach -t pish   (Ctrl+B D per staccare)"
  echo "  📜  LOG:                journalctl -u pish -f"
  echo "  🔄  RESTART:            systemctl restart pish"
  echo
  if [ -z "$PISH_PROVIDER" ] && [ -z "$PISH_MODEL" ]; then
    warn "  ⚠ Nessun provider/modello configurato: imposta in /etc/systemd/system/pish.service"
    warn "    Environment=PISH_PROVIDER=<provider>  PISH_MODEL=<model>  poi systemctl restart pish"
    warn "    (oppure: pi auth / API key in ambiente del servizio)"
  fi
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
  write_pish_sh
  write_service
  verify
  instructions
  say "═══ Installazione completata ═══"
}

main "$@"
