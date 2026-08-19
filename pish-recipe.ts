// PISH recipe — ricette pronte per i task quotidiani
// -----------------------------------------------------------------------------
// Le ricette sono script .pish condivisibili (stessa sintassi dello scripting:
// una direttiva per riga + "se ok:" / "se errore:"). Al primo avvio l'estensione
// installa le ricette di default in ~/.pi/pish/recipes/.
//
// Comandi: /recipe list · /recipe show <nome> · /recipe run <nome> · /recipe install
//
// /recipe run delega a /script run (stessa macchina a stati: checkpoint,
// ripresa, cron) passando il path assoluto della ricetta.
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RECIPES_DIR = join(homedir(), ".pi", "pish", "recipes");

// ricette di default: { name, content } — una direttiva per riga, con verifica
const DEFAULT_RECIPES: { name: string; content: string }[] = [
  {
    name: "backup-db",
    content: `# backup-db — ricetta: backup del database PostgreSQL
# una direttiva per riga; supporta "se ok:" / "se errore:" per rami condizionali
fai un backup del database PostgreSQL con pg_dump, compresso, in /root/backups, con nome datato
se ok: verifica che il file di backup sia presente, non vuoto e leggibile
se ok: elimina i backup più vecchi di 7 giorni, tenendo gli ultimi 7
notifica su Telegram che il backup del database è completato
`,
  },
  {
    name: "update-system",
    content: `# update-system — ricetta: aggiorna il sistema con verifica
# una direttiva per riga; supporta "se ok:" / "se errore:" per rami condizionali
mostra gli aggiornamenti disponibili con apt update e apt list --upgradable
se ok: chiedi conferma all'utente prima di applicare
se ok: applica gli aggiornamenti con apt upgrade -y e verifica che finisca senza errori
se ok: verifica che i servizi critici (docker, nginx, postgres) siano ancora attivi
`,
  },
  {
    name: "ssl-check",
    content: `# ssl-check — ricetta: verifica scadenza certificati SSL
# una direttiva per riga; supporta "se ok:" / "se errore:" per rami condizionali
elenca i domini serviti su porta 443 in questo server
per ogni dominio verifica la scadenza del certificato SSL con openssl s_client
mostra in tabella i certificati che scadono entro 30 giorni
se errore: segnala i domini con certificato non verificabile o già scaduto
`,
  },
  {
    name: "disk-usage",
    content: `# disk-usage — ricetta: analisi dello spazio disco
# una direttiva per riga; supporta "se ok:" / "se errore:" per rami condizionali
mostra l'occupazione dei filesystem con df -h in formato tabella
identifica le 10 cartelle che occupano di più nella root con du
se ok: segnala se qualche filesystem è oltre l'80% di occupazione
`,
  },
  {
    name: "backup-config",
    content: `# backup-config — ricetta: backup della configurazione di sistema
# una direttiva per riga; supporta "se ok:" / "se errore:" per rami condizionali
crea un backup compresso e datato di /etc in /root/backups
se ok: verifica che il file di backup sia presente, non vuoto e leggibile
se ok: mostra la dimensione e il percorso del backup creato
`,
  },
];

function ensureDir(): void {
  mkdirSync(RECIPES_DIR, { recursive: true });
}

function recipePath(name: string): string {
  return join(RECIPES_DIR, name.endsWith(".pish") ? name : `${name}.pish`);
}

function listRecipes(): string[] {
  ensureDir();
  return readdirSync(RECIPES_DIR).filter(f => f.endsWith(".pish")).sort();
}

// installa le ricette di default solo se mancanti (non sovrascrive modifiche)
function installDefaults(): void {
  ensureDir();
  for (const r of DEFAULT_RECIPES) {
    const p = recipePath(r.name);
    if (!existsSync(p)) writeFileSync(p, r.content);
  }
}

// invia un comando slash alla sessione pish (come fa pish-script con le direttive)
function sendToSession(cmd: string, ctx: any): void {
  const sess = process.env.PISH_SESSION_TMUX || "pish";
  const safe = cmd.split('"').join('\\"');
  execFile("bash", ["-c", `tmux send-keys -t '${sess}' "${safe}" Enter`], (err) => {
    if (err) ctx.ui.notify(`  ✗ tmux send-keys: ${err.message}`, "warn");
  });
}

export default function (pi: any) {
  // all'avvio garantisce le ricette di default
  pi.on("session_start", () => { installDefaults(); });

  pi.registerCommand("recipe", {
    description: "Ricette pronte per i task quotidiani (script .pish condivisibili). Uso: /recipe list | show <nome> | run <nome> | install",
    handler: async (args: string, ctx: any) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0] || "list";

      if (sub === "list") {
        const rec = listRecipes();
        ctx.ui.notify(rec.length
          ? `Ricette (${rec.length}):\n${rec.map(r => `- ${r.replace(/\.pish$/, "")}`).join("\n")}\n\nUsa: /recipe run <nome> · /recipe show <nome> · /recipe install (ripristina default)`
          : "Nessuna ricetta. Usa: /recipe install", "info");
        return;
      }
      if (sub === "show") {
        const name = parts[1];
        if (!name) { ctx.ui.notify("Uso: /recipe show <nome>", "warn"); return; }
        const p = recipePath(name);
        if (!existsSync(p)) { ctx.ui.notify(`✗ ricetta non trovata: ${name}`, "warn"); return; }
        ctx.ui.notify(readFileSync(p, "utf8"), "info");
        return;
      }
      if (sub === "run") {
        const name = parts[1];
        if (!name) { ctx.ui.notify("Uso: /recipe run <nome>", "warn"); return; }
        const p = recipePath(name);
        if (!existsSync(p)) { ctx.ui.notify(`✗ ricetta non trovata: ${name} (vedi /recipe list)`, "warn"); return; }
        ctx.ui.notify(`▶ Esecuzione ricetta: ${name} (via /script run)`, "info");
        sendToSession(`/script run ${p}`, ctx);
        return;
      }
      if (sub === "install") {
        installDefaults();
        ctx.ui.notify(`✓ Ricette di default installate in ${RECIPES_DIR} (le esistenti non sono state sovrascritte).`, "info");
        return;
      }
      ctx.ui.notify("Uso: /recipe list | show <nome> | run <nome> | install", "warn");
    },
  });
}
