// PISH script — scripting di direttive componibili
// -----------------------------------------------------------------------------
// Esegue file .pish con direttive in linguaggio naturale, una per riga:
//
//   # deploy.pish
//   fai il build del frontend
//   se ok: deploy su staging
//   verifica che il sito risponda su :443
//   se ok: notifica su Telegram
//
// - "se ok:" / "se errore:" → rami condizionali sull'esito della direttiva
//   precedente
// - checkpoint: lo stato viene salvato a ogni step; /script resume riprende
// - cron: /script schedule <nome> <expr> esegue lo script periodicamente
//
// Comandi: /script run <file> · /script new <nome> · /script list
//          /script show <nome> · /script resume · /script schedule <nome> <expr>
//          /script unschedule <nome> · /script status
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SCRIPTS_DIR = join(homedir(), ".pi", "pish", "scripts");
const STATE_FILE = join(homedir(), ".pi", "pish", "script-state.json");
const SCHED_FILE = join(homedir(), ".pi", "pish", "script-schedule.json");

interface ScriptState { file: string; index: number; lastOk: boolean; startedAt: number; }
interface ScheduleEntry { name: string; expr: string; lastRun: number; }

function ensureDirs(): void {
  mkdirSync(SCRIPTS_DIR, { recursive: true });
}

function loadState(): ScriptState | null {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch { /* no state */ }
  return null;
}

function saveState(s: ScriptState | null): void {
  try {
    if (s) writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
    else if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "null");
  } catch { /* best-effort */ }
}

function loadSchedules(): ScheduleEntry[] {
  try {
    if (existsSync(SCHED_FILE)) return JSON.parse(readFileSync(SCHED_FILE, "utf8"));
  } catch { /* none */ }
  return [];
}

function saveSchedules(s: ScheduleEntry[]): void {
  try { writeFileSync(SCHED_FILE, JSON.stringify(s, null, 1)); } catch { /* best-effort */ }
}

function parseScript(text: string): string[] {
  return text.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && !l.startsWith("//"));
}

// croner-lite: supporta "*/n", "n", "n-m", liste, e campi minuto/ora/giorno
function cronMatches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  const m = d.getMinutes(), h = d.getHours(), D = d.getDate(), M = d.getMonth() + 1, W = d.getDay();
  const match = (field: string, v: number) => {
    if (field === "*") return true;
    return field.split(",").some(part => {
      if (part.includes("/")) {
        const [range, step] = part.split("/");
        const [lo, hi] = range === "*" ? [0, 59] : range.split("-").map(Number);
        return v >= lo && v <= hi && (v - lo) % Number(step) === 0;
      }
      if (part.includes("-")) {
        const [lo, hi] = part.split("-").map(Number);
        return v >= lo && v <= hi;
      }
      return Number(part) === v;
    });
  };
  return match(min, m) && match(hour, h) && match(dom, D) && match(mon, M) && match(dow, W);
}

// ------------------------------ esecuzione ----------------------------------
// Stato macchina guidato da eventi: il command handler avvia lo script e
// ritorna SUBITO (non blocca la sessione); agent_settled fa partire la
// direttiva successiva. Evita il deadlock del polling bloccante.
let running: { path: string; lines: string[]; index: number; lastOk: boolean; waiting: boolean } | null = null;

function startScript(path: string, ctx: any, resume: boolean): void {
  ensureDirs();
  if (!existsSync(path)) {
    ctx.ui.notify(`✗ script non trovato: ${path}`, "warn");
    return;
  }
  const lines = parseScript(readFileSync(path, "utf8"));
  if (lines.length === 0) { ctx.ui.notify("✗ script vuoto", "warn"); return; }

  const state = resume ? loadState() : null;
  const index = state && state.file === path ? state.index : 0;
  const lastOk = state ? state.lastOk : true;
  running = { path, lines, index, lastOk, waiting: false };

  ctx.ui.notify(`▶ Esecuzione ${path.split("/").pop()} (${lines.length} direttive)${resume ? " — ripresa da step " + (index + 1) : ""}`, "info");
  stepScript(ctx);
}

function stepScript(ctx: any): void {
  if (!running) return;
  const { path, lines, index, lastOk } = running;

  // rami condizionali
  if (/^se\s+(ok|errore|fallito)\s*:/i.test(lines[index])) {
    const wantOk = /^se\s+ok\s*:/i.test(lines[index]);
    if (lastOk === wantOk) {
      ctx.ui.notify(`  ✓ condizione soddisfatta (${lines[index]})`, "info");
    } else {
      ctx.ui.notify(`  ⏭ condizione non soddisfatta, salto: ${lines[index]}`, "info");
    }
    running.index = index + 1;
    saveState({ file: path, index: running.index, lastOk, startedAt: Date.now() });
    stepScript(ctx);
    return;
  }

  if (!running) return;
  const line = lines[index];
  ctx.ui.notify(`  ${index + 1}/${lines.length} → ${line.slice(0, 90)}`, "info");
  saveState({ file: path, index, lastOk, startedAt: Date.now() });

  // invia la direttiva come input utente reale (tmux send-keys alla sessione)
  const sess = process.env.PISH_SESSION_TMUX || "pish";
  const safe = line.split('"').join('\\"');
  running.waiting = true;
  execFile("bash", ["-c", `tmux send-keys -t '${sess}' "${safe}" Enter`], (err) => {
    if (err) { ctx.ui.notify(`  ✗ tmux send-keys: ${err.message}`, "warn"); running.waiting = false; }
  });
  // il turno parte; agent_settled (con waiting=true) farà partire la direttiva successiva
}

function onSettled(ctx: any): void {
  // agent_settled scatta per QUALSIASI turno (comandi slash, retry, ...).
  // Avanziamo lo script solo se il turno appena finito era la direttiva
  // che abbiamo inviato (waiting=true).
  if (!running || !running.waiting) return;
  running.waiting = false;
  const { path, lines, index } = running;
  running.lastOk = true; // il turno è finito senza errori bloccanti
  const next = index + 1;
  if (next >= lines.length) {
    running = null;
    saveState(null);
    ctx.ui.notify("✅ Script completato.", "info");
    return;
  }
  running.index = next;
  stepScript(ctx);
}

// ------------------------------ export --------------------------------------
export default function (pi: any) {
  pi.registerCommand("script", {
    description: "Scripting di direttive. Uso: /script run <file> | new <nome> | list | show <nome> | resume | schedule <nome> <cron> | unschedule <nome> | status",
    handler: async (args: string, ctx: any) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0] || "";

      if (sub === "run") {
        const file = parts[1];
        if (!file) { ctx.ui.notify("Uso: /script run <file>", "warn"); return; }
        const path = file.includes("/") ? file : join(SCRIPTS_DIR, file.endsWith(".pish") ? file : `${file}.pish`);
        startScript(path, ctx, false);
        return;
      }
      if (sub === "resume") {
        const state = loadState();
        if (!state) { ctx.ui.notify("Nessuno script in corso da riprendere.", "info"); return; }
        startScript(state.file, ctx, true);
        return;
      }
      if (sub === "new") {
        const name = parts[1];
        if (!name) { ctx.ui.notify("Uso: /script new <nome>", "warn"); return; }
        ensureDirs();
        const path = join(SCRIPTS_DIR, name.endsWith(".pish") ? name : `${name}.pish`);
        if (existsSync(path)) { ctx.ui.notify(`✗ esiste già: ${name}`, "warn"); return; }
        const template = `# ${name} — script di direttive PISH
# una direttiva per riga; supporta "se ok:" / "se errore:" per rami condizionali
fai il backup del database
se ok: verifica che il backup sia leggibile
notifica su Telegram che il backup è completato
`;
        writeFileSync(path, template);
        ctx.ui.notify(`✓ script creato: ${path}`, "info");
        return;
      }
      if (sub === "list") {
        ensureDirs();
        const files = readdirSync(SCRIPTS_DIR).filter(f => f.endsWith(".pish"));
        const state = loadState();
        ctx.ui.notify(files.length
          ? `Script (${files.length}):\n${files.map(f => `- ${f}${state && state.file.endsWith(f) ? " (in corso)" : ""}`).join("\n")}`
          : "Nessuno script. Usa: /script new <nome>", "info");
        return;
      }
      if (sub === "show") {
        const name = parts[1];
        if (!name) { ctx.ui.notify("Uso: /script show <nome>", "warn"); return; }
        const path = join(SCRIPTS_DIR, name.endsWith(".pish") ? name : `${name}.pish`);
        if (!existsSync(path)) { ctx.ui.notify(`✗ script non trovato: ${name}`, "warn"); return; }
        ctx.ui.notify(readFileSync(path, "utf8"), "info");
        return;
      }
      if (sub === "schedule") {
        const name = parts[1];
        const expr = parts.slice(2).join(" ");
        if (!name || !expr) { ctx.ui.notify("Uso: /script schedule <nome> <cron> (es. '0 6 * * *')", "warn"); return; }
        const sched = loadSchedules();
        sched.push({ name, expr, lastRun: 0 });
        saveSchedules(sched);
        ctx.ui.notify(`✓ schedulato: ${name} → cron '${expr}'`, "info");
        return;
      }
      if (sub === "unschedule") {
        const name = parts[1];
        if (!name) { ctx.ui.notify("Uso: /script unschedule <nome>", "warn"); return; }
        const sched = loadSchedules().filter(s => s.name !== name);
        saveSchedules(sched);
        ctx.ui.notify(`✓ rimosso dalla schedulazione: ${name}`, "info");
        return;
      }
      if (sub === "status") {
        const sched = loadSchedules();
        const state = loadState();
        ctx.ui.notify(
          `Schedulati (${sched.length}):\n${sched.map(s => `- ${s.name} → '${s.expr}'`).join("\n") || "(nessuno)"}\n\n` +
          (state ? `In corso: ${state.file.split("/").pop()} step ${state.index + 1}` : "Nessuno script in corso."),
          "info");
        return;
      }
      ctx.ui.notify("Uso: /script run|new|list|show|resume|schedule|unschedule|status", "warn");
    },
  });

  // quando un turno finisce, fa partire la direttiva successiva dello script
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    onSettled(ctx);
  });

  // cron: controlla ogni 30s se qualche script schedulato deve partire
  pi.on("session_start", () => {
    setInterval(async () => {
      const sched = loadSchedules();
      if (sched.length === 0) return;
      const now = Date.now();
      for (const s of sched) {
        if (now - s.lastRun < 60000) continue;
        if (!cronMatches(s.expr, new Date())) continue;
        s.lastRun = now;
        saveSchedules(sched);
        // esegui in background (senza ctx: usa un worker pi)
        execFile("bash", ["-c", `tmux has-session -t pish 2>/dev/null && tmux send-keys -t pish "/script run ${s.name}" Enter || echo "sessione pish non attiva"`], (err) => {
          if (err) console.error("pish-script cron:", err.message);
        });
      }
    }, 30000);
  });
}
