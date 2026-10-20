#!/usr/bin/env node
// node tools/parity-prompts.js [--verbose] [--index <index.html>] [--engine <engine.js>] [--baseline-file <index.html de référence>]
//
// Test de non-régression à trois voies de la compilation de prompts, dont js/engine.js est la source
// unique depuis I13-B (le Studio n'en garde que des adaptateurs fins) :
//   référence     = les fonctions de prompt du Studio d'AVANT la source unique, extraites de
//                   `git show a6d65c0:index.html` (lu en mémoire ; `--baseline-file` en repli) ;
//   Studio actuel = les adaptateurs extraits d'index.html, exécutés avec engine.js chargé puis
//                   déstructuré dans le même contexte vm (comme dans la page) ;
//   Engine        = engine.js seul, dans un autre contexte.
// Sur une matrice fixe, chaque cas est comparé octet pour octet : référence = Engine, référence =
// Studio actuel et Studio actuel = Engine. Les helpers d'état (style, gabarit) sont les vrais, extraits
// des deux côtés, avec les mêmes bouchons DOM (director, sélecteurs, pipeline, addEvent, gemma).
// Autonome : node seul, ni navigateur ni réseau (fetch bouchonné ; tout appel imprévu = violation = échec).
// Sortie 0 = TOUT PASSE ; 1 = écart ou violation ; 2 = test inutilisable (nom introuvable, fichier illisible).
// Voir docs/TESTING.md § « Parité des prompts Studio / Canvas ».
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path"), { execFileSync } = require("child_process");

const BASELINE_REV = "a6d65c0";   // dernier commit où le Studio portait sa propre copie des compilateurs
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const VERBOSE = argv.includes("--verbose");
const ROOT = path.join(__dirname, "..");
const IDX_PATH = path.resolve(opt("--index") || path.join(ROOT, "index.html"));
const ENG_PATH = path.resolve(opt("--engine") || path.join(ROOT, "js", "engine.js"));
const die = msg => { console.error("ERREUR (test inutilisable) : " + msg); process.exit(2); };
const read = p => { try { return fs.readFileSync(p, "utf8"); } catch (e) { die("lecture impossible : " + p + " (" + e.message + ")"); } };
let REF_SRC, REF_LABEL;
if (opt("--baseline-file")) { REF_LABEL = path.resolve(opt("--baseline-file")); REF_SRC = read(REF_LABEL); }
else {
  REF_LABEL = `git ${BASELINE_REV}:index.html`;
  try { REF_SRC = execFileSync("git", ["-C", ROOT, "show", `${BASELINE_REV}:index.html`], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { die(`référence illisible (${REF_LABEL} : ${String(e.stderr || e.message).trim()}) ; hors dépôt git, passer --baseline-file <index.html de ${BASELINE_REV}>`); }
}
const REF = { path: REF_LABEL, lines: REF_SRC.split("\n") }, CUR = { path: IDX_PATH, lines: read(IDX_PATH).split("\n") }, ENG = read(ENG_PATH);

// ── Extraction des fonctions du Studio, par bloc d'indentation ──────────────────────────────────
// Ligne de déclaration, puis les lignes plus indentées, puis la ligne fermante au même retrait ; un
// gabarit `…` multi-lignes court jusqu'à la ligne qui finit par "`;". Si le formatage du Studio change
// et que le bloc est tronqué, vm lève une SyntaxError : le test s'arrête (code 2), il ne passe pas.
function grab(src, name, re = new RegExp(`^( *)(?:const|let|function|async function) ${name}\\b`)) {
  const L = src.lines, i = L.findIndex(l => re.test(l));
  if (i < 0) die(`« ${name} » introuvable dans ${src.path} (renommé ou supprimé ? mettre à jour la liste des noms)`);
  const ind = L[i].match(/^ */)[0].length, out = [L[i]];
  if ((L[i].match(/`/g) || []).length % 2) {
    for (let j = i + 1; j < L.length; j++) { out.push(L[j]); if (/`;\s*$/.test(L[j])) break; }
    return out.join("\n");
  }
  let j = i + 1;
  for (; j < L.length; j++) { const l = L[j]; if (l.trim() && l.match(/^ */)[0].length <= ind) break; out.push(l); }
  if (L[j] && L[j].match(/^ */)[0].length === ind && /^\s*[}\])]/.test(L[j])) out.push(L[j]);
  return out.join("\n");
}

// Noms de la référence (Studio d'avant I13-B : sa propre copie des compilateurs), tous déclarés dans son index.html.
const REF_NAMES = ["OLLAMA_MODEL", "CAMERA_LIB", "LIGHTING_LIB", "STYLE_PACKS", "KREA2_ENRICH_SYSTEM", "PROMPT_PADDING", "stripPromptPadding",
  "KEYFRAME_ANCHOR_DUAL", "KEYFRAME_ANCHOR_SOLO", "compileKeyframePrompt", "compileCutPrompt",
  "h3CutSubjects", "h3CutBodyText", "buildH3CutPrompt", "compileCutPromptFor",
  "CAMERA_ALIASES", "LIGHTING_ALIASES", "normalizeId", "normalizeCamera", "normalizeLighting", "FALLBACK_ROTATION", "fallbackShots", "normalizeShotList",
  "HOLD_MOTION", "fieldText", "CHAR_FIELD_KEYS", "CHAR_OTHER_FIELD_KEYS", "charKindOf", "charFieldKeys", "LOC_FIELD_KEYS",
  "charDescFromFields", "locDescFromFields", "MAX_SHOT_SUBJECTS", "shotSubjectIdx", "shotSubjects", "shotCharDesc",
  "characterSheetFromBrief", "locationSheetFromBrief", "shotListFromBrief",
  "SHEET_CLEAN", "SUBJECT_GUARD", "sheetWords", "SHEET_HEAD", "SHEET_SWATCHES", "SHEET_SAME", "SHEET_TEMPLATES",
  "currentStyleText", "currentSheetLayout", "charsheetPromptFrom", "compileCharsheetPrompt", "compileLocsheetPrompt",
  "H3_PROMPT_CHARS", "h3Subject", "h3Picture", "H3_SUBJECT_KINDS", "h3AssignSubjects", "h3Summary", "h3RefBody",
  "buildH3RefPrompt", "capH3Prompt", "h3VideoFrames", "h3RealDuration", "h3Alignment"];
// Noms déclarés par le Studio actuel (adaptateurs, helpers d'état, ce qui lui reste propre) ; le reste
// vient de sa déstructuration de window.Engine, extraite telle quelle.
const CUR_NAMES = ["KREA2_ENRICH_SYSTEM", "currentStyleId", "currentStyleText", "compileKeyframePrompt", "compileCutPrompt",
  "h3CutSubjects", "h3CutBodyText", "buildH3CutPrompt", "compileCutPromptFor", "HOLD_MOTION",
  "MAX_SHOT_SUBJECTS", "shotSubjectIdx", "shotSubjects", "shotCharDesc",
  "characterSheetFromBrief", "locationSheetFromBrief", "shotListFromBrief",
  "currentSheetTemplateId", "charsheetPromptFrom", "compileCharsheetPrompt", "buildCharsheetGraph", "compileLocsheetPrompt", "buildLocsheetGraph",
  "warnH3", "capH3Prompt"];
// Noms d'Engine.* utilisés (tous doivent exister, sinon erreur explicite).
const ENGINE_NAMES = ["OLLAMA_MODEL", "STYLE_PACKS", "CAMERA_LIB", "LIGHTING_LIB", "SHEET_CLEAN", "SHEET_TEMPLATES", "KEYFRAME_ANCHOR_SOLO", "KEYFRAME_ANCHOR_DUAL",
  "KREA2_ENRICH_SYSTEM", "stripPromptPadding", "charKindOf", "charDescFromFields", "locDescFromFields", "charsheetPromptFrom", "buildCharsheetGraph",
  "buildLocsheetGraph", "styleTextFor", "compileKeyframePrompt", "compileCutPrompt", "compileCutPromptFor", "buildH3CutPrompt", "h3CutSubjects",
  "h3CutBodyText", "h3AssignSubjects", "h3Summary", "h3RefBody", "buildH3RefPrompt", "capH3Prompt", "h3Alignment", "h3VideoFrames", "h3RealDuration",
  "characterSheetFromBrief", "locationSheetFromBrief", "shotListFromBrief"];

// ── Contextes vm, réseau bouchonné ──────────────────────────────────────────────────────────────
const violations = [];
function mkCtx(side) {
  const ctx = { console, JSON, Math, Object, Array, Number, String, Set, Map, Promise, Error, RegExp, Response, crypto: globalThis.crypto,
    setTimeout: f => setTimeout(f, 0), location: undefined, __gq: [], __gcalls: [] };
  ctx.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/ollama/api/chat")) {   // seul appel prévu : gemma rejoué depuis __gq
      const b = JSON.parse(opts.body);
      if ("think" in b) ctx.__gcalls.push([b.messages[0].content, b.messages[1].content]);   // 1re tentative seulement (le retry sans think renvoie le même message)
      if (!ctx.__gq.length) { violations.push(`${side} : appel ollama sans réponse préparée`); return new Response("{}", { status: 403 }); }
      const r = ctx.__gq.shift();
      if (r instanceof Error) { ctx.__gq.unshift(r); if (!("think" in b)) ctx.__gq.shift(); return new Response("{}", { status: 500 }); }
      return new Response(JSON.stringify({ message: { content: JSON.stringify(r) } }));
    }
    if (u.includes("/comfy/object_info")) return new Response("{}");   // fetchLoraOptions au chargement d'engine.js
    violations.push(`${side} : ${u}`); return new Response("{}", { status: 403 });
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  return vm.createContext(ctx);
}
function runEngine(c) {
  try { vm.runInContext(ENG, c, { filename: ENG_PATH }); } catch (e) { die(`${ENG_PATH} ne s'exécute pas : ${e.message}`); }
  if (!c.Engine) die(`${ENG_PATH} n'expose pas window.Engine`);
  return c;
}
// Mêmes bouchons DOM des deux côtés : director, sélecteurs (#styleSelect, #sheetTemplateSelect, #videoDuration),
// pipeline courant (avec ou sans contrôle « style »), journal, brief. gemma : bouchon de gemmaJSON pour la
// référence (son contexte n'a pas d'Engine) ; le Studio actuel passe par le vrai Engine.gemmaJSON → fetch bouchonné.
const PRE = `let director = null;
    const __ev = []; function addEvent(c, t, k) { __ev.push([c, t, k]); }
    const brief = { value: "" }; const __dom = { videoDuration: { value: "2" }, styleSelect: { value: "cinematic" } }; const $ = id => __dom[id];
    const pipelineSelect = { value: "avec-style" }; const __pipes = { "avec-style": { controls: ["style", "sheetTemplate"] }, "sans-style": { controls: ["sheetTemplate"] } };
    function pipelineDef(id) { return __pipes[id]; }`;
function studio(src, names, side, withEngine) {
  const c = mkCtx(side);
  let head = PRE, exposed = names;
  if (withEngine) {
    runEngine(c);
    const destr = grab(src, "déstructuration de window.Engine", /^ *const \{\s*$/);
    if (!/\}\s*=\s*window\.Engine;/.test(destr)) die(`déstructuration de window.Engine non reconnue dans ${src.path}`);
    exposed = [...destr.replace(/\/\/.*$/gm, "").replace(/^\s*const \{|\}\s*=\s*window\.Engine;\s*$/g, "").split(",").map(s => s.trim()).filter(Boolean), ...names];
    head = destr + "\n" + PRE;
  } else head += `\n    async function gemmaJSON(sys, user) { __gcalls.push([sys, user]); const r = __gq.shift(); if (r instanceof Error) throw new Error("ollama 500"); return r; }`;
  // Bascule « Type de sujet » : le vrai gestionnaire de clic d'index.html, extrait et exécuté (pas une réécriture).
  const toggle = grab(src, "gestionnaire #charKindToggle", /^ *\$\("charKindToggle"\)\.addEventListener\("click"/);
  const code = head + "\n" + names.map(n => grab(src, n)).join("\n") + `
    let __toggle = null; __dom.charKindToggle = { addEventListener: (t, f) => { __toggle = f; } };
    function renderSheetMenu() {} function saveProject() {}
    ${toggle}
    if (!__toggle) throw new Error("gestionnaire de #charKindToggle non enregistré");
    ;globalThis.S = { ${exposed.join(",")}, __ev, brief, __dom,
      toggleKind: (f, kind) => { director = { charFields: f }; __toggle({ target: { closest: () => ({ dataset: { kind } }) } }); director = null; return f; },
      setDirector: d => { director = d; },
      setSelect: (id, v) => { __dom[id] = v === undefined ? undefined : { value: v }; },
      setStyleControl: on => { pipelineSelect.value = on ? "avec-style" : "sans-style"; },
      // style « st » au sélecteur ; undefined = pipeline sans contrôle style (texte vide des deux côtés, comme Engine avec styleId absent)
      setStyle: st => { pipelineSelect.value = st === undefined ? "sans-style" : "avec-style"; if (st !== undefined) __dom.styleSelect = { value: st }; } };`;
  try { vm.runInContext(code, c); } catch (e) { die(`le code extrait de ${src.path} ne s'exécute pas (${e.message}) ; l'extraction par indentation est à adapter`); }
  return c;
}
const SR = studio(REF, REF_NAMES, "référence", false), SC = studio(CUR, CUR_NAMES, "studio actuel", true);
const EC = runEngine(mkCtx("engine")), E = EC.Engine, XR = SR.S;
for (const n of ENGINE_NAMES) if (E[n] === undefined) die(`Engine.${n} introuvable dans ${ENG_PATH} (renommé ou retiré ? mettre à jour ENGINE_NAMES)`);

// ── Comptage des contrôles ──────────────────────────────────────────────────────────────────────
// Chaque `same(g, studio, engine)` est enregistré dans la passe en cours (référence, puis Studio actuel) ;
// les deux passes rejouent la même matrice, puis chaque cas donne trois contrôles :
//   « référence = Engine · g », « référence = Studio actuel · g », « Studio actuel = Engine · g ».
// has/truth (présence/absence, invariants) ne tournent que pendant la passe de référence, comme avant.
const RE_E = "référence = Engine", RE_S = "référence = Studio actuel", S_E = "Studio actuel = Engine";
const res = {}; let fails = 0;
const ser = v => JSON.stringify(v, (k, x) => typeof x === "function" ? "[fonction]" : x === undefined ? "[undefined]" : x);
const G = g => (res[g] ||= { n: 0, ok: 0, bytes: 0, first: null });
const bad = v => v === undefined || (v && typeof v === "object" && v.__err !== undefined);   // un côté qui lève ou ne renvoie rien n'est jamais « égal »
const safe = f => { try { return f(); } catch (e) { return { __err: e.message }; } };
const record = (g, ok, detail) => { const r = G(g); r.n++; if (ok) r.ok++; else { fails++; r.first ||= detail; } };
const enc = v => (bad(v) ? { s: "ERR " + ser(v), bad: true } : { s: typeof v === "string" ? v : ser(v), bad: false });
let pass = null;   // { ref: bool, list: [] } pendant une passe
// `input` : libellé de l'entrée, pour retrouver le cas en échec.
function same(g, a, b, input) {
  if (pass.ref) for (const p of [RE_E, RE_S, S_E]) G(`${p} · ${g}`);   // ordre d'affichage
  pass.list.push({ g, a: enc(a), b: enc(b), input });
}
// Comparaisons à une seule voie : sameRef = référence seule (nom disparu du Studio actuel), sameCur = Studio actuel seul (adaptateur nouveau).
function one(g, a, b, input, lA, lB) {
  const A = enc(a), B = enc(b); G(g).bytes += Buffer.byteLength(A.s);
  record(g, !A.bad && !B.bad && A.s === B.s, { input, a: A.s, b: B.s, lA, lB });
}
const sameRef = (g, a, b, input) => { if (pass.ref) one(`${RE_E} · ${g}`, a, b, input, "référence", "Engine"); };
const sameCur = (g, a, b, input) => { if (!pass.ref) one(`${S_E} · ${g}`, a, b, input, "Studio actuel", "Engine"); };
const has = (g, text, needle, want = true, input) => { if (pass.ref) record(g, String(text).includes(needle) === want, { input: input || `${want ? "doit contenir" : "ne doit pas contenir"} « ${needle} »`, a: String(text), b: "" }); };
const truth = (g, ok, msg) => { if (pass.ref) record(g, !!ok, { input: msg, a: "faux", b: "vrai attendu" }); };

// ── Matrice ─────────────────────────────────────────────────────────────────────────────────────
const ALL_STYLES = Object.keys(XR.STYLE_PACKS);
const LONG = "very long ".repeat(500).trim();   // 4 999 caractères
const UNI = "Élodie, 女性の探偵 — casquette « rouge » 🦊 naïve café, ñandú Größe";
const PAD_TERMS = [["masterpiece", ["masterpiece"]], ["best quality", ["best quality"]], ["highest quality", ["highest quality"]], ["high quality", ["high quality"]],
  ["award[- ]winning", ["award winning", "award-winning", "Award-Winning"]], ["ultra[- ]detailed", ["ultra detailed", "ultra-detailed"]],
  ["hyper[- ]detailed", ["hyper detailed", "hyper-detailed"]], ["highly detailed", ["highly detailed"]], ["extremely detailed", ["extremely detailed"]],
  ["insanely detailed", ["insanely detailed"]], ["super detailed", ["super detailed"]], ["highly rendered", ["highly rendered"]],
  ["trending on artstation", ["trending on artstation", "Trending on ArtStation"]], ["artstation", ["artstation", "ArtStation"]], ["cgsociety", ["cgsociety"]],
  ["deviantart", ["deviantart"]], ["pixiv", ["pixiv"]], ["octane render", ["octane render", "Octane render"]], ["rendered in octane", ["rendered in octane"]],
  ["unreal engine(?: \\d)?", ["unreal engine", "Unreal Engine 5"]], ["v-?ray", ["v-ray", "vray", "V-Ray"]], ["redshift render", ["redshift render"]],
  ["8k(?: uhd)?", ["8k", "8K UHD", "8k uhd"]], ["4k", ["4k", "4K"]], ["16k", ["16k"]], ["32k", ["32k"]], ["uhd", ["uhd", "UHD"]]];
const alts = XR.PROMPT_PADDING.source.replace(/^\\s\*\\b\(\?:/, "").replace(/\)\\b$/, "");
const FIELDS = [
  { face: "round face with freckles", hair: "short brown hair", outfit: "blue wool coat", accessories: "", palette: "blue and brown" },
  { kind: "human", label: "weary detective", face: "lined face", hair: "grey hair", outfit: "trench coat", accessories: "fedora", palette: "grey" },
  { kind: "other", label: "adult male lion", subject: "adult male African lion, four-legged big cat", form: "muscular quadruped", surface: "tawny fur", details: "dark mane", palette: "ochre" },
  { kind: "other", face: "should not appear", subject: "six-legged mining robot", palette: "rust" },
  { kind: "human", face: "sharp jaw, ultra detailed, 8k", hair: "black hair, artstation", outfit: "red jacket, octane render", palette: "red" },
  { kind: "other", subject: "a dragon, hyper-detailed scales, 8k UHD", form: { body: "long serpentine body", legs: "four legs" }, surface: ["green scales", "gold belly"], palette: "" },
  { kind: "human", face: UNI, hair: "  \n cheveux longs \t", outfit: LONG, accessories: null, palette: 42 },
  { kind: "other", subject: "", form: "", surface: "", details: "", palette: "only a palette" },
  { kind: "bogus", face: "x", subject: "y" }, { kind: "human" }, { kind: "other" }, {}, null, undefined, "not an object", []];
const LOCS = [{ place: "a quiet harbor pier", architecture: "wooden piers", materials: "wet planks", lighting: "soft dawn light", palette: "teal" },
  { place: "a desert canyon, ultra detailed, 8k, artstation", architecture: "", materials: "red sandstone, trending on artstation", lighting: "", palette: "ochre" },
  { place: UNI, architecture: { a: "arches", b: ["x", "y"] }, materials: LONG, lighting: null, palette: 7 }, {}, null, undefined];
const DESCS = ["round face with freckles, short brown hair, blue wool coat", "adult male African lion, four-legged big cat, tawny fur", UNI, LONG, "", "a fox."];
const TPLS = [undefined, "auto", "turnaround", "expressions", "portrait", "wardrobe", "action", "bogus", null];
const sheetText = g => g && Object.values(g).find(n => n.class_type === "CLIPTextEncode")?.inputs.text;
const SHOTS = [
  { camera: "wide", lighting: "morning", action: "walks along the pier", emotion: "calm", extra: "" },
  { camera: "close_up", lighting: "moonlight", action: "looks up at the sky", emotion: "", extra: "Rain streaks across the frame." },
  { camera: "bogus", lighting: "bogus", action: "stops and turns around", emotion: "quiet resolve", extra: "Mist on the water." },
  { camera: "tracking", lighting: "fire", action: UNI, emotion: "  joie  ", extra: "  Plan-séquence « long ».  " },
  { camera: "extreme_wide", lighting: "studio", action: LONG, emotion: LONG, extra: LONG },
  { action: "no camera, no light", emotion: "  ", extra: "\n" }];
const SUBJ = [{ desc: DESCS[0], kind: "human" }, { desc: DESCS[1], kind: "other" }, { desc: "a vintage leather shoe, brown oxford", kind: "other" },
  { desc: "young man with smooth skin, straight black hair", kind: "human" }, { desc: UNI, kind: "human" }];
const LOCD = ["", "a quiet harbor pier at dawn, wooden piers", UNI, "  padded location  "];
const CHARF = [FIELDS[1], FIELDS[2]];
const R2V = [[{ kind: "character", desc: DESCS[0] }, { kind: "environment", desc: "a harbor pier." }],
  [{ kind: "character", desc: DESCS[0] }, { kind: "environment", desc: "a harbor pier" }, { kind: "reference", desc: "" }],
  [{ kind: "character", desc: "a fox" }, { kind: "character", desc: "a crow" }, { kind: "environment", desc: "a forest" }, { kind: "reference", desc: "a red lantern" }, { kind: "bogus" }],
  [{ kind: "environment", desc: "only a place" }], [{ kind: "character", desc: UNI }, { kind: "environment", desc: "  spaced . . " }], [{ kind: "character" }, { kind: "reference" }],
  Array.from({ length: 12 }, (_, i) => ({ kind: ["character", "environment", "reference"][i % 3], desc: "d" + i })), []];
const BODIES = ["The fox runs. Then it stops!", "x".repeat(260) + ". tail", "", "No punctuation at all", UNI + ". Suite ?", "   ...   ", LONG, "Question? Non.", null, undefined];
const CAP = 7000;
const DURS = [...Array.from({ length: 20 }, (_, i) => (i + 1) * 0.5), 0, 0.01, 0.3, 1.04, 2.5, 3.333, 7.77, 12.7, 60];
const GEMMA17 = [
  { kind: "human", label: "weary detective", face: "lined face", hair: "grey hair", outfit: "trench coat", accessories: "fedora", palette: "grey" },
  { kind: "other", label: "adult male lion", subject: "adult male African lion", form: "quadruped", surface: "tawny fur", details: "dark mane", palette: "ochre" },
  { kind: "human", label: "lion", subject: "adult male African lion", form: "quadruped", surface: "tawny fur", palette: "ochre" },   // étiquette FAUSSE
  { kind: "other", face: "lined face", hair: "grey hair", outfit: "trench coat", palette: "grey" },   // étiquette FAUSSE inverse
  { subject: "six-legged mining robot", form: "low chassis", palette: "rust" },   // étiquette ABSENTE
  { face: "round face", hair: "brown hair", palette: "blue" },
  { kind: "other", palette: "blue and brown" },   // PALETTE SEULE → repli sur le brief
  { kind: "human", face: "lined face", subject: "a lion", palette: "p" },   // égalité → arbitre kind
  { kind: "other", face: "lined face", subject: "a lion", palette: "p" },
  { kind: "other", subject: { species: "lion", legs: "four legs" }, surface: "fur, ultra detailed, 8k", palette: "gold" },
  { kind: "human", label: UNI, face: UNI, hair: LONG, outfit: ["a", { b: "c" }], palette: 5 },
  {}, { nope: 1 }, new Error("ollama 500"),
  { kind: "human", label: "mixte", face: "lined face", hair: "grey hair", subject: "a lion", palette: "p" }];   // les DEUX jeux remplis (2 humain contre 1 autre)
const FORCE_SUFFIX = k => ` The user has already decided: kind is "${k}". Set "kind" to "${k}" and fill only the ${k} field set.`;

// Une passe : `X` = l'objet exposé par le Studio (référence ou actuel), `S` = son contexte vm (files gemma).
async function matrix(X, S) {
  // A. constantes : ids, ordre, libellés, textes
  same("STYLE_PACKS (14 entrées)", X.STYLE_PACKS, E.STYLE_PACKS);
  truth("STYLE_PACKS (14 entrées)", ALL_STYLES.length === 14 && ALL_STYLES.includes("none"), `${ALL_STYLES.length} entrées côté Studio (14 attendues, « none » compris)`);
  same("CAMERA_LIB / LIGHTING_LIB", [X.CAMERA_LIB, X.LIGHTING_LIB], [E.CAMERA_LIB, E.LIGHTING_LIB]);
  same("SHEET_TEMPLATES (ids, libellés)", Object.entries(X.SHEET_TEMPLATES).map(([k, v]) => [k, v.label]), Object.entries(E.SHEET_TEMPLATES).map(([k, v]) => [k, v.label]));
  sameRef("SHEET_CLEAN", X.SHEET_CLEAN, E.SHEET_CLEAN);   // le Studio actuel ne le lit plus qu'à travers les planches
  same("KEYFRAME_ANCHOR_*", [X.KEYFRAME_ANCHOR_SOLO, X.KEYFRAME_ANCHOR_DUAL], [E.KEYFRAME_ANCHOR_SOLO, E.KEYFRAME_ANCHOR_DUAL]);
  same("OLLAMA_MODEL", X.OLLAMA_MODEL, E.OLLAMA_MODEL);
  truth("OLLAMA_MODEL", X.OLLAMA_MODEL === "gemma4:e4b", "OLLAMA_MODEL doit rester gemma4:e4b (règle du projet)");
  // KREA2_ENRICH_SYSTEM : seule exception de texte admise = la clé de sortie ({"positive_prompt"} côté Studio, {"prompt"} côté Canvas).
  truth("KREA2_ENRICH_SYSTEM (clé {\"prompt\"})", X.KREA2_ENRICH_SYSTEM.includes('{"positive_prompt": "..."}'), "la clé de sortie attendue du Studio a changé : mettre à jour l'exception");
  same("KREA2_ENRICH_SYSTEM (clé {\"prompt\"})", X.KREA2_ENRICH_SYSTEM.replace('{"positive_prompt": "..."}', '{"prompt": "..."}'), E.KREA2_ENRICH_SYSTEM);

  // B. stripPromptPadding / PROMPT_PADDING : une entrée par alternative de la regex de la référence (et le décompte doit suivre)
  truth("stripPromptPadding", alts.split("|").length === PAD_TERMS.length && PAD_TERMS.every(([a]) => alts.includes(a)),
    `PROMPT_PADDING de la référence a ${alts.split("|").length} alternatives, ce test en couvre ${PAD_TERMS.length} : ajouter les nouvelles à PAD_TERMS`);
  const PAD_IN = ["", "clean text", "no padding here, just a red coat.", "masterpiece, best quality", "photorealistic, fine detail, epic scale", UNI, LONG + ", 8k, artstation",
    "8k, 4k, uhd", "A fox. 8k. Unreal Engine 5, v-ray", "  ,  masterpiece ,  ", "trending on ArtStation.", "artstation, ", "award winning photo of a lion, hyper detailed mane"];
  for (const [, samples] of PAD_TERMS) for (const t of samples) {
    for (const tpl of ["A fox, T, in the snow.", "T", "Red coat. T. Blue hat", "T, T; wet T", "T is not a word: tfoo"]) PAD_IN.push(tpl.replace(/T/g, t));
    truth("stripPromptPadding (le terme est retiré)", X.stripPromptPadding("a fox, " + t + ", snow") === "a fox, snow", `« ${t} » n'est plus retiré par le Studio`);
  }
  for (const t of PAD_IN) same("stripPromptPadding", X.stripPromptPadding(t), safe(() => E.stripPromptPadding(t)), JSON.stringify(t).slice(0, 80));

  // C. champs de fiche → description ; type de sujet
  FIELDS.forEach((f, i) => {
    same("charDescFromFields", X.charDescFromFields(f), safe(() => E.charDescFromFields(f)), "fiche #" + i);
    same("charKindOf", X.charKindOf(f), safe(() => E.charKindOf(f)), "fiche #" + i);
  });
  LOCS.forEach((f, i) => same("locDescFromFields", X.locDescFromFields(f), safe(() => E.locDescFromFields(f)), "décor #" + i));
  { const d = E.charDescFromFields(FIELDS[4]);
    for (const b of ["8k", "artstation", "ultra detailed", "octane"]) has("padding retiré des fiches (absence/présence)", d, b, false);
    for (const g of ["sharp jaw", "black hair", "red jacket", "red"]) has("padding retiré des fiches (absence/présence)", d, g, true); }

  // D. planches personnage : kind × gabarit × style × description ; planche décor × style
  for (const kind of [undefined, "human", "other", "bogus"]) for (const t of TPLS) for (const st of [undefined, ...ALL_STYLES, "bogus"]) for (const d of DESCS) {
    X.setStyle(st);
    const s = X.charsheetPromptFrom(d, kind, t), tag = `${kind}/${t}/${st}/${d.slice(0, 20)}`;
    same("charsheetPromptFrom", s, safe(() => E.charsheetPromptFrom(d, kind, t, st)), tag);
    same("buildCharsheetGraph (texte du nœud)", s, safe(() => sheetText(E.buildCharsheetGraph(d, "neg", 7, 1920, 1088, st, "", kind, t))), tag);
  }
  X.setStyle("cinematic");
  { const human = E.charsheetPromptFrom(DESCS[0], "human", "turnaround", "cinematic"), other = E.charsheetPromptFrom(DESCS[1], "other", "turnaround", "cinematic");
    has("planche (absence/présence)", human, XR.SUBJECT_GUARD.trim(), false); has("planche (absence/présence)", other, XR.SUBJECT_GUARD.trim(), true);
    has("planche (absence/présence)", human, "four standing poses", true); has("planche (absence/présence)", other, "four standing poses", false);
    has("planche (absence/présence)", human, "costume details", true); has("planche (absence/présence)", other, "costume", false);
    has("planche (absence/présence)", other, "one single subject", true); has("planche (absence/présence)", other, "person", false); }
  for (const st of [undefined, ...ALL_STYLES, "bogus"]) for (const loc of [LOCS[0].place, UNI, LONG, ""]) {
    X.setStyle(st);
    same("compileLocsheetPrompt = planche décor Engine", X.compileLocsheetPrompt(loc), safe(() => sheetText(E.buildLocsheetGraph(loc, "", 3, 1920, 1088, st, ""))), `${st}/${loc.slice(0, 20)}`);
  }
  X.setStyle("cinematic");

  // E. keyframes : 1 et 2 sujets × kinds × plans × décor × style
  for (const shot of SHOTS) for (const loc of LOCD) for (const st of ALL_STYLES) {
    X.setStyle(st);
    for (const sub of SUBJ) {   // 1 sujet : chaîne (appel actuel du Canvas) et [{desc, kind}]
      X.setDirector({ chars: [{ fields: { kind: sub.kind }, variants: [], active: 0 }] });
      const s = X.compileKeyframePrompt(shot, [sub.desc], loc), tag = `${st}/${sub.kind}/${loc.slice(0, 12)}/${(shot.action || "").slice(0, 15)}`;
      same("compileKeyframePrompt (1 sujet)", s, safe(() => E.compileKeyframePrompt(shot, sub.desc, loc, st)), tag + " (chaîne)");
      same("compileKeyframePrompt (1 sujet)", s, safe(() => E.compileKeyframePrompt(shot, [sub], loc, st)), tag + " ([{desc,kind}])");
    }
    for (const [a, b] of [[0, 3], [0, 1], [1, 0], [1, 2], [2, 1], [4, 1], [1, 1]]) {
      X.setDirector({ chars: [{ fields: { kind: SUBJ[a].kind } }, { fields: { kind: SUBJ[b].kind } }] });
      same("compileKeyframePrompt (2 sujets)", X.compileKeyframePrompt({ ...shot, subjects: [0, 1] }, [SUBJ[a].desc, SUBJ[b].desc], loc),
        safe(() => E.compileKeyframePrompt(shot, [SUBJ[a], SUBJ[b]], loc, st)), `${st}/${SUBJ[a].kind}+${SUBJ[b].kind}/${loc.slice(0, 12)}`);
    }
  }
  { // sujet sans description : écarté des deux côtés (une liste [vide, X] devient un seul sujet)
    X.setStyle("none"); X.setDirector({ chars: [{ fields: { kind: "human" } }, { fields: { kind: "other" } }] });
    for (const [a, b] of [["", "a fox"], ["a fox", ""], ["", ""]]) for (const shot of SHOTS.slice(0, 3))
      same("compileKeyframePrompt (sujet sans description)", X.compileKeyframePrompt({ ...shot, subjects: [0, 1] }, [a, b], "a pier"),
        safe(() => E.compileKeyframePrompt(shot, [{ desc: a, kind: "human" }, { desc: b, kind: "other" }], "a pier", "none")), `[${a}] [${b}]`);
  }
  X.setDirector(null); X.setStyle("cinematic");
  { const solo = E.compileKeyframePrompt(SHOTS[0], DESCS[0], "a pier", "none"), noLoc = E.compileKeyframePrompt(SHOTS[0], DESCS[0], "", "none");
    const dual = E.compileKeyframePrompt(SHOTS[0], [SUBJ[2], SUBJ[1]], "a pier", "none");
    has("keyframe (absence/présence)", solo, "standing in that location", false); has("keyframe (absence/présence)", solo, "present in that location", true);
    has("keyframe (absence/présence)", solo, "costume", false); has("keyframe (absence/présence)", solo, "clothing if any", true);
    has("keyframe (absence/présence)", solo, "Frame it as " + XR.CAMERA_LIB.wide.frame + ". The location is a pier.", true);
    has("keyframe (absence/présence)", noLoc, "The location is", false);
    has("keyframe (absence/présence)", dual, "one single subject, a vintage leather shoe", true); has("keyframe (absence/présence)", dual, "one single other subject", true);
    has("keyframe (absence/présence)", dual, XR.KEYFRAME_ANCHOR_DUAL, true); has("keyframe (absence/présence)", dual, XR.KEYFRAME_ANCHOR_SOLO, false); }

  // F. cuts : compileCutPrompt seul, puis LTX 2.5 et H3 × durées × image de fin × tenue × 1/2 sujets × décor × style
  for (const shot of SHOTS) for (const st of ALL_STYLES) for (const loc of LOCD) for (const hold of [null, "", X.HOLD_MOTION]) {
    X.setStyle(st);
    same("compileCutPrompt", X.compileCutPrompt(shot, DESCS[0], loc, hold), safe(() => E.compileCutPrompt(shot, DESCS[0], loc, hold, st)), `${st}/${loc.slice(0, 12)}/${hold}`);
  }
  for (const shot of SHOTS) for (const nSub of [1, 2]) for (const loc of LOCD) for (const st of ALL_STYLES)
    for (const eng of ["ltx25", "minimax_h3"]) for (const dur of [1, 3.5]) for (const hasLast of [false, true]) for (const hold of [null, X.HOLD_MOTION]) {
      X.setStyle(st);
      X.setDirector({ chars: CHARF.map(f => ({ fields: f, variants: [], active: 0 })) });
      const sh = { ...shot, subjects: nSub === 2 ? [0, 1] : [0] };
      const s = X.compileCutPromptFor(sh, X.shotCharDesc(sh), loc, hold, eng, dur, hasLast);
      const subs = CHARF.slice(0, nSub).map(f => ({ desc: E.charDescFromFields(f), kind: E.charKindOf(f) }));
      const tag = `${st}/${nSub} sujet(s)/${loc.slice(0, 12)}/${dur}s/fin=${hasLast}/tenue=${!!hold}/${(shot.action || "").slice(0, 12)}`;
      same(`compileCutPromptFor (${eng})`, s, safe(() => E.compileCutPromptFor(shot, subs, loc, hold, eng, dur, hasLast, st)), tag);
      if (eng === "minimax_h3") {
        same("buildH3CutPrompt (corps ré-enrichi)", X.buildH3CutPrompt(sh, loc, hold, dur, "REWRITTEN BODY.", hasLast),
          safe(() => E.buildH3CutPrompt(shot, subs, loc, hold, dur, "REWRITTEN BODY.", hasLast, st)), tag);
        same("h3CutSubjects + h3CutBodyText (H3 par plan)", [X.h3CutSubjects(sh, loc), X.h3CutBodyText(sh, X.h3CutSubjects(sh, loc), hold)],
          safe(() => { const q = E.h3CutSubjects(subs, loc); return [q, E.h3CutBodyText(shot, q, hold, st)]; }), tag);
      }
    }
  X.setDirector(null); X.setStyle("cinematic");
  { const one = E.compileCutPromptFor(SHOTS[0], [{ desc: "a fox" }], "a pier", null, "minimax_h3", 1, true, "none");
    const two = E.compileCutPromptFor(SHOTS[0], [{ desc: "a fox" }, { desc: "a crow" }], "a pier", null, "minimax_h3", 1, false, "none");
    has("cut H3 (absence/présence)", one, "How the reference pictures align", true); has("cut H3 (absence/présence)", one, `${(39 / 24).toFixed(2)}-second mark`, true);
    has("cut H3 (absence/présence)", one, "is the main character in", true); has("cut H3 (absence/présence)", two, "is the main character in", false);
    has("cut H3 (absence/présence)", two, "<Subject 1> and <Subject 2> are in <Subject 3>.", true); has("cut H3 (absence/présence)", two, "subject_definitions:", true);
    has("cut LTX (absence/présence)", E.compileCutPromptFor(SHOTS[0], "a fox", "a pier", null, "ltx25", 3, false, "none"), "subject_definitions", false); }
  { // sujets multiples : le Studio borne (MAX_SHOT_SUBJECTS), dédoublonne et écarte les indices hors liste ; le Canvas reçoit la liste déjà résolue
    const chars = [0, 1, 2].map(i => ({ fields: { kind: "human", face: DESCS[i % 2] + " #" + i, palette: "" }, variants: [], active: 0 }));
    chars.push({ fields: { kind: "human" }, variants: [], active: 0 });   // sujet sans description
    X.setDirector({ chars }); X.setStyle("cinematic");
    truth("sujets multiples (plafond, indices, doublons)", X.MAX_SHOT_SUBJECTS === 2, `MAX_SHOT_SUBJECTS = ${X.MAX_SHOT_SUBJECTS} (2 attendu : plafond des entrées image de Qwen-Edit)`);
    for (const raw of [undefined, [0], [1, 1], [2, 0, 1], [5, -1, 1.5, "x", 2], [], [3], [3, 0], [0, 3]]) for (const eng of ["ltx25", "minimax_h3"]) {
      const sh = { ...SHOTS[1], subjects: raw }, subs = X.shotSubjects(sh).map(s => ({ desc: s.desc, kind: "human" }));
      same(`sujets multiples (plafond, indices, doublons)`, X.compileCutPromptFor(sh, X.shotCharDesc(sh), "a pier", null, eng, 2, false),
        safe(() => E.compileCutPromptFor(sh, subs, "a pier", null, eng, 2, false, "cinematic")), `${eng} subjects=${JSON.stringify(raw)}`);
    }
    X.setDirector(null);
  }

  // G. Ref2VA : buildH3RefPrompt / h3AssignSubjects / h3Summary / h3RefBody / h3Subject / <Picture N>
  R2V.forEach((list, li) => BODIES.forEach((body, bi) => {
    const a = X.h3AssignSubjects(list), tag = `liste #${li} × corps #${bi}`;
    same("h3AssignSubjects / h3Summary / h3RefBody", [a, X.h3Summary(body), X.h3RefBody(a, body)],
      safe(() => { const b = E.h3AssignSubjects(list); return [b, E.h3Summary(body), E.h3RefBody(b, body)]; }), tag);
    same("buildH3RefPrompt (r2v)", X.buildH3RefPrompt({ subjects: a, summary: X.h3Summary(body), body: X.h3RefBody(a, body) }),
      safe(() => { const b = E.h3AssignSubjects(list); return E.buildH3RefPrompt({ subjects: b, summary: E.h3Summary(body), body: E.h3RefBody(b, body) }); }), tag);
  }));
  const picOf = (P, n, label) => P.buildH3RefPrompt({ subjects: [{ kind: "character", desc: "", picture: n, label }], summary: "", body: "" }).match(/<Picture \d+>/)[0];
  for (let n = 1; n <= 15; n++) same("h3Subject / h3Picture (numérotation)", [X.h3Subject(n), picOf(X, n, X.h3Subject(n))],
    safe(() => { const [s] = E.h3AssignSubjects(Array.from({ length: n }, () => ({ kind: "character", desc: "d" }))).slice(-1); return [s.label, picOf(E, n, s.label)]; }), "n=" + n);
  { // sujets construits à la main : kinds inconnus, points/espaces finaux, plusieurs personnages (lead multi)
    const mk = (kinds, descs) => kinds.map((kind, i) => ({ kind, desc: descs[i], picture: (i % 4) + 1, label: `<Subject ${i + 1}>` }));
    for (const kinds of [["character"], ["character", "character"], ["character", "character", "environment"], ["environment", "reference"], ["bogus", "character"], ["reference", "reference", "reference"], []])
      for (const descs of [["a.", "b ..", "c  "], ["", "", ""], [UNI, LONG, "x"], [undefined, null, "z"]]) {
        const sub = mk(kinds, descs);
        same("buildH3RefPrompt (sujets à la main)", X.buildH3RefPrompt({ subjects: sub, summary: "s", body: "b" }), safe(() => E.buildH3RefPrompt({ subjects: sub, summary: "s", body: "b" })), `${kinds}/${JSON.stringify(descs).slice(0, 30)}`);
      }
  }
  { // cuts r2v (Canvas) : h3CutBodyText + Ref2VA + plafond
    for (const st of ALL_STYLES) for (const shot of SHOTS) for (const hold of [null, X.HOLD_MOTION]) for (const [li, list] of R2V.entries()) {
      X.setStyle(st);
      const a = X.h3AssignSubjects(list), tag = `${st}/${(shot.action || "").slice(0, 12)}/tenue=${!!hold}/liste #${li}`;
      same("cut r2v (h3CutBodyText + Ref2VA + plafond)", X.capH3Prompt(X.buildH3RefPrompt({ subjects: a, summary: X.h3Summary(shot.action), body: X.h3CutBodyText(shot, a, hold) })),
        safe(() => { const b = E.h3AssignSubjects(list); return E.capH3Prompt(E.buildH3RefPrompt({ subjects: b, summary: E.h3Summary(shot.action), body: E.h3CutBodyText(shot, b, hold, st) })); }), tag);
    }
    X.setStyle("cinematic");
  }

  // H. plafond 7 000 caractères : constante, frontière exacte, blocs Ref2VA et texte libre, jetons coupés, avertissement
  truth("capH3Prompt (plafond 7 000)", XR.H3_PROMPT_CHARS === CAP, `H3_PROMPT_CHARS de la référence = ${XR.H3_PROMPT_CHARS} (7000 attendu, plafond du modèle)`);
  { const a = X.h3AssignSubjects(R2V[0]);
    const block = n => X.buildH3RefPrompt({ subjects: a, summary: "s", body: "<Subject 1> walks. ".repeat(n) });
    const exact = (n, filler) => { const b = X.buildH3RefPrompt({ subjects: a, summary: "s", body: "" }); return X.buildH3RefPrompt({ subjects: a, summary: "s", body: filler.repeat(Math.ceil(n)).slice(0, n - b.length) }); };
    const texts = [block(10), block(400), "x".repeat(7200), X.h3Alignment(true, 3) + "\n\n" + block(372), "<Subject 12>".repeat(700), "", "short",
      "x".repeat(6999), "x".repeat(7000), "x".repeat(7001), "x".repeat(7002), "<Su" + "x".repeat(6996) + "<Subject 4>", "x".repeat(6995) + "<Subject 4>", "é".repeat(8000),
      ...[6998, 6999, 7000, 7001, 7002, 7003, 7050, 9000, 20000].flatMap(n => [exact(n, "<Subject 1> walks. "), exact(n, "a"), exact(n, "<Picture 2> ")]),
      X.h3Alignment(false, 2) + "\n\n" + exact(7400, "b ")];
    texts.forEach((t, i) => {
      X.__ev.length = 0; const w = [];
      const s = X.capH3Prompt(t), e = safe(() => E.capH3Prompt(t, m => w.push(m)));
      same("capH3Prompt", s, e, `texte #${i} (${t.length} car.)`);
      same("capH3Prompt (avertissement)", X.__ev.map(v => v[1]), w, `texte #${i} (${t.length} car.)`);
      same("capH3Prompt (avertissement : code et classe du journal)", X.__ev.map(v => [v[0], v[2]]), w.map(() => ["WARN", "warn"]), `texte #${i} (${t.length} car.)`);
      truth("capH3Prompt (avertissement)", (t.length > CAP) === (w.length === 1) && w.length <= 1, `texte #${i} : ${w.length} avertissement(s) pour ${t.length} caractères`);
      if (t.length > CAP && t.includes("overall_soundscape") && !bad(e)) {
        truth("capH3Prompt (absence/présence)", e.length <= CAP && e.endsWith("non_diegetic_music:\nNone."), "fin de grammaire perdue : " + e.slice(-80));
        truth("capH3Prompt (absence/présence)", !/<[A-Za-z]* ?\d*\n\noverall/.test(e) || /<Subject \d+>\n\noverall/.test(e), "jeton partiel avant overall_soundscape");
      }
      if (!bad(e)) truth("capH3Prompt (≤ 7 000)", e.length <= CAP, `sortie de ${e.length} caractères`);
    });
  }

  // I. alignement temporel et grille 17n+5
  for (const d of DURS) for (const hl of [false, true]) {
    same("h3Alignment", X.h3Alignment(hl, d), safe(() => E.h3Alignment(hl, d)), `${d} s, fin=${hl}`);
    same("h3VideoFrames / h3RealDuration", [X.h3VideoFrames(d), X.h3RealDuration(d)], safe(() => [E.h3VideoFrames(d), E.h3RealDuration(d)]), `${d} s`);
  }
  truth("h3VideoFrames (1 s = 39 images, grille 17n+5)", E.h3VideoFrames(1) === 39 && X.h3VideoFrames(1) === 39, "1 s ≠ 39 images");
  for (const d of DURS) for (const P of ["", "slow push in", UNI, "x".repeat(6900), "x".repeat(7600)])   // carte Vidéo H3 : alignement + texte de l'utilisateur, plafonné
    same("carte Vidéo H3 (alignement + texte + plafond)", X.capH3Prompt(X.h3Alignment(false, d) + "\n\n" + P), safe(() => E.capH3Prompt(E.h3Alignment(false, d) + "\n\n" + P)), `${d} s, ${P.length} car.`);

  // K. I13-B : dépendances d'état du Studio (style, gabarit, décor) lues par les VRAIS helpers des deux côtés
  { // style : director.style > sélecteur > "cinematic" ; pipeline sans contrôle « style » → aucun style ("none")
    const CASES = [["director.style", { style: "noir" }, "anime", true, "noir"], ["director.style inconnu", { style: "bogus" }, "anime", true, "bogus"],
      ["director.style null → sélecteur", { style: null }, "anime", true, "anime"], ["director sans style → sélecteur", {}, "scifi", true, "scifi"],
      ["sélecteur sans director", null, "oil", true, "oil"], ["ni director ni sélecteur", null, undefined, true, "cinematic"],
      ["pipeline sans contrôle style", { style: "noir" }, "anime", false, "none"], ["pipeline sans contrôle style ni director", null, "anime", false, "none"]];
    for (const [label, dir, sel, ctl, want] of CASES) for (const shot of SHOTS.slice(0, 3)) for (const hold of [null, X.HOLD_MOTION]) {
      X.setDirector(dir && { ...dir, chars: CHARF.map(f => ({ fields: f, variants: [], active: 0 })) }); X.setSelect("styleSelect", sel); X.setStyleControl(ctl);
      const sh = { ...shot, subjects: dir ? [0, 1] : [0] }, subs = dir ? CHARF.map(f => ({ desc: E.charDescFromFields(f), kind: E.charKindOf(f) })) : [];
      const descs = subs.map(s => s.desc);
      same("style courant (director / sélecteur / pipeline sans style)", [X.compileKeyframePrompt(sh, descs.length ? descs : [DESCS[1]], "a pier"), X.compileCutPrompt(shot, "a fox", "a pier", hold),
        X.compileLocsheetPrompt("a pier"), X.charsheetPromptFrom("a fox", "other", "portrait"), X.h3CutBodyText(shot, X.h3AssignSubjects(R2V[0]), hold),
        dir ? X.compileCutPromptFor(sh, X.shotCharDesc(sh), "a pier", hold, "minimax_h3", 2, true) : ""],
      safe(() => [E.compileKeyframePrompt(shot, subs.length ? subs : [{ desc: DESCS[1], kind: "human" }], "a pier", want), E.compileCutPrompt(shot, "a fox", "a pier", hold, want),
        sheetText(E.buildLocsheetGraph("a pier", "", 3, 1920, 1088, want, "")), E.charsheetPromptFrom("a fox", "other", "portrait", want), E.h3CutBodyText(shot, E.h3AssignSubjects(R2V[0]), hold, want),
        dir ? E.compileCutPromptFor(shot, subs, "a pier", hold, "minimax_h3", 2, true, want) : ""]), `${label}/${(shot.action || "").slice(0, 12)}/tenue=${!!hold}`);
    }
    X.setDirector(null); X.setSelect("styleSelect", "cinematic"); X.setStyleControl(true);
  }
  { // gabarit omis : argument explicite > director.sheetTemplate > sélecteur > "auto" (= turnaround)
    const CASES = [["director.sheetTemplate", { sheetTemplate: "wardrobe" }, "action", "wardrobe"], ["director.sheetTemplate inconnu", { sheetTemplate: "bogus" }, "action", "bogus"],
      ["director.sheetTemplate null → sélecteur", { sheetTemplate: null }, "action", "action"], ["director sans gabarit → sélecteur", {}, "portrait", "portrait"],
      ["sélecteur sans director", null, "expressions", "expressions"], ["ni director ni sélecteur", null, undefined, "auto"]];
    for (const [label, dir, sel, want] of CASES) for (const kind of [undefined, "human", "other"]) for (const st of ["cinematic", "none"]) {
      X.setDirector(dir); X.setSelect("sheetTemplateSelect", sel); X.setStyle(st);
      same("gabarit omis (director / sélecteur / auto)", [X.charsheetPromptFrom(DESCS[0], kind), X.charsheetPromptFrom(DESCS[0], kind, "turnaround")],
        safe(() => [E.charsheetPromptFrom(DESCS[0], kind, want, st), E.charsheetPromptFrom(DESCS[0], kind, "turnaround", st)]), `${label}/${kind}/${st}`);
      for (const [fi, f] of FIELDS.entries())
        same("compileCharsheetPrompt (champs, gabarit omis)", X.compileCharsheetPrompt(f), safe(() => E.charsheetPromptFrom(E.charDescFromFields(f), E.charKindOf(f), want, st)), `${label}/fiche #${fi}/${st}`);
    }
    X.setDirector(null); X.setSelect("sheetTemplateSelect", undefined); X.setStyle("cinematic");
  }
  { // décor omis : celui de la session (director.locDesc), "" sans director ; un décor explicite, même vide, l'emporte
    for (const loc of [...LOCD, null]) for (const shot of SHOTS) for (const n of [1, 2]) {
      const pick = n === 2 ? [SUBJ[0], SUBJ[1]] : [SUBJ[2]];
      X.setDirector(loc === null ? null : { chars: pick.map(s => ({ fields: { kind: s.kind } })), locDesc: loc });
      const sh = { ...shot, subjects: n === 2 ? [0, 1] : [0] }, kinds = loc === null ? pick.map(() => "human") : pick.map(s => s.kind);
      const subs = pick.map((s, k) => ({ desc: s.desc, kind: kinds[k] }));
      same("compileKeyframePrompt (décor omis = celui de la session)", [X.compileKeyframePrompt(sh, pick.map(s => s.desc)), X.compileKeyframePrompt(sh, pick.map(s => s.desc), ""),
        X.compileKeyframePrompt(sh, pick.map(s => s.desc), "an explicit beach")],
        safe(() => [E.compileKeyframePrompt(shot, subs, loc ?? "", "cinematic"), E.compileKeyframePrompt(shot, subs, "", "cinematic"), E.compileKeyframePrompt(shot, subs, "an explicit beach", "cinematic")]),
        `${n} sujet(s)/décor ${JSON.stringify(loc)?.slice(0, 14)}/${(shot.action || "").slice(0, 12)}`);
    }
    X.setDirector(null);
  }
  // Adaptateurs de graphe du Studio actuel (nouveau paramètre `promptOverride` d'Engine) : Studio actuel seul.
  if (X.buildCharsheetGraph) for (const [fi, f] of FIELDS.entries()) for (const over of [undefined, "", "MY OWN EDITED PROMPT"]) for (const lora of ["", "Krea2/x.safetensors"]) {
    X.setDirector({ sheetTemplate: "action" }); X.setStyle("noir");
    sameCur("buildCharsheetGraph / buildLocsheetGraph (adaptateurs, promptOverride)",
      [X.buildCharsheetGraph(f, "neg", 7, 1920, 1088, lora, over), X.buildLocsheetGraph(DESCS[fi % DESCS.length], "neg", 9, 1920, 1088, lora, over)],
      safe(() => [E.buildCharsheetGraph(E.charDescFromFields(f), "neg", 7, 1920, 1088, "noir", lora, E.charKindOf(f), "action", over),
        E.buildLocsheetGraph(DESCS[fi % DESCS.length], "neg", 9, 1920, 1088, "noir", lora, over)]), `fiche #${fi}/override=${JSON.stringify(over)}/lora=${lora}`);
    X.setDirector(null); X.setStyle("cinematic");
  }

  // J. fiches et liste de plans rédigées par gemma (réponses rejouées, consigne + brief envoyés comparés)
  const runGemma = async (group, fnS, fnE, resp, input) => {
    X.__ev.length = 0; S.__gcalls.length = 0; EC.__gcalls.length = 0; const evE = [];
    S.__gq.length = 0; EC.__gq.length = 0; S.__gq.push(resp); EC.__gq.push(resp);
    const a = await safe(fnS), b = await safe(() => fnE((c, t, k) => evE.push([c, t, k])));
    const bb = await b;
    same(group, [a, X.__ev], [bb, evE], input);
    same(group + " (consigne + brief envoyés à gemma)", S.__gcalls, EC.__gcalls, input);
    S.__gq.length = 0; EC.__gq.length = 0;
    return bb;
  };
  const SCENES = ["A lion crosses the savanna at dawn.", UNI, "", "x".repeat(3000)];
  for (const scene of SCENES) {
    X.brief.value = scene;
    for (const [i, r] of GEMMA17.entries()) {
      const tag = `réponse #${i} × scène « ${scene.slice(0, 16)} »`;
      const f = await runGemma("characterSheetFromBrief", () => X.characterSheetFromBrief(), cb => E.characterSheetFromBrief(scene, cb), r, tag);
      if (f && !bad(f) && !(r instanceof Error)) same("characterSheetFromBrief → charDescFromFields", X.charDescFromFields(f), E.charDescFromFields(f), tag);
      // forceKind : Studio = fiche décidée par gemma puis bascule ; Engine = 3e paramètre (consigne = celle du Studio + phrase du type imposé)
      for (const kind of ["human", "other"]) {
        X.__ev.length = 0; S.__gcalls.length = 0; EC.__gcalls.length = 0; S.__gq.length = 0; EC.__gq.length = 0; S.__gq.push(r); EC.__gq.push(r); const evE = [];
        const sf0 = await X.characterSheetFromBrief(), decided = X.charKindOf(sf0);
        const poured = X.stripPromptPadding(X.charFieldKeys(sf0).filter(k => k !== "palette").map(k => X.fieldText(sf0[k])).filter(Boolean).join(", "));   // texte du type décidé, avant bascule
        const sf = X.toggleKind(sf0, kind), ef = await safe(() => E.characterSheetFromBrief(scene, (c, t, k) => evE.push([c, t, k]), kind));
        const summary = (fl, cs) => bad(fl) ? fl : [fl.kind, fl.label || "", cs(fl), X.charsheetPromptFrom(cs(fl), fl.kind, undefined)];
        const mixed = ["face", "hair", "outfit", "accessories"].some(k => X.fieldText(r[k])) && ["subject", "form", "surface", "details"].some(k => X.fieldText(r[k]));
        if (!mixed) same("characterSheetFromBrief (forceKind)", [summary(sf, X.charDescFromFields), X.__ev], [summary(ef, E.charDescFromFields), evE], `${kind} × ${tag}`);
        else {
          // DIFFÉRENCE DE FLUX VOULUE : réponse remplissant les DEUX jeux de champs. Chaque copie est vérifiée contre SA spécification.
          //  Studio : gemma décide SANS consigne, la bascule reverse toujours le texte du type décidé dans le 1er champ du jeu imposé.
          //  Engine : gemma reçoit la consigne « kind is force, fill only the force set » : son jeu imposé est lu directement.
          const G = "DIFFÉRENCE DE FLUX VOULUE — forceKind, deux jeux remplis";
          const forcedKeys = X.charFieldKeys({ kind }), forced = { kind, palette: X.fieldText(r.palette) };
          for (const k of forcedKeys) if (k !== "palette") forced[k] = X.fieldText(r[k]);
          const expE = X.charDescFromFields(forced);                                              // Engine : le jeu imposé, lu tel quel
          const expS = decided === kind ? expE : X.charDescFromFields({ kind, palette: forced.palette, [forcedKeys[0]]: poured });   // Studio : le texte décidé, reversé
          same(G + " : Engine lit le jeu imposé", bad(ef) ? ef : E.charDescFromFields(ef), expE, `${kind} × ${tag}`);
          same(G + " : Studio+bascule reverse le type décidé", X.charDescFromFields(sf), expS, `${kind} × ${tag}`);
          truth(G + " : flux différents ssi type décidé ≠ imposé", (X.charDescFromFields(sf) !== E.charDescFromFields(ef)) === (decided !== kind),
            `${kind} × ${tag} : décidé=${decided} ; Studio « ${X.charDescFromFields(sf)} » / Engine « ${bad(ef) ? "ERR" : E.charDescFromFields(ef)} »`);
          same(G + " : consigne Engine = Studio + phrase", [S.__gcalls[0][0] + FORCE_SUFFIX(kind), S.__gcalls[0][1]], EC.__gcalls[0], `${kind} × ${tag}`);
        }
        same("characterSheetFromBrief (forceKind : consigne + brief)", [S.__gcalls[0][0] + FORCE_SUFFIX(kind), S.__gcalls[0][1]], EC.__gcalls[0], `${kind} × ${tag}`);
        S.__gq.length = 0; EC.__gq.length = 0;
      }
    }
    const ef = await (async () => { EC.__gcalls.length = 0; EC.__gq.push(GEMMA17[1]); await E.characterSheetFromBrief(scene, null, "banane"); const s = EC.__gcalls[0][0]; EC.__gq.length = 0; return s; })();
    truth("characterSheetFromBrief (forceKind : valeur inconnue = comportement d'origine)", !ef.includes("The user has already decided"), "forceKind inconnu ajoute la phrase du type imposé");
    for (const r of [...LOCS.filter(Boolean), new Error("x"), { nope: 1 }])
      await runGemma("locationSheetFromBrief", () => X.locationSheetFromBrief(), cb => E.locationSheetFromBrief(scene, cb), r, `scène « ${scene.slice(0, 16)} »`);
  }
  // Liste de plans : alias de caméra/lumière, formes de liste, longueurs, repli statique
  const CAMS = ["wide", "close_up", "close up", "Close-Up", "CLOSEUP", "extreme close up", "very tight on the face", "macro", "face fill", "headshot", "head and shoulders", "tight on eyes",
    "medium", "waist up", "mid-shot", "cowboy shot", "extreme_wide", "extreme wide", "very wide", "establishing", "vista", "panorama", "aerial", "full length", "full body", "long shot",
    "pov", "point of view", "first person", "over the shoulder", "ots", "low angle", "worm's eye", "from below", "looking up", "upward", "high angle", "bird's eye", "overhead", "top-down",
    "from above", "looking down", "tracking", "dolly in", "follow", "steadicam", "alongside", "handheld", "hand-held", "shaky", "???", "", "  ", 3, null, { a: 1 }, ["wide"], UNI, "  WIDE  "];
  const LIGHTS = ["morning", "golden_hour", "golden hour", "sunset", "dusk", "sundown", "sunrise", "dawn", "overcast", "cloudy", "grey", "gray", "diffuse", "flat light", "moonlight", "moon", "starlight",
    "fire", "flame", "torch", "campfire", "ember", "firelight", "interior", "indoor", "lamp", "room", "candle", "studio", "softbox", "key light", "night", "dark", "nocturnal", "neon", "artificial",
    "???", "", 3, null, UNI, "  MORNING  "];
  const SHOTL = [];   // formes de liste
  const one = (c, l, a, e) => ({ camera: c, lighting: l, action: a, emotion: e });
  SHOTL.push(...CAMS.map((c, i) => [one(c, LIGHTS[i % LIGHTS.length], "walks", "calm")]), ...LIGHTS.map((l, i) => [one(CAMS[i % CAMS.length], l, "runs", "")]));
  SHOTL.push([one("wide", "morning", 3, 4), one("wide", "morning", undefined, undefined), one("wide", "morning", "", "")], [null, "x", 3, [], one("pov", "neon", "ok", "yes")], [], "nope", null, { shots: 1 },
    Array.from({ length: 12 }, (_, i) => one(CAMS[i], LIGHTS[i], "action " + i, "e" + i)), [one("wide", "morning", UNI, LONG)]);
  const N_VALUES = [1, 2, 3, 5, 8, 9, 12];
  for (const n of N_VALUES) for (const segDur of [1, 2, 8]) for (const scene of ["A lion crosses the savanna at dawn.", "", UNI]) {
    X.brief.value = scene; X.__dom.videoDuration.value = String(segDur);
    for (const [i, list] of SHOTL.entries()) await runGemma("shotListFromBrief (normalizeShotList, alias caméra/lumière)", () => X.shotListFromBrief(n), cb => E.shotListFromBrief(scene, n, segDur, cb), { shots: list }, `liste #${i} n=${n} durée=${segDur}`);
    for (const r of [{ nope: 1 }, new Error("x")]) await runGemma("shotListFromBrief (repli statique fallbackShots)", () => X.shotListFromBrief(n), cb => E.shotListFromBrief(scene, n, segDur, cb), r, `n=${n} durée=${segDur}`);
  }
  for (const v of ["", "0", "abc", "12", "3.7", "-4"]) {   // durée de plan bornée 1…8, défaut 2 (valeurs du champ #videoDuration)
    X.brief.value = "A lion."; X.__dom.videoDuration.value = v;
    const segDur = Math.min(8, Math.max(1, parseInt(v, 10) || 2));
    await runGemma("shotListFromBrief (durée de plan lue au champ)", () => X.shotListFromBrief(2), cb => E.shotListFromBrief("A lion.", 2, segDur, cb), { shots: [] }, `#videoDuration = « ${v} »`);
  }
  X.__dom.videoDuration.value = "2";
  { X.brief.value = "s"; EC.__gcalls.length = 0; EC.__gq.push({ shots: [] }); await E.shotListFromBrief("s", 3, 2); const sys = EC.__gcalls[0][0]; EC.__gq.length = 0;
    has("shotListFromBrief (absence/présence)", sys, "costume", false); has("shotListFromBrief (absence/présence)", sys, "exactly one person", false); has("shotListFromBrief (absence/présence)", sys, "exactly one subject in frame", true);
    EC.__gcalls.length = 0; EC.__gq.push(GEMMA17[0]); await E.characterSheetFromBrief("s"); const cs = EC.__gcalls[0][0]; EC.__gq.length = 0;
    has("characterSheetFromBrief (absence/présence)", cs, '"kind"', true); has("characterSheetFromBrief (absence/présence)", cs, "take the SINGLE most prominent character and describe them", false); }
}

(async () => {
  pass = { ref: true, list: [] }; await matrix(XR, SR); const refList = pass.list;
  pass = { ref: false, list: [] }; await matrix(SC.S, SC); const curList = pass.list;
  if (refList.length !== curList.length || refList.some((r, i) => r.g !== curList[i].g))
    die(`les deux passes n'ont pas rejoué la même matrice (${refList.length} cas pour la référence, ${curList.length} pour le Studio actuel) : test à corriger`);
  refList.forEach((r, i) => {
    const c = curList[i];
    G(`${RE_E} · ${r.g}`).bytes += Buffer.byteLength(r.a.s); G(`${RE_S} · ${r.g}`).bytes += Buffer.byteLength(r.a.s); G(`${S_E} · ${r.g}`).bytes += Buffer.byteLength(c.a.s);
    record(`${RE_E} · ${r.g}`, !r.a.bad && !r.b.bad && r.a.s === r.b.s, { input: r.input, a: r.a.s, b: r.b.s, lA: "référence", lB: "Engine" });
    const sameA = r.a.s === c.a.s;   // côté Studio d'abord ; sinon l'attendu (côté Engine) des deux passes
    record(`${RE_S} · ${r.g}`, !r.a.bad && !c.a.bad && !r.b.bad && !c.b.bad && sameA && r.b.s === c.b.s,
      sameA ? { input: r.input + " (côté Engine des deux passes)", a: r.b.s, b: c.b.s, lA: "référence", lB: "Studio actuel" } : { input: r.input, a: r.a.s, b: c.a.s, lA: "référence", lB: "Studio actuel" });
    record(`${S_E} · ${r.g}`, !c.a.bad && !c.b.bad && c.a.s === c.b.s, { input: c.input, a: c.a.s, b: c.b.s, lA: "Studio actuel", lB: "Engine" });
  });

  // ── rapport ──
  let n = 0, failedGroups = 0;
  const trunc = (s, w) => s.length > w ? s.slice(0, w) + "…" : s;
  const show = s => s.replace(/\n/g, "⏎");
  for (const [k, r] of Object.entries(res)) {
    n += r.n; const ok = r.ok === r.n && r.n > 0; if (!ok) failedGroups++;
    console.log(`${ok ? "PASS" : "FAIL"} ${k.padEnd(96)} ${r.ok}/${r.n}${r.bytes ? ` · ${r.bytes} octets` : ""}`);
    if (!ok && r.n === 0) console.log("     groupe vide (0 contrôle) : test vacant");
    if (r.first && (!ok || VERBOSE)) {
      const { input, a, b, lA = "Studio", lB = "Engine" } = r.first; let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      const w = VERBOSE ? 200 : 60, win = s => show(s.slice(Math.max(0, i - w), i + w)), pad = Math.max(lA.length, lB.length);
      console.log(`     1er écart — entrée : ${input ?? "(constante)"}`);
      if (b === "" && a !== "") console.log(`     Studio : ${show(trunc(a, w * 3))}`);
      else { console.log(`     à l'octet ${i} (ligne ${a.slice(0, i).split("\n").length}) ; longueurs ${lA} ${a.length} / ${lB} ${b.length}`);
             console.log(`     ${lA.padEnd(pad)} : …${win(a)}…\n     ${lB.padEnd(pad)} : …${win(b)}…`); }
    }
  }
  const nv = violations.length;
  if (nv) { console.log(`     appels réseau imprévus (${nv}) :`); violations.slice(0, 5).forEach(v => console.log("       " + v)); }
  console.log(`\nréférence     = ${REF.path}\nStudio actuel = ${IDX_PATH}\nengine        = ${ENG_PATH}`);
  console.log(`${n} contrôles · ${Object.keys(res).length} groupes · ${refList.length} cas × 3 voies · Object.keys(Engine).length = ${Object.keys(E).length} · violations réseau = ${nv}`);
  const failed = fails || nv || failedGroups;
  console.log(failed ? `${fails} ÉCHEC(S)${nv ? `, ${nv} violation(s) réseau` : ""}` : "TOUT PASSE");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
