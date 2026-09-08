// nodes-advanced.js — Lot 3 : les nœuds litegraph du pipeline storyboard_v2 /
// reference2video, en cartes connectées.
//
//   [Fiche personnage] ─┐                     ┌─→ [Storyboard] ─→ [Vidéo finale (animatic)]
//                       ├─(charsheet+locsheet)┤
//   [Fiche décor] ──────┘                     └─→ [Reference2Video (Minimax H3 r2v)]
//
// Conventions : STRICTEMENT celles du Lot 1 (canvas.html) et du Lot 2 (js/nodes-simple.js) —
// fonction constructeur + prototype, `LiteGraph.registerNodeType`, états
// idle/running/error/done (couleur de titre + ligne de statut), overlay DOM
// `this.overlay`/`this.mediaEl` repris par `syncOverlays()` de canvas.html.
// Les helpers setStatus/drawStatus/buildOverlay sont recopiés à l'identique depuis
// nodes-simple.js : ils y sont privés (non exportés) et le Lot 2 est intouchable.
// `upstreamFile` est en revanche RÉUTILISÉ tel quel via `window.__simpleNodes`.
//
// Logique métier : AUCUNE réimplémentation. Tout passe par window.Engine (js/engine.js) —
// characterSheetFromBrief / locationSheetFromBrief / shotListFromBrief / submitCharsheetJob /
// submitLocsheetJob / submitKeyframeJob / submitGridJob / submitCutJob / submitAnimaticJob,
// dans l'ordre exact de `Engine.generateStoryboardV2`, et buildGraph+applyMinimaxTurbo dans
// l'ordre exact de `Engine.generateReference2Video`.
//
// Pourquoi les fonctions unitaires et pas `generateStoryboardV2()` en bloc : cette fonction
// génère elle-même ses deux planches (submitCharsheetJob + submitLocsheetJob) au début. Or ici
// les planches sont DEUX CARTES AMONT, déjà rendues et connectées — les régénérer à l'intérieur
// du nœud Storyboard rendrait les connexions décoratives. On appelle donc la queue de
// `generateStoryboardV2` (étapes c → f) telle quelle, sans en changer ni l'ordre ni les prompts.
(function () {
  "use strict";
  const E = window.Engine;
  const upstreamFile = window.__simpleNodes.upstreamFile;  // Lot 2, réutilisé tel quel
  const mediaLayer = document.getElementById("mediaLayer");
  const clientId = E.clientId;   // partagé avec engine.js/nodes-simple.js : c'est le clientId
  // de LA connexion WebSocket de progression, un id local ne recevrait aucun message.
  const MODEL_LABEL = "Krea 2 / Qwen-Edit / LTX 2.5";
  // i18n : `tr()` est définie dans canvas.html, dont le <script> est chargé APRÈS ce
  // fichier. On la résout donc au moment de l'appel (jamais au chargement) — d'où ce
  // petit passe-plat, qui retombe sur le texte source français si elle n'existe pas.
  const T = k => (window.tr ? window.tr(k) : k);

  // ── Helpers d'état + overlay (copie conforme de nodes-simple.js, privés là-bas) ─────
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
  function buildOverlay(node) {
    if (node.overlay) node.overlay.remove();
    const box = document.createElement("div");
    box.className = "media-overlay";
    box.dataset.nodeId = String(node.id);
    const src = node.properties.src || "";
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
  // Câblage des 6 hooks litegraph, identique pour les 5 nœuds de ce fichier.
  function wireCommon(Ctor) {
    Ctor.prototype.onAdded = function () { buildOverlay(this); };
    Ctor.prototype.onRemoved = function () { removeOverlay(this); };
    Ctor.prototype.onConfigure = function () { buildOverlay(this); setStatus(this, this.status || "idle", this.statusMsg || ""); };
    Ctor.prototype.buildOverlay = function () { buildOverlay(this); };
    Ctor.prototype.onDrawBackground = function (ctx) { drawEmptyBody(this, ctx); drawStatus(this, ctx); };
  }
  // Nœud amont connecté sur `slot` (upstreamFile ne rend que le fichier ; le storyboard a
  // aussi besoin des descriptions charDesc/locDesc portées par le nœud amont).
  function upstreamNode(node, slot) {
    const link = node.getInputLink ? node.getInputLink(slot) : null;
    return link ? node.graph.getNodeById(link.origin_id) : null;
  }
  function finish(node) { if (window.__canvas) window.__canvas.save(); }

  // ── Lot 5 : slots d'entrée dynamiques (AUTOGROW) ─────────────────────────────────
  // SEULE mécanique de croissance du canvas : un « groupe » de slots (identifié par son
  // NOM) porte TOUJOURS exactement un slot libre tant que son plafond n'est pas atteint.
  // Connecter le slot libre en fait apparaître un nouveau ; déconnecter résorbe les
  // surnuméraires. Pas de bouton « + ajouter une entrée », pas de dialogue.
  //
  // Les slots d'un groupe sont ajoutés en FIN de `this.inputs` et repérés par leur nom,
  // jamais par leur index : aucun index de slot déjà en place ne bouge, donc aucun lien
  // existant n'est cassé. `removeInput` de litegraph réindexe lui-même les liens des slots
  // suivants, et on ne retire de toute façon que des slots LIBRES.
  const SLOT_IMG_REF = "image ref +";   // ref_images.ref_image_2..8  (plafond ComfyUI : 9 au total)
  const SLOT_VID_REF = "vidéo ref +";   // ref_videos.ref_video_0..2  (plafond ComfyUI : 3)
  const SLOT_SHEET_REF = "fiche +";     // image3 de TextEncodeQwenImageEditPlus (plafond DUR : 3 fiches)
  const MAX_EXTRA_IMAGES = 7;           // 9 (plafond ref_images) − 2 planches fixes
  const MAX_REF_VIDEOS = 3;
  const MAX_REF_AUDIOS = 3;
  const MAX_EXTRA_SHEETS = 1;           // 2 fiches fixes + 1 = 3, limite DURE de TextEncodeQwenImageEditPlus

  // Hauteur de carte : litegraph empile les slots par rangs de 20 px sous le titre. Une
  // carte à 12 entrées doit rester assez haute pour tous les afficher au-dessus de la
  // vignette (et pour que canvas.html puisse décaler l'overlay d'autant).
  function autoHeight(node) {
    const rows = Math.max((node.inputs || []).length, (node.outputs || []).length);
    node.size[1] = Math.max(node._baseH || 300, 20 * rows + 4 + 160);
    node.setDirtyCanvas(true, true);
  }
  function slotIndexes(node, name) {
    const out = [];
    (node.inputs || []).forEach((s, i) => { if (s.name === name) out.push(i); });
    return out;
  }
  // Indices des slots CONNECTÉS d'un groupe, dans l'ordre des slots.
  function connectedSlots(node, name) {
    return slotIndexes(node, name).filter(i => node.inputs[i].link != null);
  }
  function growSlots(node, name, cap) {
    const free = slotIndexes(node, name).filter(i => node.inputs[i].link == null);
    for (let k = free.length - 1; k >= 1; k--) node.removeInput(free[k]);   // un seul slot libre
    const all = slotIndexes(node, name);
    if (all.length < cap && all.every(i => node.inputs[i].link != null)) {
      node.addInput(name, 0);
      node.inputs[node.inputs.length - 1].label = "";   // libellés de slots masqués (reskin canvas.html)
    }
  }
  // `removeInput` déclenche `disconnectInput` → `onConnectionsChange` : garde anti-réentrance.
  function autogrow(node, groups) {
    if (node._growing) return;
    node._growing = true;
    try { for (const [name, cap] of groups) growSlots(node, name, cap); } finally { node._growing = false; }
    autoHeight(node);
  }
  // Câble le hook litegraph de changement de connexion sur un type à slots dynamiques.
  function wireAutogrow(Ctor, groups) {
    const baseConfigure = Ctor.prototype.onConfigure;
    Ctor.prototype.onConnectionsChange = function (type) {
      if (type !== LiteGraph.INPUT) return;
      autogrow(this, groups);
      finish(this);
    };
    Ctor.prototype.onConfigure = function () {
      baseConfigure.call(this);
      autogrow(this, groups);   // graphe restauré du localStorage : on rétablit le slot libre
    };
  }
  // Fichier de sortie d'un nœud amont connecté sur un slot de groupe, ré-uploadé en entrée
  // ComfyUI (E.reupload — exactement ce que font déjà charsheet/locsheet). Les références
  // additionnelles sont OPTIONNELLES : un slot connecté à un nœud non encore résolu est
  // simplement ignoré, il ne bloque rien.
  async function refNamesFor(node, name) {
    const names = [];
    for (const i of connectedSlots(node, name)) {
      const f = upstreamFile(node, i);
      if (f) names.push((await E.reupload(f)).name);
    }
    return names;
  }
  const styleIds = () => Object.keys(E.STYLE_PACKS);
  // Fonctions (pas des tableaux figés) : litegraph relit `options.values()` à chaque
  // ouverture du combo (cf. litegraph.js, case "combo" du pointerdown), donc la liste
  // reflète l'état courant de E.KREA2_LORAS/E.H3_STYLE_LORAS même si le fetch réseau qui
  // les peuple (js/engine.js, fetchLoraOptions) se termine après la construction du nœud.
  const loraIds = () => E.KREA2_LORAS.map(l => l[0]);
  const h3LoraIds = () => E.H3_STYLE_LORAS.map(l => l[0]);
  const randSeed = () => Math.floor(Math.random() * 1e9);

  // ═══════════════════════════════════════════════════════════════════════
  // 1) Fiche personnage (Krea 2) — ancre d'apparence, image 1 des keyframes duales
  // ═══════════════════════════════════════════════════════════════════════
  function CharsheetNode() {
    this.addOutput("charsheet", 0);
    this.properties = {
      brief: "a lighthouse keeper with short white hair, yellow raincoat and a red scarf",
      // `lora` défaut "" = aucune LoRA, graphe strictement inchangé (cf. addKrea2Shared).
      // La résolution de la planche reste FIXE (1920×1088) : la LoRA ne la touche pas.
      style: "cinematic", lora: "", seed: 0, charDesc: "", src: "", outFile: null
    };
    this.addWidget("text", "personnage", this.properties.brief, v => { this.properties.brief = v; });
    this.addWidget("combo", "style", this.properties.style, v => { this.properties.style = v; }, { values: styleIds() });
    this.addWidget("combo", "style (LoRA)", this.properties.lora, v => { this.properties.lora = v; }, { values: loraIds });
    this.addWidget("number", "seed (0=auto)", this.properties.seed, v => { this.properties.seed = Math.max(0, Math.round(v)); }, { min: 0, step: 1 });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this.size = [340, 260];
    setStatus(this, "idle", "");
  }
  CharsheetNode.title = "Fiche personnage (Krea 2)";
  wireCommon(CharsheetNode);

  CharsheetNode.prototype.generate = async function () {
    const brief = (this.properties.brief || "").trim();
    if (!brief) { setStatus(this, "error", T("Erreur : description personnage vide.")); return; }
    setStatus(this, "running", T("Fiche personnage : gemma…"));
    try {
      // Étape (a) de generateStoryboardV2 : gemma → champs → charDesc → planche Krea 2.
      const fields = await E.characterSheetFromBrief(brief);
      const charDesc = E.charDescFromFields(fields);
      this.properties.charDesc = charDesc;
      const seed = this.properties.seed || randSeed();
      setStatus(this, "running", T("Planche personnage (Krea 2) en cours…"));
      const promptId = await E.submitCharsheetJob({
        charDesc, negative: "", seed, width: 1920, height: 1088,
        styleId: this.properties.style, lora: this.properties.lora, modelLabel: MODEL_LABEL, clientId
      });
      E.registerJob(promptId, this);
      this.properties.promptId = promptId;
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
    finish(this);
  };
  LiteGraph.registerNodeType("adv/charsheet", CharsheetNode);

  // ═══════════════════════════════════════════════════════════════════════
  // 2) Fiche décor (Krea 2) — ancre d'environnement, image 2 des keyframes duales
  // ═══════════════════════════════════════════════════════════════════════
  function LocsheetNode() {
    this.addOutput("locsheet", 0);
    this.properties = {
      brief: "the round lantern room of an old lighthouse, green tiled floor, brass lamps, spiral staircase",
      // Idem CharsheetNode : LoRA optionnelle, résolution de planche FIXE (1920×1088).
      style: "cinematic", lora: "", seed: 0, locDesc: "", src: "", outFile: null
    };
    this.addWidget("text", "décor", this.properties.brief, v => { this.properties.brief = v; });
    this.addWidget("combo", "style", this.properties.style, v => { this.properties.style = v; }, { values: styleIds() });
    this.addWidget("combo", "style (LoRA)", this.properties.lora, v => { this.properties.lora = v; }, { values: loraIds });
    this.addWidget("number", "seed (0=auto)", this.properties.seed, v => { this.properties.seed = Math.max(0, Math.round(v)); }, { min: 0, step: 1 });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this.size = [340, 260];
    setStatus(this, "idle", "");
  }
  LocsheetNode.title = "Fiche décor (Krea 2)";
  wireCommon(LocsheetNode);

  LocsheetNode.prototype.generate = async function () {
    const brief = (this.properties.brief || "").trim();
    if (!brief) { setStatus(this, "error", T("Erreur : description décor vide.")); return; }
    setStatus(this, "running", T("Fiche décor : gemma…"));
    try {
      const fields = await E.locationSheetFromBrief(brief);
      const locDesc = E.locDescFromFields(fields);
      this.properties.locDesc = locDesc;
      const seed = this.properties.seed || randSeed();
      setStatus(this, "running", T("Planche décor (Krea 2) en cours…"));
      const promptId = await E.submitLocsheetJob({
        locDesc, negative: "", seed, width: 1920, height: 1088,
        styleId: this.properties.style, lora: this.properties.lora, modelLabel: MODEL_LABEL, clientId
      });
      E.registerJob(promptId, this);
      this.properties.promptId = promptId;
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
    finish(this);
  };
  LiteGraph.registerNodeType("adv/locsheet", LocsheetNode);

  // ═══════════════════════════════════════════════════════════════════════
  // 3) Storyboard — keyframes Qwen-Edit ancrées double + grille contact-sheet.
  //    S'ARRÊTE APRÈS LES KEYFRAMES : la génération vidéo (cuts i2v) est une carte
  //    séparée (adv/cutvideo), pour pouvoir valider le storyboard avant de payer les
  //    cuts et choisir le moteur vidéo à ce moment-là.
  //    Entrées : charsheet (slot 0) ET locsheet (slot 1) — LES DEUX doivent être
  //    résolues (outFile posé par le nœud amont terminé) pour lancer quoi que ce soit.
  // ═══════════════════════════════════════════════════════════════════════
  function StoryboardNode() {
    this.addInput("charsheet", 0);
    this.addInput("locsheet", 0);
    // Lot 5 : 3ᵉ fiche OPTIONNELLE et générique (une 2ᵉ fiche personnage OU une 2ᵉ fiche
    // décor, peu importe) — slot AUTOGROW plafonné à 1, car `TextEncodeQwenImageEditPlus`
    // n'expose que image1/image2/image3 : 3 fiches est une limite DURE de ComfyUI, jamais
    // dépassable (une fois ce slot connecté, aucun nouveau slot n'apparaît).
    this.addInput(SLOT_SHEET_REF, 0);
    this.addOutput("keyframes", 0);
    this.properties = {
      brief: "the lighthouse keeper climbs to the lantern room and watches the storm",
      shotCount: 4, segmentDuration: 3, style: "cinematic", seed: 0,
      // Persistés pour la carte « Génération vidéo » en aval (même pattern que `cutNames`
      // persisté ici auparavant pour `FinalVideoNode`) : elle n'a accès qu'à ce que le
      // storyboard expose, elle n'est pas recâblée vers Personnage/Décor.
      shots: [], keyframes: [], charDesc: "", locDesc: "", styleId: "",
      src: "", outFile: null
    };
    this.addWidget("text", "brief", this.properties.brief, v => { this.properties.brief = v; });
    this.addWidget("number", "plans", this.properties.shotCount, v => { this.properties.shotCount = Math.min(16, Math.max(1, Math.round(v))); }, { min: 1, max: 16, step: 1 });
    this.addWidget("number", "durée/plan (s)", this.properties.segmentDuration, v => { this.properties.segmentDuration = Math.min(10, Math.max(1, Math.round(v))); }, { min: 1, max: 10, step: 1 });
    this.addWidget("combo", "style", this.properties.style, v => { this.properties.style = v; }, { values: styleIds() });
    this.addWidget("number", "seed (0=auto)", this.properties.seed, v => { this.properties.seed = Math.max(0, Math.round(v)); }, { min: 0, step: 1 });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this._baseH = 320;
    this.size = [360, 320];
    autoHeight(this);
    setStatus(this, "idle", "");
  }
  StoryboardNode.title = "Storyboard (keyframes)";
  wireCommon(StoryboardNode);
  wireAutogrow(StoryboardNode, [[SLOT_SHEET_REF, MAX_EXTRA_SHEETS]]);

  StoryboardNode.prototype.generate = async function () {
    // ── Gating à 2 entrées : tant que les DEUX planches ne sont pas résolues, on sort
    // AVANT le moindre appel réseau (aucun fetch ComfyUI, aucun fetch Ollama).
    const charNode = upstreamNode(this, 0), locNode = upstreamNode(this, 1);
    const charFile = upstreamFile(this, 0), locFile = upstreamFile(this, 1);
    if (!charFile || !locFile) {
      const miss = [!charFile ? T("fiche personnage") : null, !locFile ? T("fiche décor") : null].filter(Boolean).join(" + ");
      setStatus(this, "error", `${T("Erreur : ")}${miss} ${T("non résolue — les 2 entrées sont requises.")}`);
      return;
    }
    const brief = (this.properties.brief || "").trim();
    if (!brief) { setStatus(this, "error", T("Erreur : brief vide.")); return; }

    const charDesc = charNode.properties.charDesc || "";
    const locDesc = locNode.properties.locDesc || "";
    const n = this.properties.shotCount;
    const seed = this.properties.seed || randSeed();
    const base = {
      charDesc, locDesc, negative: "", styleId: this.properties.style,
      modelLabel: MODEL_LABEL, clientId, width: 1920, height: 1088
    };
    setStatus(this, "running", `Storyboard : ${n} ${T("plans")} ${T("via gemma…")}`);
    try {
      // (b) shot list Scene DNA
      const shots = await E.shotListFromBrief(brief, n, this.properties.segmentDuration);

      // Les planches amont sont des SORTIES ComfyUI : les ré-uploader en entrées
      // (exactement ce que fait resolveImageJob dans generateStoryboardV2).
      const charName = (await E.reupload(charFile)).name;
      const locName = (await E.reupload(locFile)).name;
      // Lot 5 : 3ᵉ fiche optionnelle (slot AUTOGROW). Absente ⇒ image3Name reste undefined
      // et le graphe soumis est exactement celui d'avant.
      const image3Name = (await refNamesFor(this, SLOT_SHEET_REF))[0];
      // La 3ᵉ fiche est signalée au prompt via le champ `extra` déjà prévu par
      // compileKeyframePrompt (aucune modification du compilateur de prompt).
      if (image3Name) for (const s of shots)
        s.extra = ((s.extra || "") + " Use the third reference image only as an additional appearance and art-direction guide for the same single scene.").trim();

      // (c) 1 job Qwen-Edit dual par plan — ancrage double, piège n°10.
      setStatus(this, "running", `Keyframes Qwen-Edit (0/${n})…`);
      const anchorRaw = await E.getTemplate("api/qwen_edit_dual.json");
      const keyIds = [];
      for (let i = 0; i < n; i++) {
        const keyId = await E.submitKeyframeJob({ ...base, anchorRaw, shot: shots[i], charName, locName, image3Name,
          seed: seed + 11 + i, idx: i, total: n });
        E.registerJob(keyId, this);
        keyIds.push(keyId);
        setStatus(this, "running", `Keyframes Qwen-Edit (${i + 1}/${n} ${T("soumises")})…`);
      }
      const keyEntries = await E.waitForJobs(keyIds);
      const keys = [], keyFiles = [];
      for (const id of keyIds) {
        const f = E.outputFiles(keyEntries[id], ".png")[0];
        keyFiles.push(f);
        keys.push(await E.reupload(f));
      }

      // (d) grille contact-sheet — sert aussi de preview du nœud.
      setStatus(this, "running", T("Grille contact-sheet…"));
      const gridId = await E.submitGridJob({ ...base, keys });
      E.registerJob(gridId, this);
      const gridEntry = await E.waitForJobs([gridId]);
      const gridFile = E.outputFiles(gridEntry[gridId], ".png")[0];
      if (gridFile) {
        this.properties.outFile = gridFile;
        this.properties.src = E.viewURL(gridFile);
        buildOverlay(this);
      }

      // (e) La génération vidéo n'est PLUS faite ici : elle est déportée sur la carte
      // « Génération vidéo » (adv/cutvideo), pour valider le storyboard avant de payer les
      // cuts et choisir le moteur (LTX 2.5 / Minimax H3) à ce moment-là. On persiste donc
      // TOUT ce dont cette carte a besoin — même pattern que `cutNames` persisté ici
      // auparavant pour `FinalVideoNode`. `keyframes` = nom uploadable dans l'input ComfyUI
      // + fichier de sortie d'origine (pour retrouver la taille de l'image), dans l'ordre des plans.
      this.properties.shots = shots;
      this.properties.keyframes = keys.map((k, i) => ({ name: k.name, file: keyFiles[i] }));
      this.properties.charDesc = charDesc;
      this.properties.locDesc = locDesc;
      this.properties.styleId = this.properties.style;
      this.properties.promptIds = { keyIds, gridId };
      setStatus(this, "done", `${T("Terminé : ")}${keys.length} ${T("keyframes prêtes.")}`);
    } catch (e) {
      setStatus(this, "error", T("Erreur : ") + e.message);
    }
    finish(this);
  };
  LiteGraph.registerNodeType("adv/storyboard", StoryboardNode);

  // ═══════════════════════════════════════════════════════════════════════
  // 3 bis) Génération vidéo — 1 cut i2v par plan à partir des keyframes validées.
  //    Entrée unique : `keyframes` (sortie du Storyboard). Tout ce qui est nécessaire à
  //    la construction des cuts (shots / charDesc / locDesc / styleId / keyframes) est lu
  //    sur les properties du nœud amont : AUCUN recâblage vers Personnage/Décor.
  //    Trois moteurs :
  //      · LTX 2.5     → chemin EXACT de `E.submitCutJob` (api/ltx25_i2v.json, videoSizeFor)
  //      · Minimax H3  → api/minimax_h3_i2v.json + applyMinimaxTurbo. La grille 17n+5
  //        (piège n°11) est calculée DANS le template par le ComfyMathExpression déjà câblé
  //        sur {{DURATION}} — même mécanique que Ref2VideoNode, rien n'est recalculé ici.
  //      · Minimax H3 (r2v) → api/minimax_h3_r2v.json : chaque cut part de TROIS références
  //        au lieu d'une first_frame — ref_image_0 = fiche personnage BRUTE, ref_image_1 =
  //        fiche décor BRUTE (toutes deux remontées à 2 sauts via le storyboard amont),
  //        ref_image_2 = la keyframe du plan (greffée par `E.addMinimaxRefs`, qui numérote
  //        justement à partir de 2). Checkpoint `*_ref2va_*`, DIFFÉRENT et NON
  //        interchangeable avec le `*_fl2va_*` de l'i2v → la LoRA turbo 4-step `fl2v`
  //        n'y est PAS valide : `applyMinimaxTurbo` est appelée SANS 3ᵉ argument, comme le
  //        fait déjà Ref2VideoNode pour le même motif (AGENTS.md, LESSONS piège n°12).
  //    Sortie : `cutNames` persisté sur this.properties, au format EXACT attendu par
  //    `FinalVideoNode` (inchangé).
  // ═══════════════════════════════════════════════════════════════════════
  const CUT_ENGINES = [["ltx25", "LTX 2.5"], ["minimax_h3", "Minimax H3"], ["minimax_h3_r2v", "Minimax H3 (r2v)"]];
  const CUT_TEMPLATES = {
    ltx25: "api/ltx25_i2v.json",
    minimax_h3: "api/minimax_h3_i2v.json",
    minimax_h3_r2v: "api/minimax_h3_r2v.json"
  };
  function CutVideoNode() {
    this.addInput("keyframes", 0);
    this.addOutput("cuts", 0);
    // `negative` (défaut "" = comportement d'avant) n'a d'effet que sur LTX 2.5, seul
    // template à porter un {{NEGATIVE_PROMPT}} réellement encodé. Le prompt POSITIF, lui,
    // reste produit automatiquement par `compileCutPrompt` (ancrage scène + personnage +
    // décor + mouvement, piège n°9) : aucun champ prompt manuel sur cette carte.
    // `lora` : LoRA de style Minimax H3, cumulable avec turbo (cf. Engine.addH3StyleLora) —
    // n'a d'effet que sur la branche engine === "minimax_h3" (i2v), jamais sur la branche
    // minimax_h3_r2v (checkpoint ref2va différent — même restriction que la LoRA turbo
    // 4-step, cf. le GARDE-FOU 2-arguments d'applyMinimaxTurbo plus bas dans ce fichier).
    this.properties = {
      engine: "ltx25", duration: 3, turbo: true, steps: 8, seed: 0, negative: "", lora: "",
      cutNames: [], src: "", outFile: null
    };
    this.addWidget("combo", "moteur", this.properties.engine, v => { this.properties.engine = v; }, { values: CUT_ENGINES.map(e => e[0]) });
    this.addWidget("number", "durée/plan (s)", this.properties.duration, v => { this.properties.duration = Math.min(10, Math.max(1, Math.round(v))); }, { min: 1, max: 10, step: 1 });
    // turbo + steps + style (LoRA) ne servent QUE pour engine === "minimax_h3" (LTX 2.5 n'a
    // structurellement aucun LoraLoaderModelOnly dans ses templates). Les widgets litegraph
    // natifs ci-dessous restent inconditionnels (jamais peints/cliquables, drawNodeWidgets
    // neutralisé — cf. canvas.html) ; c'est le VRAI panneau utilisateur (CARDS/showProps de
    // canvas.html) qui applique la visibilité conditionnelle, via
    // `when: n => n.properties.engine === "minimax_h3"` sur ces 3 champs.
    this.addWidget("toggle", "turbo (LoRA)", this.properties.turbo, v => { this.properties.turbo = !!v; });
    this.addWidget("combo", "steps", this.properties.steps, v => { this.properties.steps = Number(v); }, { values: [4, 6, 8] });
    this.addWidget("combo", "style H3 (LoRA)", this.properties.lora, v => { this.properties.lora = v; }, { values: h3LoraIds });
    this.addWidget("number", "seed (0=auto)", this.properties.seed, v => { this.properties.seed = Math.max(0, Math.round(v)); }, { min: 0, step: 1 });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this.size = [340, 260];
    setStatus(this, "idle", "");
  }
  CutVideoNode.title = "Génération vidéo (cuts)";
  wireCommon(CutVideoNode);

  CutVideoNode.prototype.generate = async function () {
    // Gating : tant que le storyboard amont n'a pas produit ses keyframes, on sort AVANT
    // le moindre appel réseau (même pattern que le gating du storyboard).
    const up = upstreamNode(this, 0);
    const p = up && up.properties ? up.properties : null;
    const keyframes = p && p.keyframes, shots = p && p.shots;
    if (!keyframes || !keyframes.length || !shots || !shots.length) {
      setStatus(this, "error", T("Erreur : storyboard amont non résolu (aucune keyframe)."));
      return;
    }
    const engine = this.properties.engine;
    const label = (CUT_ENGINES.find(e => e[0] === engine) || CUT_ENGINES[0])[1];
    // Mode r2v uniquement : les 2 fiches BRUTES sont des références obligatoires. On les
    // remonte à 2 sauts (ce nœud → storyboard → personnage / décor) avec le MÊME helper
    // générique `upstreamFile(node, slot)` que partout ailleurs, et on sort AVANT le moindre
    // appel réseau si l'une manque. Défense en profondeur : le storyboard exige déjà ses
    // 2 fiches pour produire des keyframes, ce cas ne devrait donc jamais se présenter.
    let charFile = null, locFile = null;
    if (engine === "minimax_h3_r2v") {
      charFile = upstreamFile(up, 0);
      locFile = upstreamFile(up, 1);
      if (!charFile || !locFile) {
        const miss = [!charFile ? T("fiche personnage") : null, !locFile ? T("fiche décor") : null].filter(Boolean).join(" + ");
        setStatus(this, "error", `${T("Erreur : ")}${miss} ${T("non résolue en amont du storyboard — requise par le mode")} ${label}.`);
        return;
      }
    }
    const duration = this.properties.duration;
    const seed = this.properties.seed || randSeed();
    const base = {
      charDesc: p.charDesc || "", locDesc: p.locDesc || "", negative: this.properties.negative || "",
      styleId: p.styleId || "none", modelLabel: MODEL_LABEL, clientId
    };
    const kindLabel = engine === "minimax_h3_r2v" ? label : `${label} i2v`;
    setStatus(this, "running", `${T("Cuts")} ${kindLabel} (0/${shots.length})…`);
    try {
      const tplRaw = await E.getTemplate(CUT_TEMPLATES[engine] || CUT_TEMPLATES.ltx25);
      // Mode r2v : les 2 planches sont des SORTIES ComfyUI, ré-uploadées UNE fois en entrées
      // (même geste que le storyboard/Ref2VideoNode) — elles sont communes à tous les cuts.
      const charName = charFile ? (await E.reupload(charFile)).name : null;
      const locName = locFile ? (await E.reupload(locFile)).name : null;
      const cutIds = [];
      for (let k = 0; k < shots.length; k++) {
        // La keyframe est déjà uploadée dans l'input ComfyUI (nom persisté par le
        // storyboard) ; son blob n'est relu que pour en déduire le format vidéo.
        const kf = keyframes[k];
        const blob = await (await fetch(E.viewURL(kf.file))).blob();
        const keyObj = { name: kf.name, blob };
        if (engine === "minimax_h3") {
          const sz = E.videoSizeFor(await E.imageSize(blob));
          const g = E.buildGraph(tplRaw, {
            prompt: E.compileCutPrompt(shots[k], base.charDesc, base.locDesc, null, base.styleId),
            negative: "", seed: seed + 31 + k, width: sz.w, height: sz.h, batch: 1,
            duration, image: keyObj.name
          });
          E.applyMinimaxTurbo(g, this.properties.turbo, this.properties.steps);
          // Cumul turbo + style — ORDRE OBLIGATOIRE, cf. commentaire d'addH3StyleLora dans
          // engine.js (doit toujours suivre applyMinimaxTurbo, jamais le précéder).
          if (this.properties.lora) E.addH3StyleLora(g, this.properties.lora);
          const st = Number(this.properties.steps);
          const stepLabel = this.properties.turbo
            ? `turbo ${st} steps${st === 4 ? " (fl2v v1.2)" : ""}`
            : "20 steps";
          for (const node of Object.values(g))
            if (node.class_type === "SaveVideo") node.inputs.filename_prefix = `studio/story/cut_${String(k + 1).padStart(2, "0")}`;
          this._lastGraph = g;   // graphe RÉELLEMENT soumis (hors properties : non sérialisé)
          const cutId = await E.submitGraph(g, `Storyboard · cut ${k + 1}/${shots.length}`,
            `Minimax H3 i2v · ${duration}s · ${sz.w}x${sz.h} · ${stepLabel} · seed ${seed + 31 + k}`, clientId);
          E.registerJob(cutId, this);
          cutIds.push(cutId);
        } else if (engine === "minimax_h3_r2v") {
          // Format dérivé de la KEYFRAME (comme l'i2v) : c'est elle qui fixe la composition
          // et le cadrage du plan, les 2 planches ne sont que des ancres d'apparence.
          const sz = E.videoSizeFor(await E.imageSize(blob));
          const g = E.buildGraph(tplRaw, {
            // Même prompt que le chemin Minimax H3 i2v — aucun mécanisme de prompt nouveau.
            prompt: E.compileCutPrompt(shots[k], base.charDesc, base.locDesc, null, base.styleId),
            negative: "", seed: seed + 31 + k, width: sz.w, height: sz.h, batch: 1,
            duration, image: charName, image2: locName   // ref_image_0 / ref_image_1 du template
          });
          // La keyframe du plan devient ref_image_2 : `addMinimaxRefs` numérote justement à
          // partir de 2, les 2 premières références étant déjà câblées par le template.
          E.addMinimaxRefs(g, { images: [keyObj.name] });
          // GARDE-FOU : appel à 2 arguments, JAMAIS `this.properties.steps`. La LoRA turbo
          // 4-step est entraînée pour le checkpoint fl2v (i2v) et n'est pas valide sur le
          // ref2va (r2v) — le widget « steps » reste donc sans effet dans ce mode.
          E.applyMinimaxTurbo(g, this.properties.turbo);
          for (const node of Object.values(g))
            if (node.class_type === "SaveVideo") node.inputs.filename_prefix = `studio/story/cut_${String(k + 1).padStart(2, "0")}`;
          this._lastGraph = g;   // graphe RÉELLEMENT soumis (hors properties : non sérialisé)
          const cutId = await E.submitGraph(g, `Storyboard · cut ${k + 1}/${shots.length}`,
            `Minimax H3 r2v · ${duration}s · ${sz.w}x${sz.h} · ${this.properties.turbo ? "turbo 8 steps" : "20 steps"} · seed ${seed + 31 + k}`, clientId);
          E.registerJob(cutId, this);
          cutIds.push(cutId);
        } else {
          const cutId = await E.submitCutJob({ ...base, i2vRaw: tplRaw, keyObj, shot: shots[k],
            holdMotion: null, duration, seed: seed + 31 + k, idx: k, total: shots.length });
          E.registerJob(cutId, this);
          cutIds.push(cutId);
        }
        setStatus(this, "running", `${T("Cuts")} ${kindLabel} (${k + 1}/${shots.length} ${T("soumis")})…`);
      }
      const cutEntries = await E.waitForJobs(cutIds);
      const cutNames = [], cutFiles = [];
      for (const id of cutIds) {
        const f = E.outputFiles(cutEntries[id], ".mp4")[0];
        cutFiles.push(f);
        cutNames.push((await E.reupload(f)).name);
      }
      this.properties.cutNames = cutNames;   // format EXACT lu par FinalVideoNode
      this.properties.promptIds = { cutIds };
      this.properties.outFile = cutFiles[0];
      this.properties.src = E.viewURL(cutFiles[0]);
      buildOverlay(this);
      setStatus(this, "done", `${T("Terminé : ")}${cutNames.length} ${T("cuts prêts.")}`);
    } catch (e) {
      setStatus(this, "error", T("Erreur : ") + e.message);
    }
    finish(this);
  };
  LiteGraph.registerNodeType("adv/cutvideo", CutVideoNode);

  // ═══════════════════════════════════════════════════════════════════════
  // 4) Vidéo finale — assemblage en cuts francs des cuts du storyboard (animatic)
  // ═══════════════════════════════════════════════════════════════════════
  function FinalVideoNode() {
    this.addInput("cuts", 0);
    this.addOutput("video", 0);
    this.properties = { audio: true, src: "", outFile: null };
    this.addWidget("toggle", "audio", this.properties.audio, v => { this.properties.audio = !!v; });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this.size = [340, 240];
    setStatus(this, "idle", "");
  }
  FinalVideoNode.title = "Vidéo finale (animatic)";
  wireCommon(FinalVideoNode);

  FinalVideoNode.prototype.generate = async function () {
    const up = upstreamNode(this, 0);
    const cutNames = up && up.properties ? up.properties.cutNames : null;
    if (!cutNames || !cutNames.length) {
      setStatus(this, "error", T("Erreur : storyboard amont non résolu (aucun cut)."));
      return;
    }
    setStatus(this, "running", `${T("Assemblage de")} ${cutNames.length} ${T("cuts")}…`);
    try {
      const promptId = await E.submitAnimaticJob({
        cutNames, withAudio: this.properties.audio, seed: randSeed(), clientId
      });
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
    finish(this);
  };
  LiteGraph.registerNodeType("adv/final_video", FinalVideoNode);

  // ═══════════════════════════════════════════════════════════════════════
  // 5) Reference2Video (Minimax H3 r2v) — nœud SÉPARÉ du storyboard.
  //    Même point de départ (les 2 mêmes planches) mais logique distincte :
  //    UN SEUL job, les planches sont les ref_images du nœud
  //    MiniMaxH3ReferenceToVideo, ni keyframe ni cut ni animatic.
  // ═══════════════════════════════════════════════════════════════════════
  const R2V_RATIOS = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1024, 1024], "4:5": [832, 1040] };
  function Ref2VideoNode() {
    this.addInput("charsheet", 0);
    this.addInput("locsheet", 0);
    // Lot 5 : références additionnelles OPTIONNELLES, slots AUTOGROW (un slot libre en
    // permanence, un nouveau apparaît dès qu'on connecte celui-là).
    //   « image ref + » → ref_images.ref_image_2..8   (7 max, plafond ComfyUI 9 avec les 2 planches)
    //   « vidéo ref + » → ref_videos.ref_video_0..2 + ref_video_audios.ref_video_audio_0..2 (3 max)
    // La 3ᵉ famille (ref_audios, audio AUTONOME) n'a aucune carte source dans le canvas
    // (décision Lot 3 : pas de carte Audio) → upload de fichier LOCAL, cf. addRefAudio().
    this.addInput(SLOT_IMG_REF, 0);
    this.addInput(SLOT_VID_REF, 0);
    this.addOutput("video", 0);
    // `mp`/`lora` : mégapixels (résolution, cf. Engine.computeMPResolution — unité TOUJOURS
    // 32 sur cette carte, pas de champ "engine" donc jamais LTX 2.5) et LoRA de style
    // Minimax H3 (cf. Engine.H3_STYLE_LORAS/addH3StyleLora), ajoutés à ce lot. Comme `turbo`,
    // `lora` est inconditionnel sur cette carte (toujours Minimax H3).
    this.properties = {
      brief: "the lighthouse keeper walks slowly across the lantern room and looks out of the window",
      ratio: "16:9", mp: "1", duration: 3, turbo: true, lora: "", seed: 0, src: "", outFile: null,
      refAudios: []   // noms de fichiers déjà uploadés dans l'input ComfyUI (max 3)
    };
    this.addWidget("text", "brief", this.properties.brief, v => { this.properties.brief = v; });
    this.addWidget("combo", "ratio", this.properties.ratio, v => { this.properties.ratio = v; }, { values: Object.keys(R2V_RATIOS) });
    this.addWidget("combo", "mégapixels", this.properties.mp, v => { this.properties.mp = v; }, { values: E.MP_VALUES });
    this.addWidget("number", "durée (s)", this.properties.duration, v => { this.properties.duration = Math.min(10, Math.max(1, Math.round(v))); }, { min: 1, max: 10, step: 1 });
    this.addWidget("toggle", "turbo (8 steps)", this.properties.turbo, v => { this.properties.turbo = !!v; });
    this.addWidget("combo", "style H3 (LoRA)", this.properties.lora, v => { this.properties.lora = v; }, { values: h3LoraIds });
    this.addWidget("number", "seed (0=auto)", this.properties.seed, v => { this.properties.seed = Math.max(0, Math.round(v)); }, { min: 0, step: 1 });
    this.genWidget = this.addWidget("button", "Générer", null, () => this.generate());
    this._baseH = 300;
    this.size = [360, 300];
    autoHeight(this);
    setStatus(this, "idle", "");
  }
  Ref2VideoNode.title = "Reference2Video (Minimax H3)";
  wireCommon(Ref2VideoNode);
  wireAutogrow(Ref2VideoNode, [[SLOT_IMG_REF, MAX_EXTRA_IMAGES], [SLOT_VID_REF, MAX_REF_VIDEOS]]);

  // Audio de référence AUTONOME (ref_audios) : aucune carte du canvas ne produit d'audio
  // seul, l'entrée est donc un fichier LOCAL. Upload par le mécanisme déjà en place
  // (E.uploadBlob → POST /comfy/upload/image, qui dépose le fichier dans l'input ComfyUI
  // quel que soit son type — vérifié sur .wav). Appelé depuis le panneau de propriétés de
  // canvas.html : les widgets litegraph n'y sont plus ni peints ni cliquables.
  Ref2VideoNode.prototype.addRefAudio = async function (file) {
    const cur = this.properties.refAudios || [];
    if (cur.length >= MAX_REF_AUDIOS) {
      setStatus(this, "error", `${T("Erreur : ")}${MAX_REF_AUDIOS} ${T("audios de référence au maximum.")}`);
      return;
    }
    setStatus(this, "running", T("Upload de l'audio de référence…"));
    try {
      const name = await E.uploadBlob(file, file.name);
      this.properties.refAudios = cur.concat([name]);
      setStatus(this, "idle", `${this.properties.refAudios.length} ${T("audio(s) de référence.")}`);
    } catch (e) {
      setStatus(this, "error", T("Erreur : ") + e.message);
    }
    finish(this);
  };
  Ref2VideoNode.prototype.clearRefAudios = function () {
    this.properties.refAudios = [];
    setStatus(this, "idle", "");
    finish(this);
  };

  Ref2VideoNode.prototype.generate = async function () {
    // Même gating à 2 entrées que le storyboard.
    const charNode = upstreamNode(this, 0), locNode = upstreamNode(this, 1);
    const charFile = upstreamFile(this, 0), locFile = upstreamFile(this, 1);
    if (!charFile || !locFile) {
      const miss = [!charFile ? T("fiche personnage") : null, !locFile ? T("fiche décor") : null].filter(Boolean).join(" + ");
      setStatus(this, "error", `${T("Erreur : ")}${miss} ${T("non résolue — les 2 entrées sont requises.")}`);
      return;
    }
    setStatus(this, "running", `Minimax H3 r2v ${T("en cours…")}`);
    try {
      const charDesc = charNode.properties.charDesc || "";
      const locDesc = locNode.properties.locDesc || "";
      const charName = (await E.reupload(charFile)).name;
      const locName = (await E.reupload(locFile)).name;
      // Lot 5 : références additionnelles, TOUTES optionnelles — un slot vide (ou connecté
      // à un nœud non résolu) ne bloque rien, refNamesFor l'ignore simplement.
      const refs = {
        images: await refNamesFor(this, SLOT_IMG_REF),
        videos: await refNamesFor(this, SLOT_VID_REF),
        audios: (this.properties.refAudios || []).slice(0, MAX_REF_AUDIOS)
      };
      // Unité TOUJOURS 32 : cette carte n'a pas de champ "engine", jamais LTX 2.5 ici.
      const [width, height] = E.computeMPResolution(parseFloat(this.properties.mp), this.properties.ratio, 32);
      const seed = this.properties.seed || randSeed();
      const raw = await E.getTemplate("api/minimax_h3_r2v.json");
      // Prompt ancré identique à Engine.generateReference2Video (charDesc. locDesc. brief).
      const graph = E.buildGraph(raw, {
        prompt: `${charDesc}. ${locDesc}. ${(this.properties.brief || "").trim()}`, negative: "",
        seed: seed + 201, width, height, batch: 1, duration: this.properties.duration,
        image: charName, image2: locName
      });
      E.addMinimaxRefs(graph, refs);
      E.applyMinimaxTurbo(graph, this.properties.turbo);
      // Cumul turbo + style — ORDRE OBLIGATOIRE, cf. commentaire d'addH3StyleLora dans
      // engine.js (doit toujours suivre applyMinimaxTurbo, jamais le précéder).
      if (this.properties.lora) E.addH3StyleLora(graph, this.properties.lora);
      for (const n of Object.values(graph)) if (n.class_type === "SaveVideo") n.inputs.filename_prefix = "canvas/r2v";
      this._lastGraph = graph;   // graphe RÉELLEMENT soumis (hors properties : non sérialisé)
      const promptId = await E.submitGraph(graph, "Canvas · Minimax H3 r2v",
        `r2v · ${this.properties.duration}s · ${refs.images.length} img + ${refs.videos.length} vidéo + ${refs.audios.length} audio de réf · seed ${seed}`, clientId);
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
    finish(this);
  };
  LiteGraph.registerNodeType("adv/r2v", Ref2VideoNode);

  // Accès pour les tests automatisés.
  window.__advancedNodes = { CharsheetNode, LocsheetNode, StoryboardNode, CutVideoNode, FinalVideoNode, Ref2VideoNode, upstreamNode,
    // Lot 5 : slots dynamiques (noms de groupes + plafonds + helpers), pour les tests.
    SLOT_IMG_REF, SLOT_VID_REF, SLOT_SHEET_REF,
    MAX_EXTRA_IMAGES, MAX_REF_VIDEOS, MAX_REF_AUDIOS, MAX_EXTRA_SHEETS,
    slotIndexes, connectedSlots, refNamesFor };
})();
