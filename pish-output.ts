// PISH output — output ricco: tabelle, diff e grafici per i comandi
// -----------------------------------------------------------------------------
// Intercetta tool_result dei comandi bash e riformatta l'output:
//   ps / docker ps / systemctl / df / free / ls -l  → tabelle allineate
//   git diff / diff                                  → diff con colori
//   metriche numeriche (vmstat, iostat, sar)         → grafici a barre ASCII
// Attivabile/disattivabile con /output on|off|auto (default: auto).
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CFG = join(homedir(), ".pi", "pish", "output.json");
const MAX_TABLE_ROWS = 25;

function loadMode(): string {
  try {
    if (existsSync(CFG)) return JSON.parse(readFileSync(CFG, "utf8")).mode || "auto";
  } catch { /* default */ }
  return "auto";
}

function saveMode(mode: string): void {
  try {
    mkdirSync(join(homedir(), ".pi", "pish"), { recursive: true });
    writeFileSync(CFG, JSON.stringify({ mode }, null, 1));
  } catch { /* best-effort */ }
}

// ------------------------------ tabelle -------------------------------------
function toTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] || "").length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const sep = widths.map(w => "-".repeat(w)).join("  ");
  const out = [fmt(header), sep, ...rows.slice(0, MAX_TABLE_ROWS).map(fmt)];
  if (rows.length > MAX_TABLE_ROWS) out.push(`… (${rows.length - MAX_TABLE_ROWS} righe in più)`);
  return out.join("\n");
}

function formatPs(text: string): string | null {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const header = lines[0].trim().split(/\s+/);
  const rows = lines.slice(1).map(l => l.trim().split(/\s+/));
  if (rows.length === 0 || rows[0].length < 3) return null;
  return toTable(header, rows);
}

function formatDockerPs(text: string): string | null {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const header = lines[0].trim().split(/\s{2,}/);
  const rows = lines.slice(1).map(l => l.trim().split(/\s{2,}/));
  if (rows.length === 0 || rows[0].length < 3) return null;
  return toTable(header, rows);
}

function formatDf(text: string): string | null {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const header = lines[0].trim().split(/\s+/);
  const rows = lines.slice(1).map(l => l.trim().split(/\s+/));
  if (rows.length === 0 || rows[0].length < 3) return null;
  return toTable(header, rows);
}

function formatSystemctl(text: string): string | null {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const header = lines[0].trim().split(/\s+/);
  const rows = lines.slice(1).map(l => l.trim().split(/\s+/));
  if (rows.length === 0 || rows[0].length < 3) return null;
  return toTable(header, rows);
}

function formatFree(text: string): string | null {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const header = lines[0].trim().split(/\s+/);
  const rows = lines.slice(1).map(l => l.trim().split(/\s+/));
  if (rows.length === 0 || rows[0].length < 3) return null;
  return toTable(header, rows);
}

function formatLs(text: string): string | null {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const header = ["permessi", "link", "owner", "gruppo", "size", "data", "nome"];
  const rows = lines.map(l => l.trim().split(/\s+/)).filter(r => r.length >= 7);
  if (rows.length === 0) return null;
  return toTable(header, rows);
}

// ------------------------------- diff ---------------------------------------
function formatDiff(text: string): string | null {
  if (!/^[+-]{3} |^@@ |^[+-][^+-]/.test(text)) return null;
  const lines = text.split("\n");
  const out = lines.map(l => {
    if (l.startsWith("+++") || l.startsWith("---")) return `\x1b[1m${l}\x1b[0m`;
    if (l.startsWith("+")) return `\x1b[32m${l}\x1b[0m`;
    if (l.startsWith("-")) return `\x1b[31m${l}\x1b[0m`;
    if (l.startsWith("@@")) return `\x1b[36m${l}\x1b[0m`;
    return l;
  });
  return out.join("\n");
}

// --------------------------- grafici a barre --------------------------------
function formatBars(text: string): string | null {
  // rileva righe "nome valore" con valori numerici (es. vmstat, iostat, sar)
  const lines = text.trim().split("\n");
  const data: Array<[string, number]> = [];
  for (const l of lines) {
    const m = l.trim().match(/^([A-Za-z0-9_.\-/]+)\s+(\d+(?:\.\d+)?)$/);
    if (m) data.push([m[1], parseFloat(m[2])]);
  }
  if (data.length < 2) return null;
  const max = Math.max(...data.map(([, v]) => v), 1);
  const out = data.map(([name, v]) => {
    const bar = "█".repeat(Math.max(1, Math.round((v / max) * 30)));
    return `${name.padEnd(20)} ${bar} ${v}`;
  });
  return out.join("\n");
}

// ------------------------------ dispatch ------------------------------------
function formatOutput(command: string, text: string): string | null {
  const c = command.trim();
  if (/^ps\b/.test(c)) return formatPs(text);
  if (/^docker\s+ps\b/.test(c)) return formatDockerPs(text);
  if (/^df\b/.test(c)) return formatDf(text);
  if (/^systemctl\b/.test(c)) return formatSystemctl(text);
  if (/^free\b/.test(c)) return formatFree(text);
  if (/^ls\s+-l/.test(c)) return formatLs(text);
  if (/^git\s+diff\b|^diff\b/.test(c)) return formatDiff(text);
  if (/^(vmstat|iostat|sar)\b/.test(c)) return formatBars(text);
  return null;
}

// ------------------------------ export --------------------------------------
export default function (pi: any) {
  pi.on("tool_result", async (event: any) => {
    if (event.toolName !== "bash") return;
    const mode = loadMode();
    if (mode === "off") return;

    const command = String(event.input?.command || "");
    const content = event.content;
    if (!Array.isArray(content)) return;

    const text = content.map((b: any) => (b && b.type === "text" ? b.text : "")).join("\n");
    if (!text.trim()) return;

    const formatted = formatOutput(command, text);
    if (!formatted) return;

    // sostituisci il contenuto con la versione formattata
    return {
      content: [{ type: "text", text: formatted }],
    };
  });

  pi.registerCommand("output", {
    description: "Controlla l'output ricco. Uso: /output on|off|auto",
    handler: async (args: string, ctx: any) => {
      const mode = (args || "").trim().toLowerCase();
      if (!["on", "off", "auto"].includes(mode)) {
        ctx.ui.notify(`Output ricco: ${loadMode()} (usa: /output on|off|auto)`, "info");
        return;
      }
      saveMode(mode);
      ctx.ui.notify(`✓ Output ricco → ${mode}`, "info");
    },
  });
}
