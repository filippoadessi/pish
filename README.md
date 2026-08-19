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

### Modello di default: MiniCPM-V 4.6

Se usi il provider `ollama` locale, l'installer:
1. **Installa il motore** (Ollama via script ufficiale, se non presente)
2. **Scarica il modello** [`minicpm-v4.6`](https://ollama.com/library/minicpm-v4.6)
   (1.6 GB, vision, supporta il tool calling necessario a pi per eseguire i comandi)
3. **Pre-warm** il modello (primo caricamento in RAM) per evitare timeout al primo uso

### Engine LLM

| Engine | Default | Note |
|---|---|---|
| `ollama` | ✅ | Installato automaticamente; CPU/GPU; già testato end-to-end |
| `vllm` | — | Solo GPU NVIDIA; richiede setup manuale (CUDA, ~10 GB) |
| `llama.cpp` | — | CPU-only leggero; setup manuale |

Scegli con `--engine=ollama|vllm|llama.cpp`. Per endpoint remoti
(OpenAI-compatibili) l'engine locale non serve: usa `--provider=openai|custom`
con `--base-url` e `--api-key`.

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
systemctl restart pish        # riavvia la sessione
journalctl -u pish -f         # log in tempo reale
tmux attach -t pish           # attach alla sessione
```

## Wizard di configurazione

`pish config` apre un wizard interattivo che permette di cambiare **senza
reinstallare**:

- **Provider e modello LLM**:
  - `ollama` — locale, MiniCPM-V 4.6 scaricato automaticamente
  - `anthropic` — Claude cloud (richiede API key `sk-ant-...`)
  - `openai` — GPT cloud (richiede API key `sk-...`)
  - `custom` — qualunque endpoint OpenAI-compatibile (OpenRouter, vLLM, LiteLLM)
- **Impostazioni di base**: porta web UI, nome sessione, workspace, relay mobile

Le API key sono salvate in `~/.pi/agent/auth.json` (formato pi, permessi 600);
provider custom e modelli in `~/.pi/agent/models.json`; default in
`~/.pi/settings.json`. La sessione viene riavviata automaticamente.

Uso scripted (per automation):

```bash
pish config --noninteractive --provider anthropic --api-key sk-ant-... --model claude-sonnet-4-6
pish config --noninteractive --provider ollama --model minicpm-v4.6
```
