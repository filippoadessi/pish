// PISH exit — comandi slash per uscire dalla shell di login pish
// -----------------------------------------------------------------------------
// Quando pish è la shell di login (chsh -s /usr/local/bin/pish), l'utente è
// attachato alla sessione pi in tmux. /exit e /quit staccano il client tmux
// (la sessione pi resta attiva in background): l'utente torna al prompt di
// login senza terminare nulla. Fuori da tmux, il comando chiede conferma prima
// di uscire davvero.
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";

const TMUX_SESSION = process.env.PISH_NAME || "pish";

function runCmd(args: string[]): Promise<{ ok: boolean; msg: string }> {
  return new Promise((resolve) => {
    execFile("tmux", args, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ ok: true, msg: "" });
        return;
      }
      resolve({ ok: false, msg: stderr || String(err.message || "") });
    });
  });
}

// Stacca tutti i client attachati alla sessione pish; la sessione resta viva
// in background (l'utente torna al prompt di login, pi continua in tmux).
async function detachClient(ctx: any): Promise<boolean> {
  const r = await runCmd(["detach-client", "-s", TMUX_SESSION]);
  if (r.ok) {
    ctx.ui.notify("✓ Staccato da pish. La sessione resta attiva (riattaccaci con: pish).", "info");
    return true;
  }
  return false;
}

export default function (pi: any) {
  pi.registerCommand("exit", {
    description: "Esci da pish: stacca dalla sessione (resta attiva in background). Usa 'pish' per riattaccare.",
    handler: async (_args: string, ctx: any) => {
      if (await detachClient(ctx)) return;
      // non in tmux: chiedi conferma per uscire davvero
      const ok = await ctx.ui.confirm("Uscire davvero da pish?", "La sessione verrà terminata.");
      if (ok) {
        const q = await runCmd(["kill-session", "-t", TMUX_SESSION]);
        ctx.ui.notify(q.ok ? `✓ Sessione ${TMUX_SESSION} terminata.` : "Sessione non trovata.", q.ok ? "info" : "warn");
      } else {
        ctx.ui.notify("Uscita annullata.", "info");
      }
    },
  });

  pi.registerCommand("quit", {
    description: "Termina la sessione pish (attiva solo per uscita esplicita).",
    handler: async (_args: string, ctx: any) => {
      const ok = await ctx.ui.confirm("Terminare la sessione pish?", "La sessione verrà chiusa definitivamente.");
      if (!ok) {
        ctx.ui.notify("Uscita annullata.", "info");
        return;
      }
      const r = await runCmd(["kill-session", "-t", TMUX_SESSION]);
      ctx.ui.notify(r.ok ? `✓ Sessione ${TMUX_SESSION} terminata.` : "Sessione non trovata (forse è solo staccata: usa /exit).", r.ok ? "info" : "warn");
    },
  });
}
