# PISH — Visione: la shell intelligente che rimpiazza bash

> Documento di design. Le idee sono ordinate per **impatto** (quanto avvicinano
> PISH a una vera shell) e **sforzo** (quanto costa implementarle).

## Il problema con le shell a comando

bash/zsh risolvono il 1980: l'utente deve conoscere la sintassi esatta, ricordare
migliaia di flag, incollare comandi da StackOverflow, e leggere output grezzi.
PISH inverte il rapporto: **l'utente esprime l'intento, la shell lo esegue e
verifica**. Ma per rimpiazzare davvero bash serve molto più di una chat.

---

## 1. Modalità ibrida: comando E direttiva (impatto ★★★★★, sforzo ★★)

Oggi PISH è solo NL. Una vera shell deve capire **entrambi**:

```
$ ls -la /var/log          → eseguito come comando (pass-through a bash)
$ "quali log sono cresciuti di più oggi?" → direttiva NL
$ df -h && "quanto è pieno?" → misto: comando + domanda sul risultato
```

**Come**: il prompt PISH intercetta l'input; se inizia con un comando noto
(`ls`, `cd`, `docker`, `systemctl`, `git`...) lo esegue direttamente; altrimenti
lo tratta come direttiva. Il modello vede comunque il risultato per il contesto.

## 2. Prompt ricco e stato sempre visibile (★★★★★, ★)

Un prompt stile shell ma vivo:

```
pish@server ~/proj (main) [docker: 3 up] [load 0.4] [RAM 62%] ⚡
```

- branch git, servizi docker, load, RAM, notifiche pending
- **stato del contesto**: quanti token usati, modello attivo, sessione
- colori per severità (errore, warning, ok)

## 3. Autocompletamento intelligente (★★★★★, ★★★)

Non solo completamento di comandi: **suggerimenti di direttive** basati su
contesto e storico:

```
$ "riavvia il servizio <TAB>
  → riavvia il servizio nginx
  → riavvia il servizio postgres e verifica che risponda
  → riavvia il servizio X e controlla i log dopo 30s
```

- completamento dei nomi reali (servizi systemd, container, file, host)
- suggerimenti dal comportamento passato ("l'ultima volta hai fatto...")

## 4. Storico e memoria (★★★★★, ★★★)

La shell ricorda e impara:

- **storico delle direttive** con ricerca (`pish history "riavvio nginx"`)
- **fatti appresi**: "il DB di produzione è su 10.0.0.5:5432", "il deploy si fa
  con deploy.sh" → riusati nelle direttive future
- **pattern d'uso**: "ogni mattina controlli i backup" → suggerisce la direttiva
- **preferenze**: formato output, lingua, livello di dettaglio

## 5. Scripting: direttive componibili (★★★★★, ★★★★)

Una shell senza scripting non è una shell. PISH deve permettere di **comporre
direttive in script**:

```bash
# deploy.pish — script di direttive
"fai il build del frontend"
"se il build è ok, deploy su staging"
"verifica che il sito risponda su :443"
"se ok, notifica su Telegram"
```

- linguaggio di script con **condizioni sul risultato** ("se ok...")
- esecuzione con **checkpoint**: ogni step verificato, riprendibile
- cron nativo: `pish schedule "ogni giorno alle 6: backup e verifica"`

## 6. Sicurezza e permessi (★★★★★, ★★★)

Per rimpiazzare bash in produzione serve fiducia:

- **policy per azioni**: `pish policy allow "docker restart *"` /
  `deny "rm -rf /"` / `ask` (default)
- **approvazione a due livelli**: azioni distruttive richiedono conferma
  esplicita (già parziale); azioni critiche richiedono un secondo utente
- **audit trail completo**: ogni direttiva → comandi eseguiti → output → chi
- **ruoli**: admin, operator, read-only

## 7. Multi-host nativo (★★★★, ★★★)

Una shell per tutti i server:

```
$ "stato di tutti i server"        → interroga il mesh (già c'è remote-pi)
$ "deploy su staging e prod"      → esegue su più host con verifica
$ "confronta la config di nginx tra dev e prod"
```

- il mesh remote-pi diventa il backbone: PISH parla con le altre PISH
- **fleet view**: stato di tutti i nodi in un colpo d'occhio

## 8. Output ricco (★★★★, ★★)

Niente più testo grezzo:

- **tabelle** per dati strutturati (processi, container, log)
- **diff** visuali per confronti (config, file)
- **grafici** ASCII/ANSI per metriche (CPU, RAM nel tempo)
- **link cliccabili** nel terminale (URL, file, host)

## 9. Integrazioni pronte (★★★★, ★★★)

Comandi di alto livello per i task quotidiani:

```
$ "backup del DB"            → pg_dump + compressione + verifica + rotazione
$ "aggiorna il sistema"      → apt update/upgrade con dry-run e conferma
$ "certificato SSL scade?"   → check expiry su tutti i domini
$ "quanto è pieno il disco?" → df + analisi dei maggiori occupanti
```

- **ricette** (playbook) per task comuni, condivisibili
- ogni ricetta verifica il risultato e riporta

## 10. Onboarding e primo avvio (★★★, ★★)

Il primo contatto deve vendere la shell:

- wizard di primo avvio: rileva il sistema, propone ricette, mostra esempi
- **demo guidata**: "prova a dirmi: 'quanto è pieno il disco?'"
- template di policy predefiniti (sicuro per default)

---

## Roadmap suggerita

| Fase | Contenuto | Risultato |
|---|---|---|
| **0.1** | Modalità ibrida + prompt ricco + storico | "sembra una shell" |
| **0.2** | Autocompletamento + output ricco + integrazioni base | "è comoda" |
| **0.3** | Policy/permessi + audit + scripting base | "ci si può fidare" |
| **0.4** | Multi-host + memoria + ricette condivise | "rimpiazza bash" |

## Principi guida

1. **L'intento prima della sintassi**: l'utente dice cosa vuole, non come
2. **Verifica sempre**: ogni azione ha un esito verificato, non solo eseguita
3. **Sicuro per default**: distruttivo = conferma; critico = doppia conferma
4. **Trasparente**: l'utente vede sempre cosa viene eseguito e perché
5. **Impara**: ogni interazione migliora le successive
