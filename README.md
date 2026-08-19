# PISH.app — Pi Intelligent SHell

Installer **single-file, self-contained** che trasforma un server Linux in una
shell intelligente basata su [pi](https://github.com/badlogic/pi-mono):
l'amministratore imparte **direttive in linguaggio naturale** invece di comandi,
da browser o da app mobile.

## Installazione

Su un server Linux fresco, come root:

```bash
bash pish.app [opzioni]
```

Il server deve avere accesso a un provider LLM per pi (vedi "Provider LLM").

### Opzioni

| Opzione | Default | Descrizione |
|---|---|---|
| `--port` | `3810` | Porta del web UI (tau-mirror) |
| `--name` | `pish` | Nome della sessione e del servizio |
| `--workspace` | `/root` | Directory di lavoro della sessione |
| `--relay` | `https://relay.adessi.it` | Relay remote-pi per l'accesso mobile |
| `--provider` | — | Provider LLM per pi |
| `--model` | — | Modello LLM per pi |
| `--no-systemd` | — | Non installa il servizio systemd (avvio manuale) |
| `--dry-run` | — | Mostra le azioni senza eseguirle |

### Provider LLM

Pi richiede un provider configurato. Esempi:

```bash
# Ollama locale
bash pish.app --provider=ollama --model=qwen2.5:0.5b

# OpenAI-compatibile / API key
bash pish.app --provider=openai --model=gpt-4o-mini
```

Se omesso, la sessione parte comunque ma va configurato il provider in seguito
(`pi auth` / variabili d'ambiente del servizio).

## Cosa installa

1. **Dipendenze**: node ≥ 20, npm, tmux, git (apt/dnf/yum); se il node di
   sistema è < 20 installa node 22 LTS via Nodesource
2. **pi** (`npm i -g @earendil-works/pi-coding-agent`) + estensioni
   `tau-mirror` (web UI) e `remote-pi` (mesh mobile)
3. **Servizio systemd `pish`**: sessione pi persistente in tmux con restart
   automatico e porta dedicata per il web UI
4. **System prompt "shell intelligente"**: direttive in linguaggio naturale,
   conferma prima di azioni distruttive, nessuna orchestrazione subagent,
   task lunghi lanciati in background con riporto del PID

## Accesso

| Canale | Come |
|---|---|
| 🌐 Browser | `http://<server>:3810` — chat diretta in linguaggio naturale |
| 📱 Mobile | app Remote Pi → relay → `/remote-pi pair` nella sessione |
| 🖥 Terminale | `tmux attach -t pish` (Ctrl+B D per staccare) |
| 📜 Log | `journalctl -u pish -f` |

## Comandi utili

```bash
systemctl restart pish        # riavvia la sessione
journalctl -u pish -f         # log in tempo reale
tmux attach -t pish           # attach alla sessione
```
