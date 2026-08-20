// PISH complete — autocompletamento intelligente (TAB + /complete)
// -----------------------------------------------------------------------------
// Porta l'autocompletamento oltre i comandi slash: TAB nella TUI suggerisce
// direttive complete in linguaggio naturale, con NOMI REALI:
//
//   riavvia il <TAB>            → riavvia il servizio nginx · riavvia il container postgres …
//   docker restart <TAB>        → (delegato al provider nativo: file)
//   /script run <TAB>           → nomi degli script in ~/.pi/pish/scripts/
//   /recipe run <TAB>           → nomi delle ricette in ~/.pi/pish/recipes/
//
// Sorgenti dei suggerimenti:
//   - storico delle direttive (memory.json → history[]) — "l'ultima volta hai fatto…"
//   - nomi reali: container docker, servizi systemd, ricette, script, host ssh
//   - template di direttive con i nomi reali già espansi
//
// Per client senza TUI (tau-mirror, remote-pi) c'è il comando /complete [query].
//
// Il provider è un WRAPPER di quello nativo di pi: quando non abbiamo nulla da
// suggerire delegiamo al provider base (file, comandi slash, argomenti), così
// il comportamento normale di Tab resta invariato.
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ------------------------------ tipi (locali, senza dipendenze pi-tui) ------
interface Item { value: string; label: string; description?: string; }
interface Suggestions { items: Item[]; prefix: string; }
interface Provider {
  triggerCharacters?: string[];
  getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<Suggestions | null>;
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: Item, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number };
}

const PISH_DIR = join(homedir(), ".pi", "pish");
const MEMORY_FILE = join(PISH_DIR, "memory.json");
const RECIPES_DIR = join(PISH_DIR, "recipes");
const SCRIPTS_DIR = join(PISH_DIR, "scripts");
const MAX_ITEMS = 8;

// ------------------------------ helper --------------------------------------
function run(cmd: string, timeout = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile("bash", ["-c", cmd], { timeout, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout || "").trim());
    });
  });
}

function listFiles(dir: string, ext = ".pish"): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => f.slice(0, -ext.length))
      .sort();
  } catch {
    return [];
  }
}

// cache TTL per i nomi "costosi" (docker/systemd) — 30s
const cache = new Map<string, { at: number; value: string[] }>();
async function cached(key: string, cmd: string, ttl = 30000): Promise<string[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const out = await run(cmd);
  const list = out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  cache.set(key, { at: Date.now(), value: list });
  return list;
}

const getDockerContainers = () => cached("docker", "docker ps -a --format '{{.Names}}' 2>/dev/null");
const getSystemServices = () => cached("services", "systemctl list-units --type=service --state=running,exited,failed --no-legend 2>/dev/null | awk '{print $1}' | sed 's/\\.service$//' | grep -v '^$'");
const getSshHosts = () => cached("ssh", "grep -E '^\\s*Host\\s+' ~/.ssh/config 2>/dev/null | awk '{print $2}' | grep -v '\\*'");

function getHistory(): { text: string; ts: number }[] {
  try {
    if (!existsSync(MEMORY_FILE)) return [];
    const d = JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
    if (Array.isArray(d.history)) {
      return d.history
        .map((h: any) => ({ text: String(h?.text ?? "").trim(), ts: Number(h?.ts ?? 0) }))
        .filter((h) => h.text);
    }
  } catch { /* nessuna memoria */ }
  return [];
}

// ------------------------------ matching ------------------------------------
// punteggio: prefisso di frase > sottosequenza di token > match su parola
function scoreCandidate(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 60; // Tab su input vuoto: suggerisci comunque le direttive
  if (t.startsWith(q)) return 100 + t.length - q.length; // più lunga la frase completa, prima
  const tokens = q.split(/\s+/).filter(Boolean);
  const words = t.split(/\s+/);
  // sottosequenza: ogni token è prefisso di una parola, in ordine
  let ti = 0;
  for (const w of words) {
    if (ti < tokens.length && w.startsWith(tokens[ti])) ti++;
  }
  if (ti === tokens.length) return 40;
  // match parziali: quanti token sono prefissi di qualche parola
  const hits = tokens.filter((tok) => words.some((w) => w.startsWith(tok))).length;
  return hits > 0 ? 10 + hits * 6 : 0;
}

function toItems(cands: { text: string; score: number; desc?: string }[]): Item[] {
  return cands
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS)
    .map((c) => ({ value: c.text, label: c.text, description: c.desc }));
}

// template di direttive: i segnaposto <resource> vengono espansi con i nomi reali
function buildTemplates(
  history: { text: string; ts: number }[],
  containers: string[],
  services: string[],
  recipes: string[],
  scripts: string[],
  hosts: string[],
): { text: string; score: number; recency?: number; desc?: string }[] {
  const t: { text: string; score: number; recency?: number; desc?: string }[] = [];
  // storico: più recente prima (recency come bonus al punteggio)
  const now = Date.now();
  for (const h of history.slice().reverse()) {
    const ageDays = (now - h.ts) / 86400000;
    t.push({ text: h.text, score: 0, recency: Math.max(0, 30 - ageDays) });
  }
  // template fissi
  const fixed = [
    "quanto è pieno il disco?",
    "quanta RAM è occupata?",
    "quanto è alto il carico del server?",
    "quali container docker sono attivi?",
    "quali servizi systemd sono falliti?",
    "fai un backup del database PostgreSQL",
    "aggiorna il sistema",
    "verifica la scadenza dei certificati SSL",
    "mostra gli ultimi errori nei log di sistema",
  ];
  for (const f of fixed) t.push({ text: f, score: 15 });
  // espansioni con nomi reali
  for (const c of containers.slice(0, 12)) {
    t.push({ text: `riavvia il container ${c}`, score: 20, desc: "container docker" });
    t.push({ text: `mostra i log del container ${c}`, score: 20, desc: "container docker" });
    t.push({ text: `entra nel container ${c}`, score: 15, desc: "container docker" });
  }
  for (const s of services.slice(0, 12)) {
    t.push({ text: `riavvia il servizio ${s} e verifica che sia attivo`, score: 20, desc: "servizio systemd" });
    t.push({ text: `mostra i log del servizio ${s}`, score: 20, desc: "servizio systemd" });
    t.push({ text: `verifica che il servizio ${s} sia attivo`, score: 15, desc: "servizio systemd" });
  }
  for (const r of recipes) {
    t.push({ text: `esegui la ricetta ${r}`, score: 20, desc: "ricetta" });
  }
  for (const s of scripts) {
    t.push({ text: `esegui lo script ${s}`, score: 20, desc: "script" });
  }
  for (const h of hosts.slice(0, 8)) {
    t.push({ text: `connettiti a ${h} e mostra lo stato`, score: 15, desc: "host ssh" });
  }
  return t;
}

// ------------------------------ suggerimenti --------------------------------
// Completamento di una direttiva in linguaggio naturale (riga che NON inizia con /)
async function directiveSuggestions(before: string, signal?: AbortSignal): Promise<Suggestions | null> {
  const query = before.trim();
  // input vuota o solo spazi: lascia il provider base (file) tentare; i suggerimenti
  // arrivano al secondo TAB o quando l'utente comincia a scrivere
  if (!query) return null;

  // i nomi reali (container, servizi, host) vengono caricati SEMPRE (cache 30s):
  // anche "riavvia il " senza keyword deve poter suggerire nomi concreti
  const [history, containers, services, recipes, scripts, hosts] = await Promise.all([
    Promise.resolve(getHistory()),
    getDockerContainers(),
    getSystemServices(),
    Promise.resolve(listFiles(RECIPES_DIR)),
    Promise.resolve(listFiles(SCRIPTS_DIR)),
    getSshHosts(),
  ]);
  if (signal?.aborted) return null;

  const cands = buildTemplates(history, containers, services, recipes, scripts, hosts);
  // la recency ("l'ultima volta hai fatto…") è un BONUS: conta solo se c'è già
  // un match lessicale, altrimenti la direttiva vecchia non pertinente non appare
  const scored = cands.map((c) => {
    const lex = scoreCandidate(query, c.text);
    return { ...c, score: lex > 0 ? lex + (c.recency ?? 0) : 0 };
  });
  const items = toItems(scored);
  return items.length ? { items, prefix: before } : null;
}

// Completamento degli argomenti dei comandi slash (/script run <TAB> …)
async function argSuggestions(before: string, signal?: AbortSignal): Promise<Suggestions | null> {
  const m = before.match(/^\/([a-z-]+)(?:\s+([a-z-]+))?\s+(.*)$/);
  if (!m) return null;
  const cmd = m[1];
  const sub = m[2] ?? "";
  const rest = m[3] ?? "";
  const q = rest.toLowerCase();

  const names = (list: string[]): Suggestions | null => {
    const items = list
      .filter((n) => n.toLowerCase().startsWith(q))
      .slice(0, MAX_ITEMS)
      .map((n) => ({ value: n, label: n }));
    return items.length ? { items, prefix: rest } : null;
  };

  switch (cmd) {
    case "script":
      if (!sub) return names(["run", "new", "list", "show", "resume", "schedule", "unschedule", "status"]);
      if (["run", "show"].includes(sub)) return names(listFiles(SCRIPTS_DIR));
      if (sub === "schedule") return names(listFiles(SCRIPTS_DIR));
      break;
    case "recipe":
      if (!sub) return names(["list", "show", "run", "install"]);
      if (["run", "show"].includes(sub)) return names(listFiles(RECIPES_DIR));
      break;
    case "output":
      return names(["on", "off", "auto"]);
    case "policy":
      if (!sub) return names(["allow", "deny", "ask", "remove"]);
      break;
    case "role": {
      // /role <utente> <ruolo>
      const parts = rest.trim().split(/\s+/);
      const rolePrefix = parts[1] ?? "";
      const roles = ["admin", "operator", "readonly"].filter((r) => r.startsWith(rolePrefix.toLowerCase()));
      const items = roles.map((r) => ({ value: r, label: r }));
      return items.length ? { items, prefix: parts[1] ?? "" } : null;
    }
    case "history": {
      const history = getHistory();
      const items = history
        .map((h) => ({ text: h.text, score: scoreCandidate(rest, h.text) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ITEMS)
        .map((c) => ({ value: c.text, label: c.text }));
      return items.length ? { items, prefix: rest } : null;
    }
    case "complete":
      return directiveSuggestions(rest, signal);
  }
  return null;
}

// ------------------------------ applyCompletion -----------------------------
// Sostituzione generica: rimpiazza `prefix` con il valore scelto, mantiene il resto
function applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: Item, prefix: string) {
  const line = lines[cursorLine] || "";
  const before = line.slice(0, cursorCol - prefix.length);
  const after = line.slice(cursorCol);
  const newLines = [...lines];
  newLines[cursorLine] = before + item.value + after;
  return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length };
}

// ------------------------------ export --------------------------------------
export { scoreCandidate, directiveSuggestions, argSuggestions };

export default function (pi: any) {
  // provider di autocomplete: wrapper di quello base
  pi.on("session_start", (_event: any, ctx: any) => {
    try {
      if (typeof ctx.ui?.addAutocompleteProvider !== "function") return;
      ctx.ui.addAutocompleteProvider((base: Provider) => ({
        triggerCharacters: [],
        async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: any) {
          const currentLine = lines[cursorLine] || "";
          const before = currentLine.slice(0, cursorCol);
          if (before.startsWith("/")) {
            const args = await argSuggestions(before, options?.signal);
            if (args) return args;
          } else {
            const dir = await directiveSuggestions(before, options?.signal);
            if (dir) return dir;
          }
          // delega al provider base (file, comandi slash, argomenti nativi)
          return base.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion,
      }));
    } catch (e) {
      console.error("pish-complete:", e);
    }
  });

  // /complete [query] — per client senza TUI (tau-mirror, remote-pi, ssh)
  pi.registerCommand("complete", {
    description: "Autocompletamento direttive: /complete [query] mostra i suggerimenti (in TUI usa TAB).",
    handler: async (args: string, ctx: any) => {
      const query = (args || "").trim();
      if (query) {
        const s = await directiveSuggestions(query);
        if (!s || !s.items.length) { ctx.ui.notify(`Nessun suggerimento per "${query}".`, "warn"); return; }
        ctx.ui.notify(
          `Suggerimenti per "${query}":\n${s.items.map((i) => `- ${i.value}${i.description ? `  (${i.description})` : ""}`).join("\n")}`,
          "info");
        return;
      }
      // senza query: cheat-sheet di cose che puoi chiedere
      const [containers, services, recipes, scripts] = await Promise.all([
        getDockerContainers(),
        getSystemServices(),
        Promise.resolve(listFiles(RECIPES_DIR)),
        Promise.resolve(listFiles(SCRIPTS_DIR)),
      ]);
      const lines: string[] = [];
      if (containers.length) lines.push(`Container docker: ${containers.slice(0, 8).join(", ")}${containers.length > 8 ? "…" : ""}`);
      if (services.length) lines.push(`Servizi systemd: ${services.slice(0, 8).join(", ")}${services.length > 8 ? "…" : ""}`);
      if (recipes.length) lines.push(`Ricette: ${recipes.join(", ")}`);
      if (scripts.length) lines.push(`Script: ${scripts.join(", ")}`);
      lines.push("Idee: 'riavvia il container X', 'mostra i log del servizio Y', 'esegui la ricetta Z'");
      ctx.ui.notify(
        `PISH autocompletamento (in TUI premi TAB mentre scrivi; qui usa /complete <testo>):\n${lines.join("\n")}`,
        "info");
    },
  });
}
