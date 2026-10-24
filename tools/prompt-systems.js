#!/usr/bin/env node
// node tools/prompt-systems.js [filtre] [--root <dir>] [--dump <fichier.json>] [--no-mutants] [--show]
//
// Test « bonne consigne gemma selon le modèle » : exécute la VRAIE page (index.html puis canvas.html, js/*.js compris)
// dans un Chrome headless piloté par CDP, ComfyUI / Ollama / WebSocket bouchonnés, et vérifie, pour chaque modèle
// (Krea 2, LTX 2.5, Minimax H3, Qwen…) et chaque bouton ✨ / chemin d'enrichissement automatique, que :
//   - la consigne système envoyée à gemma est EXACTEMENT celle du modèle (empreinte sha256, pas un nom de constante) ;
//   - le nombre d'appels gemma est celui attendu (0 pour LTX 2.5, dont le graphe enrichit lui-même) ;
//   - le contenu utilisateur est celui attendu (jetons <Subject N> substitués, style en PRIMARY_STYLE…) ;
//   - le graphe soumis à /comfy/prompt respecte la grammaire du modèle (Krea 2, LTX 2.5, H3 i2v/r2v/cuts, keyframes).
// Puis des témoins négatifs (mutants) : chaque mutant d'une copie servie à la volée doit faire échouer ≥ 1 contrôle.
// Autonome : node 22 seul + chrome-headless-shell (variable $CHROME, sinon ~/.cache/ms-playwright, /opt/pw-browsers).
// Exception assumée à la règle « bancs hors dépôt » : aucun port fixe (serveur statique en port 0, Chrome en
// --remote-debugging-port=0, profil mktemp supprimé), rien à configurer. Aucune requête ne quitte la machine :
// toute requête /comfy ou /ollama qui ATTEINT le serveur statique (donc échappe aux bouchons) fait échouer le test.
// Sortie 0 = tout vert et mutants tués ; 1 = échec ; 2 = test inutilisable (Chrome absent, page qui ne charge pas).
// Usage : node tools/prompt-systems.js [filtre] [--root <dir>] [--dump <fichier.json>] [--no-mutants] [--show]
//   filtre        regex d'identifiants de scénario (ex. "S-H" ou "^C-"), sans mutants ; --root : autre arbre que le dépôt (avant/après) ;
//   --dump        enregistre, par scénario, appels gemma (consigne identifiée, sha256, contenu utilisateur), graphes et événements ;
//   --no-mutants  saute les témoins négatifs (≈ 2,5 min au lieu de ≈ 4 min) ; --show : détaille consignes et textes de graphes.
// Les empreintes sont figées ici (bloc FP) : rien à configurer, aucun fichier hors dépôt. Une consigne modifiée fait échouer le
// scénario qui la porte (« consigne inconnue ») : si le changement est voulu, régénérer l'empreinte et la SPEC dans le même commit.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = path.resolve(opt("--root") || path.join(__dirname, ".."));
const DUMP = opt("--dump"), NO_MUT = argv.includes("--no-mutants"), SHOW = argv.includes("--show");
const FILTER = argv.find((a, i) => !a.startsWith("--") && !["--root", "--dump"].includes(argv[i - 1]));
const only = FILTER ? new RegExp(FILTER) : null;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const die = m => { console.error("ERREUR (test inutilisable) : " + m); process.exit(2); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Empreintes des consignes (sha256 du texte envoyé à gemma ; figées au lot 0 de I13-B sur a6d65c0) ──────────────
// Les paramétrées (QWEN_EDIT, SHEET_DESC, SHOT_ACTION, CUT, H3_SCENARIO, personnage, plans) le sont pour les paramètres
// EXACTS des scénarios ci-dessous. Une consigne qui n'est dans aucune entrée est « inconnue ».
const FP = /*FP-BEGIN*/{
  "ENRICH_SYSTEM": "c6bf68a3bc8a77ed5897c84d0406e3a8d9f2944541b29f6f11b767cefb6d8192",
  // ancienne consigne Krea 2 du Studio (clé positive_prompt, avant le lot 2) : gardée pour NOMMER le rouge d'un arbre antérieur
  "KREA2_ENRICH_SYSTEM [Studio avant I13-B lot 2, clé positive_prompt]": "9318a954bda45d14969450401339126f884bc4532318573eb21eee75f84a09ab",
  "QWEN_EDIT_ENRICH_SYSTEM(1)": "62d932f42d289655ccc8253c33f270483ae7b658940efefcb1e81047e48d9ea5",
  "QWEN_EDIT_ENRICH_SYSTEM(2)": "69d8fba45a4a65bf5ed5624498e3536cfb82290f1c9caabb8926161086955dda",
  // moteur Qwen Image 2.1 (v1.4.3, B4) : le même texte, le nom du moteur « Qwen Image 2.1 » à la place de « Qwen-Image-Edit-2509 » (2 occurrences)
  "QWEN_EDIT_ENRICH_SYSTEM(1, Qwen Image 2.1)": "08c7744f408a96b7a8cec84d68c13f12e534209a342c59339ed47ef6d371137c",
  "QWEN_EDIT_ENRICH_SYSTEM(2, Qwen Image 2.1)": "e57e867f1c0bcb6863a820dbea221b04a28a07d0e6176ebd1d64938f3913d2fe",
  "SHEET_DESC_ENRICH_SYSTEM(human)": "87a376e9d00ae8dfd8ab11f4d3787c7c0420873e1854cc869a25a0636d24b466",
  "SHEET_DESC_ENRICH_SYSTEM(other)": "0068b15796ce53c5c3de119b56a8b5e4a0dd81426033a7a6531c273bc7aa5706",
  "SHEET_DESC_ENRICH_SYSTEM(location)": "0ae3609d27bb85705d303a719c491e0d9152857fd607d20122cab4b062c0a962",
  "CUT_ENRICH_SYSTEM(ltx25)": "22e05354e9e828f33b4fc80b97e3d9daa7a2cd7e511e1f002ac41d64d3b00129",
  "CUT_ENRICH_SYSTEM(minimax_h3)": "8ae6fb4b9b4187a754b53b0ffe3b6c2fd98be7c190b64dae4df3f562a1e13864",
  "REF_VISION_SYSTEM": "14c68fdba3150548308d4ee260f24c1c1b4fc6e236463a971a731d9d0f030b95",
  "SHOT_ACTION_ENRICH_SYSTEM(1 sujet)": "37dbace72d8f0b7c520a7739ec4833c48ebec3b75b556042eab8b986c56559c1",
  "SHOT_ACTION_ENRICH_SYSTEM(2 sujets)": "1013f2369ba577a4878a5a84c202800ab654b95983bb4ef411f5097a2fe819d6",
  "H3_SCENARIO_SYSTEM": "b99a423cc35d0be004bbca969c447c83336d98041e43353d20d33ebe6e700c3e",
  "CHARACTER_SYSTEM": "4d78da3e105a0d0d31692a5578cfa35ca8982f8db8dab5684715ecbfec20f267",
  "LOCATION_SYSTEM": "26d05d4b08a27f1f1e9ebffac25e7159baf5f584c1c13cda4e6940aa9debccf8",
  "SHOTLIST_SYSTEM(n=4)": "2e8e2be58327d676b4ef476d0960c649972c1caf688c8f066a20c0a37a895362",
  "KREA2_ENRICH_SYSTEM": "d7d318d81bb5dc492570e8b93fc7bb2baed372d9865e374ed82a54a6a9ebaec5",
  "CHARACTER_SYSTEM(forceKind=human)": "59ca22976439b39bdacad85e602757319e1f91d8fee4763dba34448e753c70e5",
  "CHARACTER_SYSTEM(forceKind=other)": "1e2189353fb3e19b60a18f3190a29978dfed35e1f9a4765e3db5515be46af2a2",
  "ENHANCE.qwenImagePrompt": "dde8a1cd3edbc9b809330321ff336461e704a886ceec754868cb15d122f3c12c",
  "H3_VIDEO (ENHANCE.videoPrompt)": "0312447bf7cea171eaae070e5fb137b01f1823589237b05f26f724d13997ea89",
  "QWEN_EDIT_INSTRUCTION (ENHANCE.qwenInstruction)": "c1a421308d0a259bf7d0c5359e9daa855ae5693769ac01e25eaba0d8e02db522",
  // v1.4.4 : les substituts SUBJECTREFn sont nommés et autorisés (l'ancienne phrase « ni de syntaxe de référence d'image » les faisait perdre)
  "R2V_BRIEF (ENHANCE.r2vBrief)": "207c517f3ce613c73500538302a3efc10554cf00cff023063fefc36f66b65e54",
  "R2V_BRIEF [avant v1.4.4]": "c34e55f2ff0096345bd7dec39684c04181161e124c423f494755482df007af4e",
  "SHEET_BRIEF (ENHANCE.sheetBrief)": "a3799383a92581605fcae4da6ffb3b017246e31f622063d0d3d1be00d2b9800a"
}/*FP-END*/;
const NAME_OF = new Map(); for (const [n, h] of Object.entries(FP)) { if (NAME_OF.has(h)) die(`empreinte en double : ${NAME_OF.get(h)} / ${n}`); NAME_OF.set(h, n); }
const nameOf = s => NAME_OF.get(sha(s)) || `consigne inconnue « ${s.slice(0, 60).replace(/\n/g, " ")}… » (sha ${sha(s).slice(0, 10)})`;

// ── Chrome + CDP ────────────────────────────────────────────────────────────────────────────────────────────────
function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const home = os.homedir();
  for (const [base, re, tail] of [[path.join(home, ".cache/ms-playwright"), /^chromium_headless_shell-/, null], ["/opt/pw-browsers", /^chromium_headless_shell-/, null]]) {
    let dirs = []; try { dirs = fs.readdirSync(base).filter(d => re.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      const root = path.join(base, d);
      for (const sub of fs.readdirSync(root)) for (const bin of ["chrome-headless-shell", "headless_shell"]) {
        const p = path.join(root, sub, bin); if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}
async function launchChrome() {
  const bin = findChrome(); if (!bin) die("chrome-headless-shell introuvable ($CHROME, ~/.cache/ms-playwright, /opt/pw-browsers)");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-systems-"));
  const proc = spawn(bin, ["--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10) || 0; } catch {}
    if (!port) await sleep(100);
  }
  if (!port) { proc.kill(); die("Chrome ne démarre pas"); }
  const exited = new Promise(r => proc.on("exit", r));
  return { proc, port, profile, async close() { proc.kill(); await Promise.race([exited, sleep(3000)]); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } };
}
async function openPage(chrome, url, initScript, ready) {
  const t = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(), listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) listeners.forEach(l => l(m));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { pend.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  listeners.push(m => { if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: false }); });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
  const loaded = new Promise(r => listeners.push(m => m.method === "Page.loadEventFired" && r()));
  await send("Page.navigate", { url }); await loaded;
  const evaluate = async (expression, timeoutMs = 120000) => {
    const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => { throw new Error("timeout evaluate"); })]);
    if (r.exceptionDetails) throw new Error("page : " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  let ok = false;
  for (let i = 0; i < 150 && !ok; i++) { try { ok = await evaluate(ready); } catch {} if (!ok) await sleep(100); }
  if (!ok) { ws.close(); throw new Error("la page n'est jamais prête : " + url); }
  return { evaluate, close: async () => { ws.close(); try { await fetch(`http://127.0.0.1:${chrome.port}/json/close/${t.id}`); } catch {} } };
}

// ── Serveur statique (port 0), mutants à la volée, garde « rien ne doit atteindre /comfy ou /ollama » ───────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const violations = []; let MUTATION = null;   // MUTATION = { file: "js/engine.js", edits: [[old, new], …] }
function startServer() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (/^\/(comfy|ollama)(\/|$)/.test(u)) {
      // seul passage toléré : les <img>/<video> des aperçus chargent /comfy/view hors de fetch (donc hors bouchon) ; GET en lecture seule, 404
      if (!(req.method === "GET" && u === "/comfy/view")) violations.push(`${req.method} ${u}`);
      res.writeHead(404); return res.end();
    }
    const rel = (u === "/" ? "/index.html" : u).replace(/^\/+/, ""), p = path.resolve(ROOT, rel);
    if (!p.startsWith(ROOT + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    let body = fs.readFileSync(p);
    if (MUTATION && rel === MUTATION.file) {
      let t = body.toString("utf8");
      for (const [a, b] of MUTATION.edits) { if (t.split(a).length !== 2) { MUTATION.broken = `cible présente ${t.split(a).length - 1} fois : ${a.slice(0, 50)}`; continue; } t = t.replace(a, () => b); }
      body = Buffer.from(t, "utf8");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(body);
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}

// ── Bouchons injectés AVANT les scripts de la page (dérivés de stubs-2e.js) ─────────────────────────────────────────
const STUBS = String.raw`(() => {
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  const L = window.__log = { prompts: [], uploads: [], ollama: [], interrupts: [], errors: [], events: [], urls: [] };
  const C = window.__cfg = { hold: false };
  Math.random = () => 0.5;   // seeds déterministes (le dump de deux exécutions doit être identique)
  window.addEventListener("error", e => L.errors.push("error: " + e.message));
  window.addEventListener("unhandledrejection", e => L.errors.push("unhandled: " + (e.reason?.message || e.reason)));
  window.__ws = [];
  window.WebSocket = class { constructor(u) { this.url = u; window.__ws.push(this); } send() {} close() {} };
  let pngP = null;
  const png = () => pngP || (pngP = (() => { const c = new OffscreenCanvas(64, 36); c.getContext("2d").fillRect(0, 0, 64, 36); return c.convertToBlob({ type: "image/png" }); })());
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const TEXT = "enriched prompt text, the first reference image keeps the character identity, the second reference image keeps the location, the third reference image sets the style, masterpiece, 8k";
  // Réponse gemma : clés de TOUTES les consignes ; si le message utilisateur porte un jeton substitué (SUBJECTREFn, Q21IMAGEREFn),
  // le texte rendu le recopie (comme le ferait gemma), ce qui prouve l'aller-retour des jetons.
  const reply = user => {
    if (C.noKey) return { negative_prompt: "blurry", unrelated: "x" };   // C.noKey : gemma répond du JSON valide SANS la clé attendue (mais avec un négatif)
    const t = /SUBJECTREF\d|Q21IMAGEREF\d/.test(user) && !C.dropTokens ? "enriched: " + user : TEXT;   // C.dropTokens : gemma « oublie » les jetons (sortie sans eux)
    return { positive_prompt: t, negative_prompt: "blurry", prompt: t, brief: t, description: t, action: t, instruction: t, label: "",
      kind: "human", face: "round face with freckles", hair: "short brown hair", outfit: "blue wool coat", accessories: "", palette: "blue and brown",
      place: "a quiet harbor pier", architecture: "wooden piers", materials: "wet planks", lighting: "soft dawn light",
      subject: "a red fox", appearance: "thick red fur, white chest", detailed_description: "The subject walks slowly.",
      segments: ["She walks along the pier.", "She stops and looks at the sea.", "Close on her face."],
      shots: [{ camera: "wide", lighting: "morning", action: "walks along the pier", emotion: "calm" }] };
  };
  const jobs = {}; let seq = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = String(url), m = (opts.method || "GET").toUpperCase();
    L.urls.push(m + " " + u);
    if (/generativelanguage\.googleapis\.com|api\.openai\.com/.test(u)) return json({ error: "stub" }, 403);
    if (u.includes("/ollama/api/version")) return json({ version: "stub" });
    if (u.includes("/ollama/api/show")) return json({ capabilities: ["completion", "vision"] });
    if (u.includes("/ollama/api/chat")) {
      const b = JSON.parse(opts.body); L.ollama.push(opts.body);
      return json({ message: { content: JSON.stringify(reply(String(b.messages[1].content))) } });
    }
    if (u.includes("/ollama")) return json({ models: [] });
    if (!/(^|\/)comfy\//.test(u)) return realFetch(url, opts);   // y compris l'URL relative « comfy/system_stats » de update-check.js
    if (u.includes("/comfy/prompt") && m === "POST") {
      const body = JSON.parse(opts.body); L.prompts.push(body);
      const id = "job" + (++seq), outs = {};
      for (const [nid, n] of Object.entries(body.prompt))
        if (/^Save(Image|Video)$/.test(n.class_type)) {
          const base = String(n.inputs.filename_prefix || "out").split("/");
          outs[nid] = { images: [{ filename: base.pop() + "_" + id + "_." + (n.class_type === "SaveVideo" ? "mp4" : "png"), subfolder: base.join("/"), type: "output" }] };
        }
      jobs[id] = { outs };
      return json({ prompt_id: id, number: seq });
    }
    if (u.includes("/comfy/history/")) {
      const id = u.split("/history/")[1].split("?")[0], j = jobs[id];
      if (!j || C.hold) return json({});
      return json({ [id]: { prompt: [0, id, {}], status: { status_str: "success", completed: true }, outputs: j.outs } });
    }
    if (u.includes("/comfy/history")) return json({});
    if (u.includes("/comfy/view")) return new Response(await png(), { status: 200, headers: { "Content-Type": "image/png" } });
    if (u.includes("/comfy/upload/image")) {
      const f = opts.body.get("image"); L.uploads.push({ name: f.name, size: f.size });
      return json({ name: f.name, subfolder: "", type: "input" });
    }
    if (u.includes("/comfy/interrupt")) { L.interrupts.push(1); return json({}); }
    if (u.includes("/comfy/queue")) return json({ queue_running: [], queue_pending: [] });
    if (u.includes("/comfy/object_info/LoraLoaderModelOnly"))
      return json({ LoraLoaderModelOnly: { input: { required: { lora_name: [["Krea2/a.safetensors", "H3/h.safetensors", "H3/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors"]] } } } });
    return json({});
  };
  window.__file = (name, n = 8, type = "image/png") => new File([new Uint8Array(Array.from({ length: n }, (_, i) => (i * 31 + name.length) & 255))], name, { type });
  window.__setFiles = (id, files) => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); document.getElementById(id).files = dt.files; };
  const out = f => ({ filename: f, subfolder: "studio/story", type: "output" });
  const variant = f => ({ file: out(f), inputName: null, seed: 1, source: "generated", prompt: "p", status: "ready" });
  const SUBJ = [
    { face: "elderly woman with deep wrinkles and kind eyes", hair: "short curly white hair", outfit: "bright yellow hooded raincoat, grey trousers", accessories: "", palette: "yellow and grey" },
    { face: "young man with smooth skin", hair: "straight black hair with a fringe", outfit: "colorful windbreaker jacket in red, blue and yellow, white t-shirt, black trousers", accessories: "", palette: "red, blue, yellow" }];
  window.__mkProj = ({ nChars = 1, charIdx = 0, keyframes = false, n = 4, wfId = "storyboard_v2", holdDur = 0, twoSubj = false, withAudio = false } = {}) => ({
    version: 1, savedAt: "bench", brief: "bench", negText: "", wfId, sheetTemplate: "auto",
    seed: 1234, width: 1024, height: 576, n, segDur: 2, holdDur, withAudio, validated: true,
    locFields: { place: "a quiet wooden harbor pier at dawn", architecture: "weathered wooden piers and moored fishing boats", materials: "wet planks, rope", lighting: "soft dawn light", palette: "teal and amber" },
    chars: SUBJ.slice(0, nChars).map((f, i) => ({ fields: f, variants: [variant(["charsheet_00125_.png", "charsheet_00108_.png"][i])], active: 0 })),
    charIdx, locVariants: [variant("locsheet_00071_.png")], locActive: 0,
    shots: Array.from({ length: n }, (_, i) => ({ camera: ["medium", "wide", "close_up", "low_angle"][i % 4], lighting: "golden_hour", action: "shot " + (i + 1) + ": she walks along the pier", emotion: i % 2 ? "calm" : "", duration: 2, extra: "", subjects: twoSubj && i % 2 ? [0, 1] : [0] })),
    keyframes: keyframes ? Array.from({ length: n }, (_, i) => ({ status: "ready", locked: false, seed: 1245 + i, name: null, file: out("key_0" + (i + 1) + "_bench.png"), prompt: "kf " + i, edited: false })) : null,
    cuts: null, order: null, animatic: null, cutEngine: "ltx25", relay: null
  });
  window.__restore = async p => { localStorage.setItem("studioProject", JSON.stringify(p)); await restoreProject(); };
})();`;

// ── Aides communes aux scénarios (exécutées dans la page) ───────────────────────────────────────────────────────────
const PRE_STUDIO = String.raw`
  const wait = ms => new Promise(r => setTimeout(r, ms));
  { const o = addEvent; addEvent = (c, t, k) => { __log.events.push(c + " " + t); return o(c, t, k); }; }
  const settle = async (max = 60000) => { let last = "", same = 0; const t0 = Date.now();
    while (Date.now() - t0 < max) { await wait(400);
      const k = [__log.prompts.length, __log.uploads.length, __log.ollama.length, $("generateBtn").disabled].join();
      if (k === last) { if (++same >= 6) return; } else { same = 0; last = k; } } };
  const tab = s => selectScenario(s);
  const pick = (pipeline, model) => { pipelineSelect.value = pipeline; updateModelOptions(); if (model) { modelSelect.value = model; updateModelLabel(); } };
  const base = () => { seedInput.value = "42"; brief.value = "A fox in a yellow raincoat crosses a snowy harbor at dawn."; negative.value = "low quality"; };
  const go = async () => { $("generateBtn").click(); await wait(300); await settle(); };
  const enrichClick = async () => { const n = __log.ollama.length; $("enrichBtn").click(); for (let i = 0; i < 60 && __log.ollama.length === n; i++) await wait(100); await wait(500); };
  // ✨ d'un éditeur de prompt (modale) : la fonction open* du Studio pose la modale, #promptModalEnrich est le vrai bouton.
  const modalEnrich = async () => { const n = __log.ollama.length; $("promptModalEnrich").click(); for (let i = 0; i < 60 && __log.ollama.length === n; i++) await wait(100); await wait(500); return $("promptModalText").value; };
  const loras = async () => { for (let i = 0; i < 50 && $("loraStyleSelect").options.length < 2; i++) await wait(100); };
`;
const REC_STUDIO = String.raw`JSON.stringify({
  ollama: __log.ollama.map(b => { const j = JSON.parse(b); return { model: j.model, system: j.messages[0].content, user: j.messages[1].content, images: (j.messages[1].images || []).length }; }),
  prompts: __log.prompts.map(b => b.prompt), nPrompts: __log.prompts.length, events: __log.events || [], errors: __log.errors, extra: window.__extra || {} })`;

// ── Exécution d'un scénario : page neuve (stubs → état vierge), code, enregistrement JSON ───────────────────────────
let CHROME, SERVER;
async function record(sc) {
  const studio = sc.page === "studio";
  const url = `http://127.0.0.1:${SERVER.port}/${studio ? "index.html" : "canvas.html"}`;
  const ready = studio ? "!!window.Engine && typeof manifest !== 'undefined' && manifest.workflows.length > 0 && !!document.getElementById('generateBtn')"
                       : "!!window.Engine && !!window.__canvas && !!__canvas.graph";
  const p = await openPage(CHROME, url, STUBS, ready);
  try {
    await p.evaluate(`(async () => { ${studio ? PRE_STUDIO : PRE_CANVAS} ${sc.run} })()`, 180000);
    return JSON.parse(await p.evaluate(studio ? REC_STUDIO : REC_CANVAS));
  } finally { await p.close(); }
}

const PRE_CANVAS = String.raw`
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const C = __canvas;
  const SEL = n => { C.lgcanvas.selectNode(n); C.lgcanvas.onSelectionChange(C.lgcanvas.selected_nodes); };
  const add = (type, props) => C.addNode(type, [40 + 380 * C.graph._nodes.length, 100], props);
  // pose un champ PAR LE PANNEAU (comme l'utilisateur) : <label for=pf-k>
  const setField = async (k, v) => { const el = document.getElementById("pf-" + k); if (!el) return false; el.value = v;
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); await wait(40); return true; };
  // ✨ Enrichir (LLM) du champ k de la carte sélectionnée : retourne false si le bouton n'existe pas
  const enhance = async k => { const b = document.querySelector('[data-enhance="' + k + '"]'); if (!b) return false;
    const n = __log.ollama.length; b.click(); for (let i = 0; i < 60 && __log.ollama.length === n; i++) await wait(100); await wait(400); return true; };
  const out = f => ({ filename: f, subfolder: "canvas", type: "output" });
  // carte « résolue » : sortie amont déjà posée (comme après un job terminé)
  const resolved = (type, props, file) => { const n = add(type, props); n.properties.outFile = out(file); return n; };
`;
const REC_CANVAS = REC_STUDIO;
// ── Scénarios ───────────────────────────────────────────────────────────────────────────────────────────────────
const SPEC = [
  // Krea 2
  { id: "S-K1", page: "studio", run: `pick("text2image", "krea2_t2i"); base(); $("styleSelect").value = "cinematic"; await enrichClick(); __extra = { brief: brief.value, neg: negative.value };` },
  { id: "S-K2", page: "studio", run: `pick("text2image", "krea2_t2i"); base(); $("styleSelect").value = "cinematic"; ratioSelect.value = "16:9"; variantsInput.value = "1"; $("autoEnrichBtn").click(); await go(); __extra = { style: currentStyleText() };` },
  { id: "S-K3", page: "studio", run: `tab("campaign"); pick("campaign_full", "campaign_full"); base(); variantsInput.value = "1"; $("videoDuration").value = "2"; $("styleSelect").value = "noir"; $("autoEnrichBtn").click(); await go(); __extra = { style: currentStyleText() };` },
  // LTX 2.5 : le graphe enrichit lui-même (TextGenerateLTX2Prompt), gemma ne doit jamais être appelé
  { id: "S-L1", page: "studio", run: `pick("text2video", "ltx25_t2v"); base(); $("autoEnrichBtn").click(); $("mpSelect").value = "0.5"; $("videoDuration").value = "2"; await go();` },
  { id: "S-L2", page: "studio", run: `pick("image2video", "ltx25_i2v"); base(); $("autoEnrichBtn").click(); __setFiles("imageInput", [__file("start.png", 50)]); $("mpSelect").value = "0.5"; $("videoDuration").value = "2"; await go();` },
  { id: "S-L3", page: "studio", run: `pick("text2video", "ltx25_t2v"); base(); await enrichClick(); __extra = { t2v: brief.value }; pick("image2video", "ltx25_i2v"); base(); await enrichClick(); __extra.i2v = brief.value; __extra.neg = negative.value;` },
  { id: "S-L4", page: "studio", run: `tab("storyboard"); pick("sequence2video", "flf2v_chain"); base(); brief.value = "slow dolly between the frames"; $("autoEnrichBtn").click(); $("audioToggle").checked = false;
    const mk = (n, d) => ({ name: n, blob: new Blob(["png" + n], { type: "image/png" }), w: 640, h: 360, dur: d });
    seqImages.length = 0; seqImages.push(mk("a.png", 2), mk("b.png", 3)); await go();` },
  // Minimax H3
  { id: "S-H1", page: "studio", run: `pick("text2video", "minimax_h3_t2v"); base(); $("autoEnrichBtn").click(); $("turboToggle").checked = true; $("mpSelect").value = "0.6"; $("videoDuration").value = "2"; await go(); __extra = { neg: negative.value };` },
  { id: "S-H2", page: "studio", run: `pick("image2video", "minimax_h3_i2v"); base(); $("autoEnrichBtn").click(); __setFiles("imageInput", [__file("first.png", 60)]); __setFiles("lastImageInput", [__file("last.png", 61)]); $("turboToggle").checked = true; $("videoDuration").value = "3"; await go(); __extra = { neg: negative.value, align: Engine.h3Alignment(true, 3) };` },
  { id: "S-H3", page: "studio", run: `tab("storyboard"); pick("reference2video", "minimax_h3_r2v"); base(); $("skipSheetsToggle").checked = true; $("skipSheetsToggle").dispatchEvent(new Event("change"));
    __setFiles("refImagesInput", [__file("ref0.png", 70), __file("ref1.png", 71)]); brief.value = "<Subject 1> hugs <Subject 2> on the pier at dawn"; await enrichClick(); __extra = { brief: brief.value, neg: negative.value, ev: __log.events.slice() };
    // gemma (bouchon) renvoie une sortie SANS les jetons : enrichissement écarté, brief intact, WARN et AUCUN OK « Brief enrichi »
    const orig = "<Subject 1> looks at <Subject 2>"; brief.value = orig; const k = __log.events.length;
    __cfg.dropTokens = true; await enrichClick(); __cfg.dropTokens = false; __extra.drop = { orig, brief: brief.value, ev: __log.events.slice(k) };` },
  { id: "S-H4", page: "studio", run: `tab("storyboard"); pick("reference2video", "minimax_h3_r2v"); base(); $("skipSheetsToggle").checked = false; $("skipSheetsToggle").dispatchEvent(new Event("change"));
    __setFiles("refImagesInput", [__file("x0.png", 73), __file("x1.png", 74)]); $("turboToggle").checked = false; await go();
    for (let i = 0; i < 40 && !anchorsReady(); i++) await wait(250);
    $("directorValidateBtn").click(); await generateReference2VideoFromDirector(); await settle();` },
  { id: "S-H5", page: "studio", run: `tab("storyboard"); pick("reference2video", "minimax_h3_r2v"); base(); $("skipSheetsToggle").checked = true; $("skipSheetsToggle").dispatchEvent(new Event("change"));
    __setFiles("refImagesInput", [__file("ref0.png", 70), __file("ref1.png", 71), __file("ref2.png", 72)]); $("turboToggle").checked = true; $("videoDuration").value = "2"; await go();` },
  // storyboard_v2 : planches, plans, images des plans, cuts, relay
  { id: "S-SB1", page: "studio", run: `tab("storyboard"); pick("storyboard_v2", "storyboard_v2"); base(); $("shotCount").value = "4"; $("videoDuration").value = "2"; await go(); await settle();` },
  { id: "S-SB2", page: "studio", run: `tab("storyboard"); await __restore(__mkProj()); await settle(); __extra = {};
    const open = async (sel, key) => { document.querySelector(sel).click(); await wait(100); __extra[key] = { before: $("promptModalText").value }; __extra[key].after = await modalEnrich(); closePromptEditor(); };
    await open("#studioCharacter .sheet-prompt", "human");
    Object.assign(director.charFields, { kind: "other", subject: "a red fox", form: "fox", surface: "fur", details: "white chest", palette: "red" });
    await open("#studioCharacter .sheet-prompt", "other");
    await open("#studioLocation .sheet-prompt", "location");` },
  { id: "S-SB3", page: "studio", run: `tab("storyboard"); __extra = {};
    for (const wf of ["storyboard_v2", "storyboard_v2_qwen21"]) {
      await __restore(__mkProj({ wfId: wf, keyframes: true, nChars: 2, twoSubj: true })); await settle();
      for (const [i, key] of [[0, "solo"], [1, "dual"]]) {
        document.querySelectorAll(".kf-prompt")[i].click(); await wait(100);
        const before = $("promptModalText").value, after = await modalEnrich(); closePromptEditor();
        __extra[wf + ":" + key] = { before, after, solo: KEYFRAME_ANCHOR_SOLO, dual: KEYFRAME_ANCHOR_DUAL };
      }
    }` },
  { id: "S-SB4", page: "studio", run: `tab("storyboard"); await __restore(__mkProj({ nChars: 2, twoSubj: true })); await settle(); __extra = {};
    for (const [i, key] of [[0, "solo"], [1, "dual"]]) { document.querySelectorAll(".shot-action-btn")[i].click(); await wait(100); __extra[key] = { before: $("promptModalText").value, after: await modalEnrich() }; closePromptEditor(); }` },
  { id: "S-SB5", page: "studio", run: `tab("storyboard"); __extra = {};
    await __restore(__mkProj({ keyframes: true, holdDur: 2, nChars: 2, twoSubj: true })); await settle();
    for (const eng of ["ltx25", "minimax_h3"]) {
      $("cutEngineSelect").value = eng; await generateCuts(); await settle();
      document.querySelector(".clip-prompt").click(); await wait(100);
      __extra[eng] = { before: $("promptModalText").value, after: await modalEnrich() }; closePromptEditor();
    }` },
  { id: "S-SB6", page: "studio", run: `tab("storyboard");
    await __restore(__mkProj({ keyframes: true, holdDur: 2, nChars: 2, twoSubj: true, withAudio: true })); await settle();
    for (const eng of ["ltx25", "minimax_h3"]) { $("cutEngineSelect").value = eng; await generateCuts(); await settle(); }` },
  // ✨ manuel du brief d'un storyboard : le workflow est `builtin` (aucun enrichissement auto), le bouton envoie la consigne du brief de storyboard
  { id: "S-SB7", page: "studio", run: `tab("storyboard"); __extra = {};
    for (const wf of ["storyboard_v2", "storyboard_v2_qwen21"]) { pick("storyboard_v2", wf); base(); await enrichClick(); __extra[wf] = { brief: brief.value, neg: negative.value }; }` },
  { id: "S-R1", page: "studio", run: `tab("storyboard"); await __restore(__mkProj()); await settle(); __extra = {};
    const seg = (p, mode) => Object.assign(newRelaySegment(), { prompt: p, duration: 1, mode });
    director.relay = { segments: [seg("She walks along the pier.", "continue"), seg("Close on her face.", "cut")], engine: "ltx25", video: null, scenario: "" };
    $("relayEngineSelect").value = "ltx25"; $("relayEngineSelect").dispatchEvent(new Event("change")); renderRelay();
    const b = document.querySelector(".seg-enrich"); const n = __log.ollama.length; b.click(); for (let i = 0; i < 60 && __log.ollama.length === n; i++) await wait(100); await wait(500);
    __extra = { seg: director.relay.segments[0].prompt };` },
  { id: "S-R2", page: "studio", run: `tab("storyboard"); await __restore(__mkProj()); await settle(); __extra = {};
    const seg = (p, mode) => Object.assign(newRelaySegment(), { prompt: p, duration: 1, mode });
    director.relay = { segments: [seg("<Subject 1> walks along the pier.", "continue"), seg("Close on <Subject 1>.", "cut")], engine: "minimax_h3", video: null, scenario: "" };
    $("relayEngineSelect").value = "minimax_h3"; $("relayEngineSelect").dispatchEvent(new Event("change")); renderRelay();
    const b = document.querySelector(".seg-enrich"); const n = __log.ollama.length; b.click(); for (let i = 0; i < 60 && __log.ollama.length === n; i++) await wait(100); await wait(500);
    __extra = { seg: director.relay.segments[0].prompt };` },
  { id: "S-R3", page: "studio", run: `tab("storyboard"); __extra = {};
    for (const eng of ["minimax_h3", "ltx25"]) {
      await __restore(__mkProj()); await settle(); director.relay = { segments: [newRelaySegment()], engine: eng, video: null, scenario: "" };
      $("relayEngineSelect").value = eng; $("relayEngineSelect").dispatchEvent(new Event("change")); renderRelay();
      $("relayScenario").value = "She walks along the pier, stops, then looks at the sea."; $("relayScenario").dispatchEvent(new Event("input")); $("relaySegCount").value = "3";
      const n = __log.ollama.length; if (!$("relayComposer").hidden) { $("relayComposeBtn").click(); await wait(1200); }   // composeur caché (LTX) : l'utilisateur ne peut pas le déclencher
      __extra[eng] = { calls: __log.ollama.length - n, composerHidden: $("relayComposer").hidden, segs: director.relay.segments.map(s => s.prompt) };
    }` },
  // témoins « non affectés » : Qwen Image 2.1 / Qwen-Edit gardent la consigne générique
  { id: "S-Q1", page: "studio", run: `pick("text2image", "qwen21_t2i"); base(); await enrichClick(); __extra = { brief: brief.value, neg: negative.value };` },
  { id: "S-Q2", page: "studio", run: `pick("image2image", "qwen21_i2i"); base(); brief.value = "Put the <image2> hat on the fox of <image1>"; await enrichClick(); __extra = { brief: brief.value, neg: negative.value, ev: __log.events.slice() };
    const orig = brief.value = "Put the <image2> hat on the fox of <image1>", k = __log.events.length; negative.value = "low quality";
    __cfg.dropTokens = true; await enrichClick(); __cfg.dropTokens = false; __extra.drop = { orig, brief: brief.value, neg: negative.value, ev: __log.events.slice(k) };` },
  // sortie de gemma sans la clé attendue (JSON valide, mais seulement un négatif) : brief et négatif intacts, un WARN « Enrichissement ignoré », aucun OK
  { id: "S-Q4", page: "studio", run: `pick("text2image", "qwen21_t2i"); base(); const orig = brief.value; __cfg.noKey = true; await enrichClick(); __cfg.noKey = false; __extra = { orig, brief: brief.value, neg: negative.value, ev: __log.events.slice() };` },
  { id: "S-Q3", page: "studio", run: `pick("image2image", "qwen_edit_i2i"); base(); await enrichClick(); __extra = { brief: brief.value, neg: negative.value };` },
  // ── Canvas ──
  { id: "C-K1", page: "canvas", run: `const k = add("simple/krea2", { prompt: "a fox in a yellow raincoat" }); SEL(k); await wait(100); await enhance("prompt"); __extra = { prop: k.properties.prompt, field: document.getElementById("pf-prompt").value };
    await k.generate();` },
  { id: "C-K2", page: "canvas", run: `const k = add("simple/krea2", { prompt: "a fox in a yellow raincoat", ratio: "16:9" }); await k.generate();` },
  { id: "C-Q1", page: "canvas", run: `const k = add("simple/krea2", { prompt: "a fox in a yellow raincoat", engine: "qwen21" }); SEL(k); await wait(100); await enhance("prompt"); __extra = { prop: k.properties.prompt }; await k.generate();` },
  { id: "C-Q2", page: "canvas", run: `__extra = {};
    for (const eng of ["qwen_edit_2509", "qwen21"]) { const k = add("simple/qwen_edit", { instruction: "make it night", engine: eng }); SEL(k); await wait(100); await enhance("instruction"); __extra[eng] = k.properties.instruction; }` },
  { id: "C-L1", page: "canvas", run: `const src = resolved("simple/import", {}, "in.png"); const v = add("simple/video", { prompt: "the fox runs", engine: "ltx25", duration: 2, mp: "0.5" }); src.connect(0, v, 0); SEL(v); await wait(100);
    __extra = { enhanceButton: !!document.querySelector('[data-enhance="prompt"]') }; await v.generate();` },
  { id: "C-H1", page: "canvas", run: `const src = resolved("simple/import", {}, "in.png"); const v = add("simple/video", { prompt: "the fox runs", engine: "minimax_h3", duration: 2, mp: "0.5" }); src.connect(0, v, 0); SEL(v); await wait(100);
    __extra = { enhanceButton: !!document.querySelector('[data-enhance="prompt"]'), align: Engine.h3Alignment(false, 2) }; await enhance("prompt"); __extra.prop = v.properties.prompt; await v.generate();` },
  { id: "C-SB1", page: "canvas", run: `__extra = {};
    const a = add("adv/charsheet", { brief: "a fox in a yellow raincoat" }); SEL(a); await wait(100); await enhance("brief"); await a.generate();
    const h = add("adv/charsheet", { brief: "a fox in a yellow raincoat", kind: "human" }); await h.generate();
    const o = add("adv/charsheet", { brief: "a fox in a yellow raincoat", kind: "other" }); await o.generate();` },
  { id: "C-SB2", page: "canvas", run: `__extra = {};
    const l = add("adv/locsheet", { brief: "a harbor pier at dawn" }); SEL(l); await wait(100); await enhance("brief"); await l.generate();
    const cs = resolved("adv/charsheet", { charDesc: "a red fox in a raincoat" }, "charsheet_1.png"), ls = resolved("adv/locsheet", { locDesc: "a harbor pier at dawn" }, "locsheet_1.png");
    const sb = add("adv/storyboard", { brief: "the fox crosses the pier", shotCount: 4, segmentDuration: 2 }); cs.connect(0, sb, 0); ls.connect(0, sb, 1); SEL(sb); await wait(100);
    await enhance("brief"); await sb.generate(); __extra.shots = sb.properties.shots.length;` },
  { id: "C-H2", page: "canvas", run: `const cs = resolved("adv/charsheet", { charDesc: "a red fox in a raincoat" }, "charsheet_1.png"), ls = resolved("adv/locsheet", { locDesc: "a harbor pier at dawn" }, "locsheet_1.png");
    const r = add("adv/r2v", { brief: "<Subject 1> walks along the pier and meets <Subject 2>", duration: 2 }); cs.connect(0, r, 0); ls.connect(0, r, 1); SEL(r); await wait(100);
    await enhance("brief"); __extra = { prop: r.properties.brief, field: document.getElementById("pf-brief").value }; await r.generate();
    // gemma (bouchon) renvoie une sortie SANS les jetons : le champ et la propriété restent intacts, l'erreur s'affiche sous le bouton
    SEL(r); await wait(100); const orig = "<Subject 1> looks at <Subject 2>"; await setField("brief", orig);
    __cfg.dropTokens = true; await enhance("brief"); __cfg.dropTokens = false;
    __extra.drop = { orig, prop: r.properties.brief, field: document.getElementById("pf-brief").value, err: document.querySelector('[data-enhance="brief"]').nextElementSibling.textContent };` },
  { id: "C-CV", page: "canvas", run: `const cs = resolved("adv/charsheet", { charDesc: "a red fox in a raincoat" }, "charsheet_1.png"), ls = resolved("adv/locsheet", { locDesc: "a harbor pier at dawn" }, "locsheet_1.png");
    const sb = add("adv/storyboard", { brief: "the fox crosses the pier", shotCount: 2, segmentDuration: 2 }); cs.connect(0, sb, 0); ls.connect(0, sb, 1);
    Object.assign(sb.properties, { charDesc: "a red fox in a raincoat", locDesc: "a harbor pier at dawn", styleId: "cinematic",
      shots: [{ camera: "wide", lighting: "golden_hour", action: "the fox walks along the pier", emotion: "calm", duration: 2, extra: "" }, { camera: "close_up", lighting: "golden_hour", action: "the fox looks at the sea", emotion: "", duration: 2, extra: "" }],
      keyframes: [0, 1].map(i => ({ file: out("key_0" + (i + 1) + ".png"), name: "key_0" + (i + 1) + ".png" })) });
    for (const eng of ["ltx25", "minimax_h3", "minimax_h3_r2v"]) { const cv = add("adv/cutvideo", { engine: eng, duration: 2 }); sb.connect(0, cv, 0); await cv.generate(); }`},
];

function promptTexts(g) {
  const o = [];
  for (const [id, n] of Object.entries(g)) for (const [k, v] of Object.entries(n.inputs)) if (typeof v === "string" && v.length > 40 && /text|prompt|subject|value/i.test(k)) o.push(`${id}:${n.class_type}.${k}=${JSON.stringify(v).slice(0, 400)}`);
  return o;
}
function summarize(id, r) {
  const L = [`== ${id}  gemma ${r.ollama.length} appel(s), ${r.nPrompts} graphe(s), erreurs ${JSON.stringify(r.errors)}`];
  r.ollama.forEach((c, i) => L.push(`  [${i}] ${nameOf(c.system)} | images ${c.images} | user ${JSON.stringify(c.user.slice(0, 220))}`));
  r.prompts.forEach((g, i) => L.push(`  graphe ${i} : ${[...new Set(Object.values(g).map(n => n.class_type))].join(",")}\n     ` + promptTexts(g).join("\n     ")));
  L.push("  events " + JSON.stringify(r.events.filter(e => /^(WARN|OK)/.test(e)).slice(0, 8)), "  extra " + JSON.stringify(r.extra).slice(0, 600));
  return L.join("\n");
}

// ── Contrôles : grammaires de graphes et utilitaires ────────────────────────────────────────────────────────────────
const PAD = /\b(?:masterpiece|best quality|highest quality|ultra[- ]detailed|highly detailed|award[- ]winning|8k|4k|artstation)\b/i;
const nodes = (g, cls) => Object.entries(g).filter(([, n]) => n.class_type === cls).map(([id, n]) => ({ id, ...n }));
// suit une référence [id, sortie] vers sa valeur : primitive (value) ou ComfyMathExpression « a » (passe-plat, utilisé pour les fps)
const resolve = (g, v, d = 0) => {
  const n = Array.isArray(v) && d < 6 && g[v[0]];
  if (!n) return v;
  if ("value" in n.inputs) return resolve(g, n.inputs.value, d + 1);
  if (n.class_type === "ComfyMathExpression" && n.inputs.expression === "a") return resolve(g, n.inputs["values.a"], d + 1);
  return v;
};
const rawBrief = "A fox in a yellow raincoat crosses a snowy harbor at dawn.";

function krea2Graph(T, g, label, o = {}) {
  const enc = nodes(g, "CLIPTextEncode")[0], ks = nodes(g, "KSampler")[0];
  if (!T(enc && ks, `${label} : graphe Krea 2 (CLIPTextEncode + KSampler) absent`)) return;
  const zero = g[ks.inputs.negative?.[0]];
  T(zero && zero.class_type === "ConditioningZeroOut" && zero.inputs.conditioning[0] === ks.inputs.positive[0], `${label} : KSampler.negative doit venir de ConditioningZeroOut(positif)`);
  const t = enc.inputs.text;
  T(typeof t === "string" && !PAD.test(t), `${label} : terme de remplissage dans le prompt Krea 2 « ${String(t).slice(0, 80)} »`);
  if (o.text !== undefined) T(t === o.text, `${label} : texte du graphe ≠ attendu`);
  if (o.style) T(t.endsWith(o.style), `${label} : le style doit terminer le prompt`);
}
function ltxGraph(T, g, label, brief) {
  const t = nodes(g, "TextGenerateLTX2Prompt")[0];
  if (!T(!!t, `${label} : TextGenerateLTX2Prompt absent du graphe`)) return;
  T(t.inputs.use_default_template === true, `${label} : use_default_template doit rester true`);
  const p = resolve(g, t.inputs.prompt);
  T(typeof p === "string" && !/subject_definitions|<Subject|<Picture/.test(p), `${label} : le prompt LTX doit être de la prose (ni subject_definitions ni <Subject>)`);
  if (brief !== undefined) T(p === brief, `${label} : le prompt LTX doit être le brief tel quel, reçu « ${String(p).slice(0, 70)} »`);
  const c = nodes(g, "LTXVConditioning")[0];
  T(c && resolve(g, c.inputs.frame_rate) === 24, `${label} : LTX 2.5 doit tourner à 24 fps`);
}
function h3Fields(T, text, label) {
  const m = /^(?:[^\n]+\n\n)?subject_definitions:\n[\s\S]+?\n\nsummary:\n[\s\S]+?\n\nretention_analysis:\n[\s\S]+?\n\ndetailed_description:\n[\s\S]+?\n\noverall_soundscape:\n[\s\S]+?\n\nnon_diegetic_music:\n[\s\S]*$/.exec(text);
  if (!T(!!m, `${label} : les 6 champs H3 dans l'ordre (subject_definitions … non_diegetic_music) sont absents`)) return false;
  T(!/<Picture/.test(text.slice(text.indexOf("\n\nsummary:"))), `${label} : <Picture N> hors de subject_definitions`);
  T((text.match(/[<>]\s*subject\s*\d+\s*[<>]/gi) || []).every(x => /^<Subject \d+>$/.test(x)) && !/SUBJECTREF/i.test(text), `${label} : jeton <Subject N> mal formé ou substitut resté`);
  T(text.length <= 7000, `${label} : prompt H3 de ${text.length} car. > 7000`);
  return true;
}
const h3Prompt = g => (nodes(g, "MiniMaxH3ImageToVideo")[0] || nodes(g, "MiniMaxH3ReferenceToVideo")[0] || {}).inputs?.prompt;
const r2vPrompt = g => { const n = nodes(g, "PrimitiveStringMultiline").find(x => /subject_definitions/.test(x.inputs.value)); return n && n.inputs.value; };

// ── Attendus par scénario ───────────────────────────────────────────────────────────────────────────────────────────
// E[id](r, T, all) : T(condition, message) compte un contrôle ; all = enregistrements de tous les scénarios joués.
// sysIs(T, r, i, nom…) : l'appel i reçoit l'une des consignes nommées (empreinte sha256, voir FP).
const E = {};
const gotName = c => NAME_OF.get(sha(c.system));
const sysIs = (T, r, i, ...want) => {
  const c = r.ollama[i]; if (!T(!!c, `appel gemma n°${i + 1} absent`)) return;
  T(want.includes(gotName(c)), `appel n°${i + 1} : reçoit ${gotName(c) || nameOf(c.system)} au lieu de ${want[0]}`);
  T(c.model === "gemma4:e4b", `appel n°${i + 1} : modèle ${c.model} au lieu de gemma4:e4b`);
};
const names = r => r.ollama.map(c => gotName(c) || "inconnue");
const nCalls = (T, r, n) => T(r.ollama.length === n, `appels gemma : ${n} attendu(s), ${r.ollama.length} reçu(s)${r.ollama.length ? " (" + names(r).join(", ") + ")" : ""}`);
const sameSys = (a, b) => !!a && !!b && sha(a.system) === sha(b.system);
const seq = (T, r, label, ...want) => T(JSON.stringify(names(r)) === JSON.stringify(want), `${label} : attendu ${want.join(", ")} ; reçu ${names(r).join(", ") || "aucun appel"}`);

// Krea 2
E["S-K1"] = (r, T, all) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "KREA2_ENRICH_SYSTEM");
  T(r.ollama[0]?.user.startsWith(rawBrief + "\nPRIMARY_STYLE: "), "le brief part suivi de la ligne PRIMARY_STYLE (style hors du texte réécrit)");
  T(!PAD.test(r.extra.brief) && r.extra.brief.includes("enriched prompt text"), "le brief enrichi ne doit contenir aucun terme de remplissage (stripPromptPadding)");
  T(r.extra.neg === "low quality", "Krea 2 n'encode aucun négatif : le champ négatif ne doit pas être réécrit");
  const c = all["C-K1"]?.ollama[0];
  if (c) T(sameSys(r.ollama[0], c), "la consigne Krea 2 du Studio doit être octet pour octet celle du Canvas (C-K1)");
};
E["S-K2"] = (r, T) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "KREA2_ENRICH_SYSTEM");
  T(r.ollama[0]?.user.endsWith("\nPRIMARY_STYLE: " + r.extra.style), "PRIMARY_STYLE = style courant");
  T(r.nPrompts === 1, `1 graphe attendu, ${r.nPrompts}`); if (r.prompts[0]) krea2Graph(T, r.prompts[0], "graphe", { style: r.extra.style });
};
E["S-K3"] = (r, T) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "KREA2_ENRICH_SYSTEM");
  T(r.ollama[0]?.user.endsWith("\nPRIMARY_STYLE: " + r.extra.style), "PRIMARY_STYLE = style courant");
  const g = r.prompts[0]; if (!T(!!g, "graphe campaign_full absent")) return;
  const encs = nodes(g, "CLIPTextEncode").filter(n => typeof n.inputs.text === "string" && n.inputs.text !== "low quality");
  T(encs.length === 3 && encs.every(n => !PAD.test(n.inputs.text) && n.inputs.text.includes(r.extra.style)), `3 visuels Krea 2 sans remplissage, style présent (${encs.length} trouvés)`);
  ltxGraph(T, g, "teaser LTX 2.5");
};
// LTX 2.5 : le graphe enrichit lui-même (TextGenerateLTX2Prompt), gemma ne doit jamais être appelé
E["S-L1"] = (r, T) => { nCalls(T, r, 0); r.prompts[0] ? ltxGraph(T, r.prompts[0], "graphe LTX t2v", rawBrief) : T(false, "graphe absent"); T(r.events.some(e => /construit ses propres prompts/.test(e)), "ligne SYS « construit ses propres prompts » attendue"); };
E["S-L2"] = (r, T) => { nCalls(T, r, 0); r.prompts[0] ? ltxGraph(T, r.prompts[0], "graphe LTX i2v", rawBrief) : T(false, "graphe absent"); };
E["S-L3"] = (r, T) => {
  nCalls(T, r, 0);
  T(r.extra.t2v === rawBrief && r.extra.i2v === rawBrief, "✨ manuel sur un workflow LTX 2.5 : le brief ne doit pas être réécrit (le graphe enrichit lui-même)");
  T(r.extra.neg === "low quality", "le négatif de l'utilisateur ne doit pas être réécrit par une consigne qui n'en encode pas");
  T(r.events.filter(e => /construit ses propres prompts/.test(e)).length === 2, "même ligne SYS que le chemin auto (« construit ses propres prompts ») pour chacun des 2 clics");
};
E["S-L4"] = (r, T) => {
  nCalls(T, r, 0);
  r.prompts[0] ? ltxGraph(T, r.prompts[0], "graphe flf2v_chain", "slow dolly between the frames") : T(false, "graphe absent");
  const neg = r.prompts[0] && nodes(r.prompts[0], "CLIPTextEncode").find(n => typeof n.inputs.text === "string");
  T(neg && neg.inputs.text === "low quality", `le négatif de l'utilisateur ne doit pas être réécrit (reçu « ${neg?.inputs.text} »)`);
};
// Minimax H3
E["S-H1"] = (r, T, all) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "H3_VIDEO (ENHANCE.videoPrompt)"); T(r.ollama[0]?.user === rawBrief, "H3 : le brief part seul (ni PRIMARY_STYLE ni négatif)");
  const p = r.prompts[0] && h3Prompt(r.prompts[0]);
  T(typeof p === "string" && p.includes("enriched prompt text") && !/^(For the target video|How the reference pictures)/.test(p), `t2v : texte enrichi sans phrase d'alignement, reçu « ${String(p).slice(0, 90)} »`);
  T(r.extra.neg === "low quality", "H3 n'encode pas de négatif : le champ négatif ne doit pas être réécrit");
  const c = all["C-H1"]?.ollama[0]; if (c) T(sameSys(r.ollama[0], c), "la consigne H3 du Studio doit être octet pour octet celle du Canvas (C-H1)");
};
E["S-H2"] = (r, T, all) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "H3_VIDEO (ENHANCE.videoPrompt)"); T(r.ollama[0]?.user === rawBrief, "H3 : le brief part seul (ni PRIMARY_STYLE ni négatif)");
  const p = r.prompts[0] && h3Prompt(r.prompts[0]);
  T(typeof p === "string" && p.startsWith(r.extra.align + "\n\n") && p.includes("enriched prompt text"), `i2v + dernière image : alignement FL2VA en tête puis texte enrichi, reçu « ${String(p).slice(0, 90)} »`);
  T(typeof p === "string" && p.length <= 7000, "prompt H3 ≤ 7000 car.");
  const a = all["S-H1"]?.ollama[0]; if (a) T(sameSys(r.ollama[0], a), "t2v et i2v reçoivent la même consigne H3 (S-H1)");
};
// Journal d'un ✨ du brief : « OK Brief enrichi » seulement si l'enrichissement est appliqué, jamais après un WARN d'écartement (v1.4.4)
const nOk = ev => (ev || []).filter(e => /^OK Brief enrichi par /.test(e)).length;
const okJournal = (T, r, label, warnRe) => {
  T(nOk(r.extra.ev) === 1, `${label} : enrichissement accepté → 1 événement OK « Brief enrichi » attendu, ${nOk(r.extra.ev)} reçu(s)`);
  const d = r.extra.drop || {};
  T(d.brief === d.orig, `${label} : sortie de gemma sans jeton → brief inchangé attendu, reçu « ${d.brief} »`);
  T((d.ev || []).some(e => warnRe.test(e)), `${label} : sortie de gemma sans jeton → WARN « Enrichissement écarté » attendu (journal ${JSON.stringify(d.ev)})`);
  T(nOk(d.ev) === 0, `${label} : enrichissement écarté → AUCUN événement OK « Brief enrichi » (journal ${JSON.stringify(d.ev)})`);
};
E["S-H3"] = (r, T, all) => {
  nCalls(T, r, 2); sysIs(T, r, 0, "R2V_BRIEF (ENHANCE.r2vBrief)"); sysIs(T, r, 1, "R2V_BRIEF (ENHANCE.r2vBrief)");
  okJournal(T, r, "r2v", /^WARN Enrichissement écarté : les mentions <Subject N>/);
  const u = r.ollama[0]?.user || "";
  T(!/<Subject/i.test(u) && /SUBJECTREF1/.test(u) && /SUBJECTREF2/.test(u), `les jetons <Subject N> ne doivent jamais atteindre gemma (substitués par SUBJECTREFn), reçu « ${u.slice(0, 80)} »`);
  T(/<Subject 1>/.test(r.extra.brief) && /<Subject 2>/.test(r.extra.brief) && !/SUBJECTREF/.test(r.extra.brief), `le brief final doit retrouver <Subject 1> et <Subject 2>, reçu « ${r.extra.brief.slice(0, 80)} »`);
  T(r.extra.neg === "low quality", "r2v n'encode pas de négatif : le champ négatif ne doit pas être réécrit");
  const c = all["C-H2"]?.ollama[0]; if (c) T(sameSys(r.ollama[0], c), "la consigne r2v du Studio doit être octet pour octet celle du Canvas (C-H2)");
};
E["S-H4"] = (r, T) => {
  seq(T, r, "r2v avec fiches", "CHARACTER_SYSTEM", "LOCATION_SYSTEM", "REF_VISION_SYSTEM", "REF_VISION_SYSTEM");
  T(r.nPrompts === 3, `3 graphes (planche perso, planche décor, r2v), ${r.nPrompts}`);
  r.prompts.slice(0, 2).forEach((g, i) => krea2Graph(T, g, `planche ${i ? "décor" : "perso"}`));
  const t = r.prompts[2] && r2vPrompt(r.prompts[2]); if (T(!!t, "graphe r2v sans grammaire Ref2VA")) h3Fields(T, t, "r2v");
};
E["S-H5"] = (r, T) => {
  seq(T, r, "r2v sans fiches", "REF_VISION_SYSTEM", "REF_VISION_SYSTEM", "REF_VISION_SYSTEM");
  T(r.ollama.every(c => c.images === 1 && c.user === "Describe this reference image."), "chaque appel vision porte 1 image et la demande « Describe this reference image. »");
  const t = r.prompts[0] && r2vPrompt(r.prompts[0]); if (T(!!t, "graphe r2v sans grammaire Ref2VA")) h3Fields(T, t, "r2v bypass");
};
// storyboard_v2
E["S-SB1"] = (r, T) => {
  seq(T, r, "Générer le storyboard", "CHARACTER_SYSTEM", "LOCATION_SYSTEM", "SHOTLIST_SYSTEM(n=4)");
  T(r.ollama.every(c => c.user === rawBrief), "les 3 consignes reçoivent le brief tel quel");
  T(r.nPrompts === 2, `2 graphes de planche, ${r.nPrompts}`); r.prompts.forEach((g, i) => krea2Graph(T, g, `planche ${i ? "décor" : "perso"}`));
};
E["S-SB2"] = (r, T) => {
  seq(T, r, "✨ planche", "SHEET_DESC_ENRICH_SYSTEM(human)", "SHEET_DESC_ENRICH_SYSTEM(other)", "SHEET_DESC_ENRICH_SYSTEM(location)");
  for (const k of ["human", "other", "location"]) T(r.extra[k] && r.extra[k].after.length > 200 && /reference sheet/.test(r.extra[k].after) && /enriched prompt text/.test(r.extra[k].after), `✨ planche ${k} : le squelette de la planche doit être ré-apposé autour de la description enrichie`);
};
E["S-SB3"] = (r, T) => {
  seq(T, r, "✨ image du plan (2509 puis 2.1)", "QWEN_EDIT_ENRICH_SYSTEM(1)", "QWEN_EDIT_ENRICH_SYSTEM(2)", "QWEN_EDIT_ENRICH_SYSTEM(1, Qwen Image 2.1)", "QWEN_EDIT_ENRICH_SYSTEM(2, Qwen Image 2.1)");
  // le moteur est nommé dans la consigne : 2509 → « Qwen-Image-Edit-2509 » (2 fois, texte d'origine), 2.1 → « Qwen Image 2.1 » (2 fois), jamais l'autre nom
  const sys = r.ollama.map(c => c.system), cnt = (s, x) => s.split(x).length - 1;
  [[0, 1], [1, 1], [2, 0], [3, 0]].forEach(([i, is2509]) => T(sys[i] && cnt(sys[i], "Qwen-Image-Edit-2509") === (is2509 ? 2 : 0) && cnt(sys[i], "Qwen Image 2.1") === (is2509 ? 0 : 2), `appel n°${i + 1} : moteur ${is2509 ? "2509" : "2.1"} nommé deux fois dans la consigne, et lui seul`));
  T(sys[0] && sys[2] && sys[0].split("Qwen-Image-Edit-2509").join("Qwen Image 2.1") === sys[2] && sys[1].split("Qwen-Image-Edit-2509").join("Qwen Image 2.1") === sys[3], "2.1 = 2509 avec le seul nom du moteur remplacé (mêmes règles, mêmes phrases de rôle)");
  for (const [k, v] of Object.entries(r.extra)) {
    const a = k.endsWith("dual") ? v.dual : v.solo, b = k.endsWith("dual") ? v.solo : v.dual, n = (t, x) => t.split(x).length - 1;
    T(n(v.after, a) === 1 && n(v.after, b) === 0, `${k} : le bloc d'ancrage ${k.endsWith("dual") ? "DUAL" : "SOLO"} doit être remis une seule fois`);
  }
  T(r.ollama.every(c => !/Use the first reference image only|Do not place the two references/.test(c.user)), "l'ancrage ne doit pas être donné à gemma (strip-then-reappend)");
};
E["S-SB4"] = (r, T) => {
  seq(T, r, "✨ action", "SHOT_ACTION_ENRICH_SYSTEM(1 sujet)", "SHOT_ACTION_ENRICH_SYSTEM(2 sujets)");
  T(r.extra.solo.after.includes("enriched prompt text") && !PAD.test(r.extra.solo.after), "action enrichie, sans remplissage");
};
E["S-SB5"] = (r, T) => {
  seq(T, r, "✨ cut", "CUT_ENRICH_SYSTEM(ltx25)", "CUT_ENRICH_SYSTEM(minimax_h3)");
  T(r.ollama.every(c => !/<Subject/.test(c.user)), "aucun jeton <Subject N> ne doit atteindre gemma");
  T(/SUBJECTREF1/.test(r.ollama[1]?.user || ""), "H3 : les sujets du corps sont substitués par SUBJECTREFn");
  T(r.extra.ltx25.after.includes("enriched prompt text"), "LTX : le cut enrichi remplace le prompt");
  const h = r.extra.minimax_h3; if (T(h.after.includes("enriched:"), "H3 : le corps enrichi remplace detailed_description") && h3Fields(T, h.after, "cut H3 enrichi")) {
    const defs = x => x.slice(x.indexOf("subject_definitions:"), x.indexOf("\n\nsummary:"));
    T(defs(h.after) === defs(h.before), "H3 : subject_definitions inchangé par l'enrichissement (réassemblage du bloc)");
    T(/enriched: <Subject 1> is in <Subject 2>/.test(h.after), "H3 : les jetons <Subject N> sont rétablis dans le corps");
  }
};
E["S-SB6"] = (r, T) => {
  nCalls(T, r, 0);
  const ltx = r.prompts.filter(g => nodes(g, "TextGenerateLTX2Prompt").length), h3 = r.prompts.filter(g => nodes(g, "MiniMaxH3ImageToVideo").length);
  T(ltx.length >= 4 && h3.length >= 4, `cuts LTX (${ltx.length}) et H3 (${h3.length}) : au moins 4 chacun`);
  ltx.forEach((g, i) => ltxGraph(T, g, `cut LTX ${i + 1}`)); h3.forEach((g, i) => h3Fields(T, h3Prompt(g) || "", `cut H3 ${i + 1}`));
};
E["S-R1"] = (r, T) => { nCalls(T, r, 1); sysIs(T, r, 0, "CUT_ENRICH_SYSTEM(ltx25)"); T(r.ollama[0]?.user === "She walks along the pier." && r.extra.seg.includes("enriched prompt text"), "segment LTX : texte envoyé tel quel, segment remplacé"); };
E["S-R2"] = (r, T) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "CUT_ENRICH_SYSTEM(minimax_h3)");
  T(r.ollama[0]?.user === "SUBJECTREF1 walks along the pier.", `segment H3 : <Subject 1> substitué avant l'appel, reçu « ${r.ollama[0]?.user} »`);
  T(r.extra.seg === "enriched: <Subject 1> walks along the pier.", `segment H3 : jeton rétabli après l'appel, reçu « ${r.extra.seg} »`);
};
E["S-R3"] = (r, T) => {
  const h = r.extra.minimax_h3, l = r.extra.ltx25;
  nCalls(T, r, 1); sysIs(T, r, 0, "H3_SCENARIO_SYSTEM");
  T(h.calls === 1 && h.segs.length === 3, `H3 : 1 appel, 3 segments posés (${h.calls}, ${h.segs.length})`);
  T(l.composerHidden === true && l.calls === 0, "LTX : le composeur de scénario est caché, 0 appel gemma");
};
// témoins « non affectés » : Qwen Image 2.1 et Qwen-Edit gardent la consigne générique
E["S-Q1"] = (r, T) => { nCalls(T, r, 1); sysIs(T, r, 0, "ENRICH_SYSTEM"); T(r.ollama[0]?.user === rawBrief, "Qwen Image 2.1 t2i : brief seul"); };
E["S-Q2"] = (r, T) => {
  nCalls(T, r, 2); sysIs(T, r, 0, "ENRICH_SYSTEM"); sysIs(T, r, 1, "ENRICH_SYSTEM");
  okJournal(T, r, "i2i Qwen Image 2.1", /^WARN Enrichissement écarté : les mentions <imageN>/);
  T(/Q21IMAGEREF2/.test(r.ollama[0]?.user) && !/<image/.test(r.ollama[0]?.user), `Qwen Image 2.1 i2i : <imageN> substitués avant l'appel, reçu « ${r.ollama[0]?.user} »`);
  T(/<image1>/.test(r.extra.brief) && /<image2>/.test(r.extra.brief) && !/Q21IMAGEREF/.test(r.extra.brief), "… et rétablis dans le brief");
  T(r.extra.neg === "blurry", `enrichissement accepté (consigne générique) : le négatif est celui de gemma, reçu « ${r.extra.neg} »`);
  T(r.extra.drop?.neg === "low quality", `enrichissement écarté : le négatif de l'utilisateur doit rester intact, reçu « ${r.extra.drop?.neg} »`);
};
E["S-Q4"] = (r, T) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "ENRICH_SYSTEM");
  const ev = r.extra.ev || [], w = ev.filter(e => /^WARN Enrichissement ignoré : la réponse de gemma ne contient pas le champ attendu/.test(e));
  T(w.length === 1, `sortie sans la clé attendue → exactement 1 WARN « Enrichissement ignoré » attendu, ${w.length} reçu(s) (journal ${JSON.stringify(ev)})`);
  T(nOk(ev) === 0, `sortie sans la clé attendue → AUCUN événement OK « Brief enrichi » (journal ${JSON.stringify(ev)})`);
  T(r.extra.brief === r.extra.orig, `sortie sans la clé attendue → brief intact, reçu « ${r.extra.brief} »`);
  T(r.extra.neg === "low quality", `sortie sans la clé attendue (mais avec un négatif) → négatif intact, reçu « ${r.extra.neg} »`);
  T(r.nPrompts === 0, `le ✨ ne soumet aucun job (${r.nPrompts})`);
};
E["S-Q3"] = (r, T, all) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "QWEN_EDIT_INSTRUCTION (ENHANCE.qwenInstruction)");
  T(r.ollama[0]?.user === rawBrief, "Qwen-Edit 2509 i2i : le brief part seul");
  T(r.extra.brief.includes("enriched prompt text"), `Qwen-Edit 2509 i2i : la clé {"instruction"} de la sortie remplace le brief, reçu « ${r.extra.brief.slice(0, 60)} »`);
  T(r.extra.neg === "low quality", "Qwen-Edit 2509 i2i : le négatif de l'utilisateur ne doit pas être réécrit");
  T(r.nPrompts === 0, `le ✨ ne soumet aucun job (${r.nPrompts})`);
  const c = all["C-Q2"]?.ollama[0]; if (c) T(sameSys(r.ollama[0], c), "la consigne Qwen-Edit du Studio doit être octet pour octet celle du Canvas (C-Q2)");
};
// ✨ manuel du brief d'un storyboard (storyboard_v2 et storyboard_v2_qwen21, workflows `builtin`) : consigne du brief de storyboard, pas la générique
E["S-SB7"] = (r, T, all) => {
  nCalls(T, r, 2); sysIs(T, r, 0, "SHEET_BRIEF (ENHANCE.sheetBrief)"); sysIs(T, r, 1, "SHEET_BRIEF (ENHANCE.sheetBrief)");
  T(r.ollama.every(c => c.user === rawBrief), "le brief part tel quel (ni PRIMARY_STYLE ni négatif)");
  for (const wf of ["storyboard_v2", "storyboard_v2_qwen21"]) {
    const x = r.extra[wf] || {};
    T((x.brief || "").includes("enriched prompt text"), `${wf} : la clé {"brief"} de la sortie remplace le brief, reçu « ${String(x.brief).slice(0, 60)} »`);
    T(x.neg === "low quality", `${wf} : le négatif de l'utilisateur ne doit pas être réécrit`);
  }
  T(r.nPrompts === 0, `le ✨ ne soumet aucun job (${r.nPrompts})`);
  for (const id of ["C-SB1", "C-SB2"]) { const c = all[id]?.ollama[0]; if (c) T(sameSys(r.ollama[0], c), `la consigne du brief de storyboard du Studio doit être octet pour octet celle du Canvas (${id})`); }
};
// Canvas
E["C-K1"] = (r, T) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "KREA2_ENRICH_SYSTEM"); T(r.ollama[0]?.user === "a fox in a yellow raincoat", "✨ : le prompt de la carte part seul");
  T(r.extra.prop === r.extra.field && !PAD.test(r.extra.prop) && r.extra.prop.includes("enriched prompt text"), "sortie filtrée (stripPromptPadding) écrite dans le champ et la propriété");
  r.prompts[0] ? krea2Graph(T, r.prompts[0], "graphe", { text: r.extra.prop }) : T(false, "graphe absent");
};
E["C-K2"] = (r, T) => { nCalls(T, r, 0); r.prompts[0] ? krea2Graph(T, r.prompts[0], "graphe", { text: "a fox in a yellow raincoat" }) : T(false, "graphe absent"); };
E["C-Q1"] = (r, T) => {
  nCalls(T, r, 1); sysIs(T, r, 0, "ENHANCE.qwenImagePrompt");
  const n = r.prompts[0] && nodes(r.prompts[0], "TextEncodeQwenImage21")[0]; T(n && n.inputs.prompt === r.extra.prop, "graphe Qwen Image 2.1 : le prompt enrichi est celui du graphe");
};
E["C-Q2"] = (r, T) => { nCalls(T, r, 2); sysIs(T, r, 0, "QWEN_EDIT_INSTRUCTION (ENHANCE.qwenInstruction)"); sysIs(T, r, 1, "QWEN_EDIT_INSTRUCTION (ENHANCE.qwenInstruction)"); };
E["C-L1"] = (r, T) => { T(r.extra.enhanceButton === false, "LTX 2.5 : aucun bouton ✨ sur la carte Vidéo"); nCalls(T, r, 0); r.prompts[0] ? ltxGraph(T, r.prompts[0], "graphe LTX", "the fox runs") : T(false, "graphe absent"); };
E["C-H1"] = (r, T) => {
  T(r.extra.enhanceButton === true, "H3 : bouton ✨ présent"); nCalls(T, r, 1); sysIs(T, r, 0, "H3_VIDEO (ENHANCE.videoPrompt)");
  const p = r.prompts[0] && h3Prompt(r.prompts[0]);
  T(typeof p === "string" && p.startsWith(r.extra.align + "\n\n" + r.extra.prop) && p.length <= 7000, `H3 : alignement h3Alignment(false, 2) en tête puis texte enrichi, reçu « ${String(p).slice(0, 90)} »`);
};
E["C-SB1"] = (r, T) => {
  seq(T, r, "fiche personnage", "SHEET_BRIEF (ENHANCE.sheetBrief)", "CHARACTER_SYSTEM", "CHARACTER_SYSTEM(forceKind=human)", "CHARACTER_SYSTEM(forceKind=other)");
  T(/^enriched prompt text/.test(r.ollama[1]?.user || ""), "la fiche reçoit le brief enrichi par sheetBrief");
  r.prompts.forEach((g, i) => krea2Graph(T, g, `planche ${i + 1}`));
};
E["C-SB2"] = (r, T) => {
  seq(T, r, "fiche décor puis storyboard", "SHEET_BRIEF (ENHANCE.sheetBrief)", "LOCATION_SYSTEM", "SHEET_BRIEF (ENHANCE.sheetBrief)", "SHOTLIST_SYSTEM(n=4)");
  T(r.extra.shots === 4, `4 plans (${r.extra.shots})`); r.prompts[0] ? krea2Graph(T, r.prompts[0], "planche décor") : T(false, "graphe absent");
};
E["C-H2"] = (r, T) => {
  nCalls(T, r, 2); sysIs(T, r, 0, "R2V_BRIEF (ENHANCE.r2vBrief)"); sysIs(T, r, 1, "R2V_BRIEF (ENHANCE.r2vBrief)");
  const t = r.prompts[0] && r2vPrompt(r.prompts[0]); if (T(!!t, "graphe r2v sans grammaire Ref2VA")) { h3Fields(T, t, "r2v"); T(t.includes(r.extra.prop), "le brief enrichi est dans detailed_description"); }
  // jetons <Subject N> : substitués avant gemma, restaurés après (piège n°26), comme au Studio (S-H3)
  for (const i of [0, 1]) { const u = r.ollama[i]?.user || ""; T(!/<Subject/i.test(u) && /SUBJECTREF1/.test(u) && /SUBJECTREF2/.test(u), `Canvas : les jetons <Subject N> ne doivent jamais atteindre gemma (appel ${i + 1}), reçu « ${u.slice(0, 80)} »`); }
  for (const [k, v] of [["propriété", r.extra.prop], ["champ", r.extra.field]]) T(/<Subject 1>/.test(v) && /<Subject 2>/.test(v) && !/SUBJECTREF/.test(v), `Canvas : ${k} du brief enrichi doit retrouver <Subject 1> et <Subject 2>, reçu « ${String(v).slice(0, 80)} »`);
  const d = r.extra.drop || {};
  T(d.prop === d.orig && d.field === d.orig, `sortie de gemma sans jeton : le brief doit rester inchangé, reçu propriété « ${d.prop} » champ « ${d.field} »`);
  T(/<Subject N>/.test(d.err || "") && /^Enrichissement impossible : /.test(d.err || ""), `sortie de gemma sans jeton : l'erreur doit s'afficher sous le bouton, reçu « ${d.err} »`);
};
E["C-CV"] = (r, T) => {
  nCalls(T, r, 0); T(r.nPrompts === 6, `6 graphes (2 cuts × 3 moteurs), ${r.nPrompts}`);
  r.prompts.slice(0, 2).forEach((g, i) => ltxGraph(T, g, `cut ltx25 ${i + 1}`));
  r.prompts.slice(2, 4).forEach((g, i) => h3Fields(T, h3Prompt(g) || "", `cut minimax_h3 ${i + 1}`));
  r.prompts.slice(4, 6).forEach((g, i) => h3Fields(T, r2vPrompt(g) || "", `cut minimax_h3_r2v ${i + 1}`));
};

// ── Mutants (témoins négatifs) : une copie servie à la volée doit faire échouer ≥ 1 contrôle ──────────────────────
// edits(texte du fichier) → [[ancien, nouveau]…] (chaque ancien présent EXACTEMENT 1 fois) ou null = cible absente.
const readRoot = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const MUTANTS = [
  { id: "M1", about: "KREA2 et H3_VIDEO échangés dans engine.js", scenarios: ["C-K1", "S-K1", "C-H1", "S-H1"], file: "js/engine.js",
    edits: () => [["const KREA2_ENRICH_SYSTEM = ", "const @@T = "], ["const H3_VIDEO_ENRICH_SYSTEM = ", "const KREA2_ENRICH_SYSTEM = "], ["const @@T = ", "const H3_VIDEO_ENRICH_SYSTEM = "]] },
  { id: "M2", about: "la route H3 du Studio renvoie ENRICH_SYSTEM (briefEnrichSystem)", scenarios: ["S-H1", "S-H2"], file: "index.html",
    edits: t => { const i = t.indexOf("function briefEnrichSystem"), j = i < 0 ? -1 : t.indexOf("H3_VIDEO_ENRICH_SYSTEM", i); return j < 0 ? null : [[t.slice(j - 30, j + 22), t.slice(j - 30, j) + "ENRICH_SYSTEM"]]; } },
  { id: "M3", about: "h3Alignment retiré de VideoNode (js/nodes-simple.js)", scenarios: ["C-H1"], file: "js/nodes-simple.js",
    edits: () => [['E.h3Alignment(false, this.properties.duration) + "\\n\\n" + this.properties.prompt', "this.properties.prompt"]] },
  { id: "M4", about: "h3TokensOut retiré de l'enrichissement r2v (enrichBrief)", scenarios: ["S-H3"], file: "index.html",
    edits: t => { const i = t.indexOf("function enrichBrief"), j = i < 0 ? -1 : t.indexOf("h3TokensOut(", i); return j < 0 || j - i > 4000 ? null : [[t.slice(j - 20, j + 12), t.slice(j - 20, j) + "String("]]; } },
  { id: "M5", about: "Canvas : ENHANCE.videoPrompt remplacé par krea2Prompt", scenarios: ["C-H1"], file: "canvas.html",
    edits: () => [['n.properties.engine === "minimax_h3" ? ENHANCE.videoPrompt : null', 'n.properties.engine === "minimax_h3" ? ENHANCE.krea2Prompt : null']] },
  { id: "M6", about: "h3TokensOut retiré de l'enrichissement r2v du Canvas (addEnhanceButton)", scenarios: ["C-H2"], file: "canvas.html",
    edits: () => [["E.h3TokensOut(inp.value)", "String(inp.value)"]] },
  { id: "M7", about: "la route qwen_edit_i2i du Studio retombe sur ENRICH_SYSTEM (briefEnrichSystem)", scenarios: ["S-Q3"], file: "index.html",
    edits: () => [['return [QWEN_EDIT_INSTRUCTION_ENRICH_SYSTEM, "instruction"];', 'return [ENRICH_SYSTEM, "positive_prompt"];']] },
  { id: "M8", about: "la route storyboard_v2* du Studio retombe sur ENRICH_SYSTEM (briefEnrichSystem)", scenarios: ["S-SB7"], file: "index.html",
    edits: () => [['return [SHEET_BRIEF_ENRICH_SYSTEM, "brief"];', 'return [ENRICH_SYSTEM, "positive_prompt"];']] },
  { id: "M9", about: "le moteur Qwen Image 2.1 des keyframes reçoit le texte 2509 (keyframeModelName)", scenarios: ["S-SB3"], file: "index.html",
    edits: () => [['wf?.anchor === "api/qwen21_dual.json" ? "Qwen Image 2.1" : "Qwen-Image-Edit-2509"', '"Qwen-Image-Edit-2509"']] },
  { id: "M10", about: "l'événement OK « Brief enrichi » d'enrichBrief émis sans condition (même après un écartement)", scenarios: ["S-H3", "S-Q2"], file: "index.html",
    edits: () => [['if (applied) addEvent("OK", `Brief enrichi', 'addEvent("OK", `Brief enrichi']] },
  { id: "M11", about: "enrichBrief écrit le négatif de gemma même après un écartement (condition applied retirée)", scenarios: ["S-Q2"], file: "index.html",
    edits: () => [['if (applied && key === "positive_prompt" && out.negative_prompt)', 'if (key === "positive_prompt" && out.negative_prompt)']] },
  { id: "M12", about: "enrichBrief : branche « clé attendue absente » (WARN Enrichissement ignoré) retirée", scenarios: ["S-Q4"], file: "index.html",
    edits: t => { const i = t.indexOf("} else addEvent(\"WARN\", \"Enrichissement ignoré"); const j = i < 0 ? -1 : t.indexOf("\n", i); return j < 0 ? null : [[t.slice(i, j), "}"]]; } },
];

// ── Principal ───────────────────────────────────────────────────────────────────────────────────────────────────
function evaluate(id, rec, all) {
  const res = { total: 0, fails: [], notes: [] };
  const T = (c, m) => { res.total++; if (!c) res.fails.push(m); return !!c; };
  T.note = m => res.notes.push(m);
  T(!rec.errors.length, `erreurs de page : ${JSON.stringify(rec.errors).slice(0, 200)}`);
  try { E[id](rec, T, all); } catch (e) { T(false, `contrôle inexploitable : ${e.message}`); }
  return res;
}
async function runAll(list) {
  const all = {};
  for (const sc of list) { try { all[sc.id] = await record(sc); } catch (e) { if (/jamais prête/.test(e.message)) die(e.message); all[sc.id] = { ollama: [], prompts: [], nPrompts: 0, events: [], errors: [`exécution : ${e.message}`], extra: {} }; } }
  return all;
}
module.exports = { launchChrome, openPage, startServer, STUBS, PRE_STUDIO, sha };   // (inventaire du lot 0)
if (require.main === module) (async () => {
  const srv = await startServer(); SERVER = srv; CHROME = await launchChrome();
  let fails = 0, total = 0;
  try {
    const list = SPEC.filter(sc => !only || only.test(sc.id));
    const all = await runAll(list), bad = [];
    for (const sc of list) {
      const r = evaluate(sc.id, all[sc.id], all); total += r.total;
      console.log(`${r.fails.length ? "FAIL" : "PASS"} ${sc.id.padEnd(6)} ${r.total - r.fails.length}/${r.total} contrôles · gemma ${all[sc.id].ollama.length} appel(s) · ${all[sc.id].nPrompts} graphe(s)`);
      r.fails.forEach(m => console.log("   ✗ " + m)); r.notes.forEach(m => console.log("   · NOTE " + m));
      if (r.fails.length) { fails++; bad.push(sc.id); }
      if (SHOW) console.log(summarize(sc.id, all[sc.id]));
    }
    if (violations.length) { fails++; console.log("FAIL requête /comfy ou /ollama arrivée au serveur statique (bouchon contourné) : " + violations.slice(0, 5).join(", ")); }
    if (DUMP) fs.writeFileSync(DUMP, JSON.stringify(Object.fromEntries(Object.entries(all).map(([id, r]) => [id, { ...r, ollama: r.ollama.map(c => ({ ...c, system: undefined, consigne: gotName(c) || "inconnue", sha256: sha(c.system) })) }])), null, 1));
    let mutFail = 0;
    if (!NO_MUT && !only) for (const m of MUTANTS) {
      const edits = m.edits(readRoot(m.file));
      if (!edits) { console.log(`MUTANT ${m.id} cible absente (${m.about}) : non compté`); continue; }
      MUTATION = { file: m.file, edits };
      const sub = SPEC.filter(sc => m.scenarios.includes(sc.id)), res = await runAll(sub), killed = [];
      for (const sc of sub) {   // tué = un contrôle NOUVEAU échoue (un rouge déjà présent sans le mutant ne prouve rien)
        const base = new Set(evaluate(sc.id, all[sc.id], all).fails), e = evaluate(sc.id, res[sc.id], { ...all, ...res }), neu = e.fails.filter(m => !base.has(m));
        if (neu.length) killed.push(`${sc.id} (${neu[0].slice(0, 90)})`);
      }
      const broken = MUTATION.broken; MUTATION = null;
      if (broken) { console.log(`MUTANT ${m.id} mal formé : ${broken}`); mutFail++; continue; }
      console.log(killed.length ? `MUTANT ${m.id} tué — ${m.about} — par ${killed.join(" ; ")}` : `MUTANT ${m.id} SURVIT — ${m.about} : aucun contrôle ne l'a vu`);
      if (!killed.length) mutFail++;
    }
    console.log(`${total} contrôles · ${list.length} scénarios · ${fails ? fails + " en échec (" + bad.join(", ") + ")" : "tout vert"}${mutFail ? " · " + mutFail + " mutant(s) survivant(s)" : ""}`);
    await CHROME.close(); srv.srv.close();
    process.exit(fails || mutFail ? 1 : 0);
  } catch (e) { console.error(e); await CHROME.close(); process.exit(2); }
})();
