// nodes-simple.js — Lot 2 : 3 types de nœuds litegraph pour la chaîne "simple"
// (Krea 2 text2image → Qwen-Edit 2509 édition → Vidéo LTX 2.5 / Minimax H3).
//
// Convention reprise du Lot 1 (canvas.html) : fonction constructeur + prototype,
// `LiteGraph.registerNodeType`, overlay DOM réutilisant EXACTEMENT le même mécanisme
// que `MediaNode` (this.overlay / this.mediaEl, buildOverlay(), syncOverlays() de
// canvas.html qui boucle sur `node.overlay` — rien de neuf à câbler côté canvas.html
// pour l'affichage média).
//
// Réseau : passe exclusivement par window.Engine (js/engine.js) — buildGraph,
// getTemplate, addKrea2Shared/addKrea2Shot, submitGraph, waitForJobs, outputFiles,
// uploadBlob, reupload, viewURL — mêmes chemins/paramètres que index.html.
//
// Chargement : <script src="js/nodes-simple.js"></script> après engine.js et après
// la création de `mediaLayer` (le script lit `document.getElementById("mediaLayer")`
// lui-même, il ne dépend d'aucune variable globale de canvas.html).
(function () {
  "use strict";
  const E = window.Engine;
  const mediaLayer = document.getElementById("mediaLayer");
  const clientId = E.clientId;   // partagé avec engine.js/nodes-advanced.js : c'est le clientId
  // de LA connexion WebSocket de progression, un id local ne recevrait aucun message.
  // i18n : `tr()` est définie dans canvas.html, dont le <script> est chargé APRÈS ce
  // fichier. On la résout donc au moment de l'appel (jamais au chargement) — d'où ce
  // petit passe-plat, qui retombe sur le texte source français si elle n'existe pas.
  const T = k => (window.tr ? window.tr(k) : k);

  // ── États visuels communs (idle / running / error / done) ────────────────
  // this.status ∈ "idle" | "running" | "error" | "done" ; this.statusMsg = texte court.
  // Rendu simple : couleur du titre du nœud (this.color/this.boxcolor, lus par litegraph
  // à chaque frame) + libellé du bouton "Générer" + ligne de texte dessinée sous le titre.
  const STATUS_COLOR = { idle: "#666", running: "#c98a1b", error: "#a33", done: "#2a7d2a" };
  function setStatus(node, status, msg) {
    node.status = status;
    node.statusMsg = msg || "";
    node.boxcolor = STATUS_COLOR[status] || STATUS_COLOR.idle;
    node.color = node.boxcolor;
    // Hors "running", plus de barre : un état atteint sans passer par le WebSocket
    // (erreur locale avant envoi) laisserait sinon une barre figée à moitié pleine.
    if (status !== "running") node.progress = null;
    node.setDirtyCanvas(true, true);
  }
  // Dessine le statut sous le titre du nœud (au-dessus du corps/overlay).
  function drawStatus(node, ctx) {
    if (!node.statusMsg) return;
    ctx.fillStyle = STATUS_COLOR[node.status] || "#999";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(node.statusMsg.slice(0, 60), 6, 12);
    // Barre de progression alimentée par le WebSocket ComfyUI (Engine.registerJob),
    // juste sous la ligne de statut — pas de zone nouvelle, rien qui chevauche l'overlay.
    if (node.status === "running" && typeof node.progress === "number") {
      const w = Math.max(0, node.size[0] - 12);
      const pct = Math.max(0, Math.min(100, node.progress));
      ctx.fillStyle = STATUS_COLOR.running;
      ctx.fillRect(6, 16, w * pct / 100, 3);
    }
  }

  // Résout la sortie amont d'un nœud connecté sur l'entrée `slot` (0). Convention :
  // un nœud amont "résolu" porte `properties.outFile` = {filename, subfolder, type}
  // (fichier ComfyUI réel) posé une fois son propre job terminé. Retourne null sinon.
  function upstreamFile(node, slot) {
    const link = node.getInputLink ? node.getInputLink(slot) : null;
    if (!link) return null;
    const origin = node.graph.getNodeById(link.origin_id);
    if (!origin || !origin.properties || !origin.properties.outFile) return null;
    return origin.properties.outFile;
  }

  // Overlay DOM (image ou vidéo jouable) — copie conforme de MediaNode.buildOverlay.
  function buildOverlay(node) {
    if (node.overlay) node.overlay.remove();
    const box = document.createElement("div");
    box.className = "media-overlay";
    box.dataset.nodeId = String(node.id);
    const src = node.properties.src || "";
    // src est une URL ComfyUI `/comfy/view?filename=...&subfolder=...&type=...` : le nom de
    // fichier (et son extension) est dans la query string, pas dans le path — on ne peut donc
    // pas tester l'extension sur l'URL elle-même. On teste `outFile.filename` (posé par
    // generate()) en priorité, avec un repli sur l'URL brute pour les nœuds média du Lot 1
    // (media/preview, qui pointent vers un simple chemin "assets/test-video.mp4" sans query).
    const isVideoName = f => /\.(mp4|webm|mov)$/i.test(f || "");
    let el;
    if (isVideoName(node.properties.outFile && node.properties.outFile.filename) || isVideoName(src)) {
      el = document.createElement("video");
      el.src = src; el.controls = true; el.loop = true; el.playsInline = true; el.preload = "metadata";
    } else {
      el = document.createElement("img");
      el.src = src; el.alt = "";
    }
    box.appendChild(el);
    mediaLayer.appendChild(box);
    node.overlay = box;
    node.mediaEl = el;
  }
  function removeOverlay(node) {
    if (node.overlay) { node.overlay.remove(); node.overlay = null; }
  }
  function drawEmptyBody(node, ctx) {
    if (node.flags.collapsed) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, node.size[0], node.size[1]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1) Krea 2 — texte → image
  // ═══════════════════════════════════════════════════════════════════════
  function Krea2Node() {
    this.addOutput("image", 0);
    // `ratio` + `mp` (mégapixels) pilotent désormais la résolution via
    // Engine.computeMPResolution — unité TOUJOURS 32, cette carte n'a pas de champ "engine"
    // (même raisonnement que Ref2VideoNode, nodes-advanced.js) ; `mp` défaut "1.0", cohérent
    // avec le défaut déjà utilisé sur les cartes vidéo. `lora` défaut "" = aucune LoRA, graphe
    // strictement inchangé (cf. addKrea2Shared).
    this.properties = { prompt: "a cinematic photo of a lighthouse at sunset", ratio: "1:1", mp: "1", lora: "", src: "", outFile: null };
    this.addWidget("text", "prompt", this.properties.prompt, v => { this.properties.prompt = v; });
    this.addWidget("combo", "ratio", this.properties.ratio, v => { this.properties.ratio = v; },
      { values: Object.keys(RATIOS) });
    this.addWidget("combo", "mégapixels", this.properties.mp, v => { this.properties.mp = v; },
      { values: E.MP_VALUES });
    this.addWidget("combo", "style (LoRA)", this.properties.lora, v => { this.properties.lora = v; },
      // Fonction, pas tableau figé : litegraph relit `options.values()` à chaque ouverture
      // du combo, donc la liste suit E.KREA2_LORAS même peuplée après coup par le fetch
      // réseau de js/engine.js (fetchLoraOptions).
      { values: () => E.KREA2_LORAS.map(l => l[0]) });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this.size = [320, 240];
    setStatus(this, "idle", "");
  }
  Krea2Node.title = "Krea 2 (texte→image)";
  Krea2Node.prototype.onAdded = function () { buildOverlay(this); };
  Krea2Node.prototype.onRemoved = function () { removeOverlay(this); };
  Krea2Node.prototype.onConfigure = function () { buildOverlay(this); setStatus(this, this.status || "idle", this.statusMsg || ""); };
  Krea2Node.prototype.buildOverlay = function () { buildOverlay(this); };
  Krea2Node.prototype.onDrawBackground = function (ctx) { drawEmptyBody(this, ctx); drawStatus(this, ctx); };

  Krea2Node.prototype.generate = async function () {
    const prompt = (this.properties.prompt || "").trim();
    if (!prompt) { setStatus(this, "error", T("Erreur : prompt vide.")); return; }
    setStatus(this, "running", T("Génération Krea 2 en cours…"));
    try {
      const { g, add } = E.makeGraphBuilder();
      // Unité TOUJOURS 32 : cette carte n'a pas de champ "engine", jamais LTX 2.5 ici (même
      // raisonnement que Ref2VideoNode.generate, nodes-advanced.js).
      const [width, height] = E.computeMPResolution(parseFloat(this.properties.mp), this.properties.ratio, 32);
      const kx = E.addKrea2Shared(add, this.properties.lora);
      const dec = E.addKrea2Shot(add, kx, prompt, Math.floor(Math.random() * 1e15), width, height, 1);
      add("SaveImage", { images: [dec, 0], filename_prefix: "canvas/krea2" });
      const promptId = await E.submitGraph(g, "Canvas · Krea 2", `Krea 2 · seed`, clientId);
      E.registerJob(promptId, this);
      const entries = await E.waitForJobs([promptId]);
      const file = E.outputFiles(entries[promptId], ".png")[0];
      if (!file) throw new Error(T("aucune image en sortie"));
      this.properties.outFile = file;
      this.properties.src = E.viewURL(file);
      buildOverlay(this);
      this.save && this.save();
      setStatus(this, "done", T("Terminé : ") + file.filename);
    } catch (e) {
      setStatus(this, "error", T("Erreur : ") + e.message);
    }
    if (window.__canvas) window.__canvas.save();
  };
  LiteGraph.registerNodeType("simple/krea2", Krea2Node);

  // ═══════════════════════════════════════════════════════════════════════
  // 2) Qwen-Edit 2509 — édition/localisation d'image
  // ═══════════════════════════════════════════════════════════════════════
  function QwenEditNode() {
    this.addInput("image", 0);
    this.addOutput("image", 0);
    this.properties = { instruction: "add sunglasses on the character", src: "", outFile: null };
    this.addWidget("text", "instruction", this.properties.instruction, v => { this.properties.instruction = v; });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this.size = [320, 240];
    setStatus(this, "idle", "");
  }
  QwenEditNode.title = "Qwen-Edit 2509 (édition)";
  QwenEditNode.prototype.onAdded = function () { buildOverlay(this); };
  QwenEditNode.prototype.onRemoved = function () { removeOverlay(this); };
  QwenEditNode.prototype.onConfigure = function () { buildOverlay(this); setStatus(this, this.status || "idle", this.statusMsg || ""); };
  QwenEditNode.prototype.buildOverlay = function () { buildOverlay(this); };
  QwenEditNode.prototype.onDrawBackground = function (ctx) { drawEmptyBody(this, ctx); drawStatus(this, ctx); };

  QwenEditNode.prototype.generate = async function () {
    const upstream = upstreamFile(this, 0);
    if (!upstream) {
      // Gating : input amont non résolu → AUCUN appel réseau, erreur visible sur le nœud.
      setStatus(this, "error", T("Erreur : image d'entrée non résolue (connecte un nœud terminé)."));
      return;
    }
    const instruction = (this.properties.instruction || "").trim();
    if (!instruction) { setStatus(this, "error", T("Erreur : instruction vide.")); return; }
    setStatus(this, "running", T("Édition Qwen-Edit en cours…"));
    try {
      const q = `filename=${encodeURIComponent(upstream.filename)}&subfolder=${encodeURIComponent(upstream.subfolder || "")}&type=${upstream.type || "output"}`;
      const blob = await (await fetch(`${E.COMFY}/view?${q}`)).blob();
      const imgName = await E.uploadBlob(blob, upstream.filename.split("/").pop());
      const raw = await E.getTemplate("api/qwen_edit_i2i.json");
      const graph = E.buildGraph(raw, {
        prompt: instruction, negative: "", seed: Math.floor(Math.random() * 1e15),
        width: 1024, height: 1024, batch: 1, image: imgName
      });
      for (const n of Object.values(graph)) if (n.class_type === "SaveImage") n.inputs.filename_prefix = "canvas/qwen_edit";
      const promptId = await E.submitGraph(graph, "Canvas · Qwen-Edit", "Qwen-Edit 2509", clientId);
      E.registerJob(promptId, this);
      const entries = await E.waitForJobs([promptId]);
      const file = E.outputFiles(entries[promptId], ".png")[0];
      if (!file) throw new Error(T("aucune image en sortie"));
      this.properties.outFile = file;
      this.properties.src = E.viewURL(file);
      buildOverlay(this);
      setStatus(this, "done", T("Terminé : ") + file.filename);
    } catch (e) {
      setStatus(this, "error", T("Erreur : ") + e.message);
    }
    if (window.__canvas) window.__canvas.save();
  };
  LiteGraph.registerNodeType("simple/qwen_edit", QwenEditNode);

  // ═══════════════════════════════════════════════════════════════════════
  // 3) Vidéo — LTX 2.5 ou Minimax H3 (image → vidéo), au choix via dropdown
  // ═══════════════════════════════════════════════════════════════════════
  const RATIOS = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1024, 1024], "4:5": [832, 1040] };
  function VideoNode() {
    this.addInput("image", 0);
    this.addOutput("video", 0);
    // `prompt` porte EXACTEMENT le texte qui était codé en dur avant ce lot : tant que
    // l'utilisateur n'y touche pas, le graphe produit est inchangé. `negative` était lui
    // aussi figé à "" ; le champ le rend simplement éditable. Il n'a d'effet que sur LTX 2.5
    // (seul template à porter un {{NEGATIVE_PROMPT}} réellement encodé) — sur Minimax H3 le
    // placeholder est absent du template, la substitution est donc un no-op sans danger.
    // `mp`/`lora` : mégapixels (résolution, cf. Engine.computeMPResolution) et LoRA de style
    // Minimax H3 (cf. Engine.H3_STYLE_LORAS/addH3StyleLora) — tous deux ajoutés à ce lot.
    this.properties = { engine: "ltx25", ratio: "16:9", mp: "1", duration: 5, turbo: true, steps: 8, lora: "",
      prompt: "The scene continues with natural motion.", negative: "", src: "", outFile: null };
    this.addWidget("combo", "moteur", this.properties.engine, v => { this.properties.engine = v; },
      { values: ["ltx25", "minimax_h3"] });
    this.addWidget("combo", "ratio", this.properties.ratio, v => { this.properties.ratio = v; },
      { values: Object.keys(RATIOS) });
    this.addWidget("combo", "mégapixels", this.properties.mp, v => { this.properties.mp = v; },
      { values: E.MP_VALUES });
    this.addWidget("number", "durée (s)", this.properties.duration, v => { this.properties.duration = Math.min(10, Math.max(1, Math.round(v))); },
      { min: 1, max: 10, step: 1 });
    // turbo + steps + style (LoRA) ne servent QUE pour engine === "minimax_h3" (LTX 2.5 n'a
    // structurellement aucun LoraLoaderModelOnly dans ses templates). Les widgets litegraph
    // natifs ci-dessous restent inconditionnels (jamais peints/cliquables, drawNodeWidgets
    // neutralisé — cf. canvas.html) ; c'est le VRAI panneau utilisateur (CARDS/showProps de
    // canvas.html) qui applique la visibilité conditionnelle, via
    // `when: n => n.properties.engine === "minimax_h3"` sur ces 3 champs.
    this.addWidget("toggle", "turbo (LoRA)", this.properties.turbo, v => { this.properties.turbo = !!v; });
    this.addWidget("combo", "steps", this.properties.steps, v => { this.properties.steps = Number(v); },
      { values: [4, 6, 8] });
    this.addWidget("combo", "style H3 (LoRA)", this.properties.lora, v => { this.properties.lora = v; },
      { values: () => E.H3_STYLE_LORAS.map(l => l[0]) });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this.size = [340, 260];
    setStatus(this, "idle", "");
  }
  VideoNode.title = "Vidéo (LTX 2.5 / Minimax H3)";
  VideoNode.prototype.onAdded = function () { buildOverlay(this); };
  VideoNode.prototype.onRemoved = function () { removeOverlay(this); };
  VideoNode.prototype.onConfigure = function () { buildOverlay(this); setStatus(this, this.status || "idle", this.statusMsg || ""); };
  VideoNode.prototype.buildOverlay = function () { buildOverlay(this); };
  VideoNode.prototype.onDrawBackground = function (ctx) { drawEmptyBody(this, ctx); drawStatus(this, ctx); };

  VideoNode.prototype.generate = async function () {
    const upstream = upstreamFile(this, 0);
    if (!upstream) {
      // Gating : mêmes règles que Qwen-Edit — pas d'input résolu, pas d'appel réseau.
      setStatus(this, "error", T("Erreur : image d'entrée non résolue (connecte un nœud terminé)."));
      return;
    }
    setStatus(this, "running", `${T("Génération vidéo")} (${this.properties.engine}) ${T("en cours…")}`);
    try {
      const q = `filename=${encodeURIComponent(upstream.filename)}&subfolder=${encodeURIComponent(upstream.subfolder || "")}&type=${upstream.type || "output"}`;
      const blob = await (await fetch(`${E.COMFY}/view?${q}`)).blob();
      const imgName = await E.uploadBlob(blob, upstream.filename.split("/").pop());
      const unit = E.mpUnitForEngine(this.properties.engine);
      const [width, height] = E.computeMPResolution(parseFloat(this.properties.mp), this.properties.ratio, unit);
      const templateFile = this.properties.engine === "minimax_h3" ? "api/minimax_h3_i2v.json" : "api/ltx25_i2v.json";
      const raw = await E.getTemplate(templateFile);
      const graph = E.buildGraph(raw, {
        prompt: this.properties.prompt, negative: this.properties.negative,
        seed: Math.floor(Math.random() * 1e15), width, height, batch: 1,
        duration: this.properties.duration, image: imgName
      });
      // AVANT ce lot, VideoNode n'appelait PAS applyMinimaxTurbo : le template
      // api/minimax_h3_i2v.json partait tel quel (ancienne LoRA turbo + steps 8 en dur),
      // sans aucun moyen de choisir turbo/steps. C'est corrigé ici.
      let stepLabel = "";
      if (this.properties.engine === "minimax_h3") {
        E.applyMinimaxTurbo(graph, this.properties.turbo, this.properties.steps);
        const st = Number(this.properties.steps);
        stepLabel = this.properties.turbo
          ? ` · turbo ${st} steps${st === 4 ? " (fl2v v1.2)" : ""}`
          : " · 20 steps";
        // Cumul turbo + style — ORDRE OBLIGATOIRE : addH3StyleLora doit toujours suivre
        // applyMinimaxTurbo, jamais le précéder (cf. commentaire d'addH3StyleLora dans
        // engine.js — applyMinimaxTurbo retrouve sa LoRA turbo par class_type, un appel
        // inversé la confondrait avec la LoRA de style). `lora` vide ⇒ no-op strict.
        if (this.properties.lora) E.addH3StyleLora(graph, this.properties.lora);
      }
      for (const n of Object.values(graph)) if (n.class_type === "SaveVideo") n.inputs.filename_prefix = "canvas/video";
      this._lastGraph = graph;   // graphe RÉELLEMENT soumis (hors properties : non sérialisé)
      const promptId = await E.submitGraph(graph, "Canvas · Vidéo", `${this.properties.engine} · ${this.properties.duration}s${stepLabel}`, clientId);
      E.registerJob(promptId, this);
      this.properties.promptId = promptId;
      const entries = await E.waitForJobs([promptId]);
      const file = E.outputFiles(entries[promptId], ".mp4")[0];
      if (!file) throw new Error(T("aucune vidéo en sortie"));
      this.properties.outFile = file;
      this.properties.src = E.viewURL(file);
      buildOverlay(this);
      setStatus(this, "done", T("Terminé : ") + file.filename);
    } catch (e) {
      setStatus(this, "error", T("Erreur : ") + e.message);
    }
    if (window.__canvas) window.__canvas.save();
  };
  LiteGraph.registerNodeType("simple/video", VideoNode);

  // ═══════════════════════════════════════════════════════════════════════
  // 4) Import média — fichier LOCAL (image ou vidéo) rendu connectable
  // ═══════════════════════════════════════════════════════════════════════
  // Contrat de sortie IDENTIQUE aux cartes de génération : l'aval lit
  // `properties.outFile` = {filename, subfolder, type} via upstreamFile(). Une URL blob
  // locale ne suffirait donc pas — le fichier est UPLOADÉ dans l'input ComfyUI par
  // E.uploadBlob (exactement le mécanisme de Ref2VideoNode.addRefAudio), et outFile porte
  // `type: "input"` : les cartes aval relisent le fichier via /view?…&type=input avant de
  // le ré-uploader, comme elles le font déjà pour une sortie de job (type "output").
  // Pas d'entrée : c'est une source. `kind` ("image"|"video") ne sert qu'au filtre du
  // sélecteur de fichier ; l'overlay, lui, se décide sur l'extension du fichier importé.
  function ImportNode() {
    this.addOutput("out", 0);
    this.properties = { kind: "image", filename: "", src: "", outFile: null };
    this.size = [320, 240];
    setStatus(this, "idle", "");
  }
  ImportNode.title = "Import média";
  ImportNode.prototype.onAdded = function () { buildOverlay(this); };
  ImportNode.prototype.onRemoved = function () { removeOverlay(this); };
  ImportNode.prototype.onConfigure = function () { buildOverlay(this); setStatus(this, this.status || "idle", this.statusMsg || ""); };
  ImportNode.prototype.buildOverlay = function () { buildOverlay(this); };
  ImportNode.prototype.onDrawBackground = function (ctx) { drawEmptyBody(this, ctx); drawStatus(this, ctx); };

  // Appelée depuis le panneau de propriétés de canvas.html (champ « Fichier local ») :
  // les widgets litegraph n'y sont ni peints ni cliquables (drawNodeWidgets neutralisé).
  ImportNode.prototype.importFile = async function (file) {
    setStatus(this, "running", T("Upload du fichier…"));
    try {
      const name = await E.uploadBlob(file, file.name);
      this.properties.outFile = { filename: name, subfolder: "", type: "input" };
      this.properties.filename = name;
      this.properties.src = E.viewURL(this.properties.outFile);
      buildOverlay(this);
      setStatus(this, "done", T("Importé : ") + name);
    } catch (e) {
      setStatus(this, "error", T("Erreur : ") + e.message);
    }
    if (window.__canvas) window.__canvas.save();
  };
  LiteGraph.registerNodeType("simple/import", ImportNode);

  // Accès pour les tests automatisés.
  window.__simpleNodes = { Krea2Node, QwenEditNode, VideoNode, ImportNode, upstreamFile, RATIOS };
})();
