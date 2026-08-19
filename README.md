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
# Ollama locale (default: MiniCPM-V 4.6 — vision, tool calling, 1.6 GB,
# scaricato automaticamente all'installazione)
bash pish.app --provider=ollama

# Endpoint OpenAI-compatibile / API key
bash pish.app --provider=openai --model=gpt-4o-mini
```

### Modello di default

L'installer scarica un modello **piccolo** (`qwen2.5:1.5b`, ~1 GB) giusto per
far partire PISH subito. Poi, con `pish config`, scegli il modello che preferisci
(più capace, più veloce, ecc.) o un provider cloud.

### Engine LLM

| Engine | Default | Note |
|---|---|---|
| `ollama` | ✅ | Installato automaticamente; CPU/GPU; modello piccolo incluso |
| `none` | — | **Versione leggera cloud-only**: niente ollama, usi un provider cloud |
| `vllm` | — | Solo GPU NVIDIA; richiede setup manuale (CUDA, ~10 GB) |
| `llama.cpp` | — | CPU-only leggero; setup manuale |

Esempi:

```bash
# Installazione completa con engine locale
bash pish.app

# Versione leggera: niente ollama, pish lavora con un modello cloud
bash pish.app --engine=none --provider=anthropic --api-key=sk-ant-... --model=claude-sonnet-4-6
bash pish.app --engine=none --provider=openrouter --api-key=sk-or-... --model=anthropic/claude-sonnet-4
```

Con `--engine=none` ollama non viene installato; configuri il provider dopo
con `pish config` (o lo installi in seguito: `ollama serve` + `pish config → provider → ollama`).

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
pish config                   # wizard interattivo: cambia provider/modello/impostazioni
pish config --show            # mostra la configurazione attuale (key mascherate)
pish login-on|off|status      # abilita/disabilita pish come shell di login
systemctl restart pish        # riavvia la sessione
journalctl -u pish -f         # log in tempo reale
tmux attach -t pish           # attach alla sessione
```

## Wizard di configurazione

`pish config` apre un wizard interattivo che permette di cambiare **senza
reinstallare**:

- **Provider e modello LLM**:
  - `ollama` — locale, MiniCPM-V 4.6 scaricato automaticamente
  - `anthropic` — Claude cloud (API key `sk-ant-...`)
  - `openai` — GPT cloud (API key `sk-...`)
  - `openrouter` — OpenRouter, molti modelli con una sola key (`sk-or-...`)
  - `deepseek` — DeepSeek cloud, economico (`sk-...`)
  - `groq` — Groq, velocissimo con modelli free (`gsk_...`)
  - `mistral` — Mistral AI cloud
  - `xai` — xAI Grok cloud (`xai-...`)
  - `custom` — qualunque endpoint OpenAI-compatibile (vLLM, LiteLLM)
- **Login shell**: entra **direttamente in pish al login** (al posto di bash)
- **Impostazioni di base**: porta web UI, nome sessione, workspace, relay mobile

Le API key sono salvate in `~/.pi/agent/auth.json` (formato pi, permessi 600);
provider custom e modelli in `~/.pi/agent/models.json`; default in
`~/.pi/settings.json`. La sessione viene riavviata automaticamente.

Uso scripted (per automation):

```bash
pish config --noninteractive --provider anthropic --api-key sk-ant-... --model claude-sonnet-4-6
pish config --noninteractive --provider ollama --model minicpm-v4.6
pish config --noninteractive --provider openrouter --api-key sk-or-... --model anthropic/claude-sonnet-4
```

### Pish come shell di login

Al prossimo login dell'utente si entra **direttamente in PISH** (attach alla
sessione) invece di bash:

```bash
pish login-on        # abilita: al login entri direttamente in pish
pish login-off       # disabilita: torna a bash
pish login-status    # mostra lo stato attuale
# oppure via wizard: pish config → menu → login → enable/disable
```

- Per uscire da pish: `/exit` o `/quit` (comandi slash) oppure `exit`/Ctrl+D
- `/exit` stacca dalla sessione (resta attiva in background, riattacchi con `pish`)
- `/quit` termina la sessione definitivamente (chiede conferma)
- Utente diverso da root: `pish login-off filippo`
- Nota: serve che l'utente abbia una sessione pish attiva o che `pish start`
  sia eseguibile al login (il comando attacha e avvia se serve)
