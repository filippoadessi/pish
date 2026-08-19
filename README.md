# PISH.app — Pi Intelligent SHell

Installer **single-file, self-contained** per creare su un server Linux vergine
una "shell intelligente" basata su pi: l'admin imparte **direttive in linguaggio
naturale** invece di comandi, da browser (tau-mirror) o da app mobile (remote-pi).

## Installazione (server vergine)

```bash
# copia il file e avvialo come root
scp pish.app root@server:/tmp/
ssh root@server
sudo bash /tmp/pish.app --provider=ollama-cloud-backup --model=deepseek-v4-flash:0731
```

Opzioni: `--port` (tau, default 3810) · `--name` (default pish) · `--workspace`
(default /root) · `--relay` · `--provider`/`--model` · `--no-systemd` · `--dry-run`

## Cosa installa

1. **Dipendenze**: node>=18, npm, tmux, git (apt/dnf/yum)
2. **pi** (`npm i -g @earendil-works/pi-coding-agent`) + estensioni
   `tau-mirror` (web UI) e `remote-pi` (mesh/mobile)
3. **Servizio systemd `pish`**: sessione pi persistente in tmux, restart
   automatico, `TAU_MIRROR_PORT` dedicata
4. **System prompt "shell intelligente"**: direttive in NL, conferma prima di
   azioni distruttive, no team/crew, long-running in background con PID

## Accesso

| Canale | Come |
|---|---|
| 🌐 Browser | `http://<server>:3810` (tau-mirror, chat diretta) |
| 📱 Mobile | app Remote Pi → relay → `/remote-pi pair` nella sessione |
| 🖥 Terminale | `tmux attach -t pish` (Ctrl+B D = stacca) |
| 📜 Log | `journalctl -u pish -f` |

## Note tecniche (lezione appresa dalla ricetta mac-filippo)

- pi deve ereditare il **pty di tmux** come stdin — VIETATO `sleep | pi` o
  redirect su file (pi fa "Session shutdown")
- **PATH con node moderno in priorità**: il node di sistema (`/usr/bin`, spesso
  v18) crasha pi con `SyntaxError: 'with'` (import attributes). Il launcher
  cerca `/usr/local/lib/nodejs/node-*/bin` e `~/.nvm/versions/node/*/bin` prima
- Config remote-pi auto-generata per workspace (`agent_name`, `auto_start_relay`)

## Verificato

- 19/08/2026 su devhost (test reale, `--no-systemd`, porta 3999):
  - tau-mirror HTTP 200 su porta dedicata
  - direttiva "load average e RAM?" → riepilogo corretto (load 11.13/12, swap)
  - direttiva "ultime 5 righe journalctl + errori critici?" → sintesi accurata
  - config remote-pi generata (`agent_name`, relay adessi.it)
