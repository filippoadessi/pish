// PISH memory — storico e memoria persistente
// -----------------------------------------------------------------------------
// Persiste in ~/.pi/pish/memory.json:
//   facts    — fatti appresi ("il DB prod è su 10.0.0.5:5432", "il deploy si
//              fa con deploy.sh") — salvati dal modello via tool remember_fact
//              o dall'utente via /remember
//   history  — direttive recenti con esito (per pattern d'uso e suggerimenti)
// A ogni before_agent_start inietta nel system prompt i fatti e le direttive
// recenti, così il modello ha memoria tra le sessioni.
// Comandi: /remember <fatto> · /forget <chiave> · /facts · /history [query]
//          /memory (mostra tutto) · /forget-all
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MEM_DIR = join(homedir(), ".pi", "pish");
const MEM_FILE = join(MEM_DIR, "memory.json");
const MAX_HISTORY = 200;

interface Fact { value: string; source: string; ts: number; }
interface HistoryEntry { text: string; outcome: string; ts: number; }

function loadMemory(): { facts: Record<string, Fact>; history: HistoryEntry[] } {
  try {
    if (existsSync(MEM_FILE)) {
      const d = JSON.parse(readFileSync(MEM_FILE, "utf8"));
      return { facts: d.facts || {}, history: d.history || [] };
    }
  } catch { /* corrotto → riparti */ }
  return { facts: {}, history: [] };
}

function saveMemory(mem: { facts: Record<string, Fact>; history: HistoryEntry[] }): void {
  try {
    mkdirSync(MEM_DIR, { recursive: true });
    writeFileSync(MEM_FILE, JSON.stringify(mem, null, 1), { mode: 0o600 });
  } catch (e) { /* best-effort */ }
}

function rememberFact(key: string, value: string, source: string): void {
  const mem = loadMemory();
  mem.facts[key] = { value, source, ts: Date.now() };
  saveMemory(mem);
}

function forgetFact(key: string): boolean {
  const mem = loadMemory();
  if (!(key in mem.facts)) return false;
  delete mem.facts[key];
  saveMemory(mem);
  return true;
}

function addHistory(text: string, outcome: string): void {
  const mem = loadMemory();
  mem.history.unshift({ text, outcome, ts: Date.now() });
  mem.history = mem.history.slice(0, MAX_HISTORY);
  saveMemory(mem);
}

function formatFacts(facts: Record<string, Fact>): string {
  const lines = Object.entries(facts).map(([k, f]) => `- ${k}: ${f.value}`);
  return lines.join("\n");
}

// ------------------------- iniezione nel prompt ------------------------------
async function injectMemory(event: any): Promise<string | undefined> {
  const mem = loadMemory();
  const parts: string[] = [];

  const facts = Object.entries(mem.facts);
  if (facts.length > 0) {
    parts.push(`[MEMORIA — fatti appresi]\n${formatFacts(Object.fromEntries(facts))}`);
  }

  if (mem.history.length > 0) {
    const recent = mem.history.slice(0, 8).map(h => `- ${h.text} (${h.outcome})`);
    parts.push(`[MEMORIA — direttive recenti]\n${recent.join("\n")}`);
  }

  if (parts.length === 0) return undefined;
  return `\n\n${parts.join("\n\n")}\n`;
}

// ------------------------------ export --------------------------------------
export default function (pi: any) {
  // tool per il modello: salva un fatto appreso
  pi.registerTool({
    name: "remember_fact",
    label: "Remember fact",
    description: "Salva un fatto appreso sul sistema o sull'utente (es. 'il DB prod è su 10.0.0.5:5432', 'il deploy si fa con deploy.sh'). Usalo quando scopri un'informazione stabile e riutilizzabile.",
    promptSnippet: "Remember stable facts about the system or user",
    promptGuidelines: [
      "Use remember_fact when you discover a stable, reusable fact (server addresses, deploy procedures, user preferences).",
      "Use forget_fact to remove an outdated fact.",
    ],
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Chiave breve del fatto (es. 'db-prod-host')" },
        value: { type: "string", description: "Valore del fatto (es. '10.0.0.5:5432')" },
      },
      required: ["key", "value"],
    },
    async execute(_toolCallId: string, params: { key: string; value: string }) {
      rememberFact(params.key, params.value, "model");
      return { content: [{ type: "text", text: `Fatto salvato: ${params.key} = ${params.value}` }] };
    },
  });

  pi.registerTool({
    name: "forget_fact",
    label: "Forget fact",
    description: "Rimuove un fatto appreso (se non è più valido).",
    promptSnippet: "Remove an outdated fact",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "Chiave del fatto da rimuovere" } },
      required: ["key"],
    },
    async execute(_toolCallId: string, params: { key: string }) {
      const ok = forgetFact(params.key);
      return { content: [{ type: "text", text: ok ? `Fatto rimosso: ${params.key}` : `Fatto non trovato: ${params.key}` }] };
    },
  });

  // iniezione memoria a ogni turno
  pi.on("before_agent_start", async (event: any) => {
    if (event.prompt && event.prompt.startsWith("/")) return;
    const block = await injectMemory(event);
    if (!block) return;
    return { systemPrompt: event.systemPrompt + block };
  });

  // registra le direttive nello storico (a fine messaggio utente)
  pi.on("message_end", async (event: any) => {
    try {
      const m = event.message;
      if (!m || m.role !== "user") return;
      const c = m.content;
      let prompt = "";
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && part.type === "text" && part.text) { prompt = part.text; break; }
        }
      } else if (typeof c === "string") { prompt = c; }
      if (!prompt || prompt.startsWith("/")) return;
      addHistory(prompt.slice(0, 200), "ok");
    } catch { /* best-effort */ }
  });

  // comandi slash
  pi.registerCommand("remember", {
    description: "Salva un fatto. Uso: /remember <chiave> = <valore> (es. /remember db-prod-host = 10.0.0.5:5432)",
    handler: async (args: string, ctx: any) => {
      const m = (args || "").match(/^([^=]+?)\s*=\s*(.+)$/);
      if (!m) { ctx.ui.notify("Uso: /remember <chiave> = <valore>", "warn"); return; }
      rememberFact(m[1].trim(), m[2].trim(), "user");
      ctx.ui.notify(`✓ Fatto salvato: ${m[1].trim()} = ${m[2].trim()}`, "info");
    },
  });

  pi.registerCommand("forget", {
    description: "Rimuove un fatto. Uso: /forget <chiave>",
    handler: async (args: string, ctx: any) => {
      const key = (args || "").trim();
      if (!key) { ctx.ui.notify("Uso: /forget <chiave>", "warn"); return; }
      ctx.ui.notify(forgetFact(key) ? `✓ Fatto rimosso: ${key}` : `✗ Fatto non trovato: ${key}`, "info");
    },
  });

  pi.registerCommand("facts", {
    description: "Elenca i fatti appresi",
    handler: async (_args: string, ctx: any) => {
      const mem = loadMemory();
      const f = Object.entries(mem.facts);
      ctx.ui.notify(f.length ? `Fatti appresi:\n${formatFacts(Object.fromEntries(f))}` : "Nessun fatto salvato. Usa /remember <chiave> = <valore>", "info");
    },
  });

  pi.registerCommand("history", {
    description: "Cerca nello storico delle direttive. Uso: /history [query]",
    handler: async (args: string, ctx: any) => {
      const mem = loadMemory();
      const q = (args || "").trim().toLowerCase();
      let items = mem.history;
      if (q) items = items.filter(h => h.text.toLowerCase().includes(q));
      if (items.length === 0) { ctx.ui.notify(q ? `Nessuna direttiva trovata per "${q}"` : "Storico vuoto", "info"); return; }
      const lines = items.slice(0, 15).map(h => `- ${h.text} (${h.outcome})`);
      ctx.ui.notify(`Storico${q ? ` per "${q}"` : ""}:\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("memory", {
    description: "Mostra tutta la memoria (fatti + storico recente)",
    handler: async (_args: string, ctx: any) => {
      const mem = loadMemory();
      const f = Object.entries(mem.facts);
      const h = mem.history.slice(0, 10);
      const out = [
        f.length ? `FATTI (${f.length}):\n${formatFacts(Object.fromEntries(f))}` : "FATTI: nessuno",
        h.length ? `\nSTORICO (${mem.history.length}):\n${h.map(x => `- ${x.text} (${x.outcome})`).join("\n")}` : "\nSTORICO: vuoto",
      ].join("\n");
      ctx.ui.notify(out, "info");
    },
  });

  pi.registerCommand("forget-all", {
    description: "Cancella tutta la memoria (fatti + storico)",
    handler: async (_args: string, ctx: any) => {
      const ok = await ctx.ui.confirm("Cancellare tutta la memoria?", "Fatti e storico verranno rimossi.");
      if (!ok) { ctx.ui.notify("Annullato.", "info"); return; }
      saveMemory({ facts: {}, history: [] });
      ctx.ui.notify("✓ Memoria cancellata.", "info");
    },
  });
}
