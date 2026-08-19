# PISH — Pi Intelligent SHell

> [![Release](https://img.shields.io/github/v/release/filippoadessi/pish)](https://github.com/filippoadessi/pish/releases)
> **🆕 v0.0.1 — prova e dacci feedback!** Leggi la [guida rapida](#prova-pish-e-inviaci-i-tuoi-commenti)
> in fondo, apri una [issue](https://github.com/filippoadessi/pish/issues) o scrivici i tuoi commenti.

Installer **single-file, self-contained** che trasforma un server Linux in una
shell intelligente basata su [pi](https://github.com/badlogic/pi-mono):
l'amministratore imparte **direttive in linguaggio naturale** invece di comandi,
da browser (tau-mirror) o da app mobile (remote-pi).

## Due versioni

| File | Engine | Quando usarla |
|---|---|---|
| **`pish.app`** | Ollama locale (default) | Server con risorse per un modello locale; scarica `qwen2.5:1.5b` (~1 GB) |
| **`pish-lite.app`** | Nessuno (cloud-only) | Server piccoli o dove il modello gira altrove; niente Ollama, usi un provider cloud |

Entrambe sono **self-contained** (nessun download extra dal repo) e installano:
node, pi + estensioni (tau-mirror, remote-pi), servizio systemd, comando `pish`,
wizard `pish config`, estensione `/exit` `/quit`.

## Installazione

Su un server Linux fresco, come root — **una riga, senza scaricare nulla prima**:

```bash
# (se curl manca su un server minimale: apt-get update && apt-get install -y curl)
# versione completa (engine locale + modello piccolo di default)
curl -fsSL https://github.com/filippoadessi/pish/releases/latest/download/pish.app.sh -o pish.app && sudo bash pish.app

# versione leggera cloud-only (niente Ollama)
curl -fsSL https://github.com/filippoadessi/pish/releases/latest/download/pish-lite.app.sh -o pish-lite.app && sudo bash pish-lite.app --provider=anthropic --api-key=sk-ant-...
```

(`/releases/latest/download/...` punta sempre all'ultima release; gli asset hanno
estensione `.sh` per le regole di GitHub, ma il contenuto è lo stesso installer
self-contained.)

Entrambe supportano l'interazione: senza flag il wizard chiede provider/modello
durante l'install (vedi "Provider LLM").

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

### Opzioni comuni alle due versioni

| Opzione | Default | Descrizione |
|---|---|---|
| `--port` | `3810` | Porta del web UI (tau-mirror) |
| `--name` | `pish` | Nome della sessione e del servizio |
| `--workspace` | `/root` | Directory di lavoro della sessione |
| `--relay` | `https://relay.adessi.it` | Relay remote-pi per l'accesso mobile |
| `--engine` | `ollama` (pish.app) / `none` (pish-lite.app) | Engine LLM locale |
| `--provider` | — | Provider LLM (ollama/anthropic/openai/openrouter/...) |
| `--model` | — | Modello LLM |
| `--no-systemd` | — | Non installa il servizio systemd (avvio manuale) |
| `--dry-run` | — | Mostra le azioni senza eseguirle |

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

## Prova PISH e inviaci i tuoi commenti

**v0.0.1 è appena uscita** — siamo in beta e vogliamo il tuo feedback!

### Come provarla (2 minuti)

```bash
# su un server Linux (Ubuntu/Debian/RHEL) con sudo:
curl -fsSL https://github.com/filippoadessi/pish/releases/download/v0.0.1/pish-lite.app -o pish-lite.app && sudo bash pish-lite.app --provider=anthropic --api-key=sk-ant-...
# oppure la versione con engine locale:
curl -fsSL https://github.com/filippoadessi/pish/releases/download/v0.0.1/pish.app -o pish.app && sudo bash pish.app
```

Poi: `pish config` per il wizard, `pish login-on` per entrare al login, browser su
`http://<server>:3810` per la chat, app Remote Pi per il telefono.

### Come inviare commenti

- **Issues**: [github.com/filippoadessi/pish/issues](https://github.com/filippoadessi/pish/issues) — bug, suggerimenti, richieste
- **Cosa ci interessa sapere**:
  - L'installazione su quale distro/versione hai provato
  - Quale provider/modello usi (locale o cloud)
  - Cosa funziona e cosa non funziona per te
  - Idee per il wizard, la chat, il login, il pairing mobile
- Template issue: apri una issue e includi `pish config --show` e `journalctl -u pish -n 50` se è un problema

**Grazie per aver provato PISH!** 🚀

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

### Modalità ibrida e orchestrazione

**Modalità ibrida** (estensione `pish-hybrid`): l'input che inizia con un comando
noto (`ls`, `docker`, `systemctl`, `git`, `df`, `ps`, ...) viene eseguito
**direttamente** — zero token LLM, output immediato. Tutto il resto è una
direttiva in linguaggio naturale per il modello.

**Orchestrazione multicore** (utile su sistemi multi-core): la shell può
istanziare worker pi in tmux e orchestrarli:

```bash
/spawn w1 "analizza i log di nginx"   # istanzia un worker pi (tmux: pi-worker-w1)
/workers                              # elenca i worker attivi
/send w1 "ora controlla il disco"     # invia un task a un worker
/kill w1                              # termina il worker
```

Ogni worker è una sessione pi completa (mesh remote-pi, tau-mirror su porta
propria) — la shell principale li orchestra via intercom/messaggi.

**Prompt vivo**: a ogni turno PISH inietta lo stato del sistema (load, RAM,
disco, docker, git branch, servizi falliti) — il modello sa sempre com'è il
server senza che tu glielo chieda.

**Memoria persistente** (`~/.pi/pish/memory.json`): PISH ricorda tra le sessioni.

```bash
/remember db-prod-host = 10.0.0.5:5432   # salva un fatto
/facts                                    # elenca i fatti appresi
/history [query]                          # cerca nello storico delle direttive
/forget <chiave>                          # rimuove un fatto
/memory                                   # mostra tutto
/forget-all                               # cancella la memoria
```

Il modello salva da solo i fatti stabili che scopre (via tool `remember_fact`),
e a ogni turno la memoria viene iniettata nel prompt: chiedi "qual è l'host del
DB?" e risponde dalla memoria, senza eseguire comandi.

**Policy di sicurezza e audit** (`~/.pi/pish/policy.json` + `audit.log`):

```bash
/policy                                   # mostra policy e ruoli
/policy deny "rm -rf *"                   # blocca un pattern
/policy allow "docker restart *"          # consente un pattern
/policy ask "systemctl restart *"         # chiede conferma
/policy remove <id>                       # rimuove una policy
/role filippo operator                    # ruoli: admin | operator | readonly
/audit [n]                                # ultime n voci di audit
```

- **Default sicuro**: comandi pericolosi (`rm -rf`, `mkfs`, `dd`, `reboot`,
  `DROP TABLE`...) → chiedono conferma; il resto passa
- **Ruolo `readonly`**: blocca scritture/edit e comandi di modifica
- **Audit trail completo**: ogni comando registrato (chi, cosa, esito, policy)

**Output ricco** (`/output on|off|auto`, default auto): l'output dei comandi
eseguiti dal modello viene riformattato:
- `ps`, `docker ps`, `systemctl`, `df`, `free`, `ls -l` → **tabelle allineate**
- `git diff`, `diff -u` → **diff colorati** (verde/rosso/header)
- `vmstat`, `iostat`, `sar` → **grafici a barre ASCII**
- Nota: serve che l'utente abbia una sessione pish attiva o che `pish start`
  sia eseguibile al login (il comando attacha e avvia se serve)

**Scripting di direttive** (`/script`, estensione `pish-script`): esegue file
`.pish` in `~/.pi/pish/scripts/` con una direttiva per riga e rami condizionali:

```bash
# deploy.pish
fai il build del frontend
se ok: deploy su staging
verifica che il sito risponda su :443
se ok: notifica su Telegram
```

```bash
/script new deploy            # crea un nuovo script (template)
/script list                  # elenca gli script
/script show deploy           # mostra il contenuto
/script run deploy            # esegue (step by step, una direttiva per turno)
/script resume                # riprende dall'ultimo checkpoint
/script schedule deploy '0 6 * * *'   # esegue via cron ogni giorno alle 6
/script unschedule deploy     # rimuove dalla schedulazione
/script status                # schedulati + script in corso
```

- **Rami condizionali**: `se ok:` / `se errore:` fanno proseguire o saltare
  in base all'esito della direttiva precedente
- **Checkpoint**: lo stato (file + step + esito) è salvato a ogni passo in
  `~/.pi/pish/script-state.json`; `/script resume` riprende da dove si è
  fermato (anche dopo un riavvio)
- **Cron**: le espressioni supportano `*`, `*/n`, `n-m`, liste e i 5 campi
  standard (minuto, ora, giorno del mese, mese, giorno della settimana);
  lo scheduler controlla ogni 30s
- **Esecuzione**: ogni direttiva è inviata alla sessione pish come input
  utente reale (via tmux send-keys), così il modello la esegue con tutto il
  suo contesto; lo script avanza automaticamente al turno successivo

**Ricette pronte** (`/recipe`, estensione `pish-recipe`): i task quotidiani
come script `.pish` condivisibili, installati in `~/.pi/pish/recipes/`:

```bash
/recipe list                 # elenca le ricette disponibili
/recipe show backup-db       # mostra il contenuto di una ricetta
/recipe run backup-db        # esegue la ricetta (via /script run)
/recipe install              # ripristina le ricette di default (senza sovrascrivere le modificate)
```

Ricette incluse:

| Ricetta | Cosa fa |
|---|---|
| `backup-db` | backup PostgreSQL (`pg_dump` compresso datato), verifica leggibilità, rotazione 7 giorni, notifica Telegram |
| `update-system` | aggiornamenti disponibili → conferma → `apt upgrade` → verifica servizi critici |
| `ssl-check` | domini su :443, scadenza certificati, tabella con quelli a <30 giorni |
| `disk-usage` | `df -h` in tabella, top 10 cartelle con `du`, segnalazione >80% |
| `backup-config` | backup compresso datato di `/etc`, verifica integrità, dimensione |

Le ricette usano la stessa sintassi dello scripting (`se ok:` / `se errore:`),
quindi supportano checkpoint, ripresa e cron; sono anche nel repo in
`recipes/*.pish` come sorgente condivisibile.
