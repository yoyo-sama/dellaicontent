// engine.js — logique de génération de `index.html` extraite en fonctions paramétrées.
//
// Partagé avec le Studio : `index.html` charge aussi ce fichier et déstructure `window.Engine`
// pour ses E/S et builders identiques ; le reste (prompts, submit*Job, sa WebSocket) y reste dupliqué.
// Ce fichier reprend la même logique métier (templates, substitutions, ordre des appels
// réseau) mais chaque fonction reçoit ses paramètres en argument explicite au lieu de les
// lire dans des éléments DOM globaux uniques (`brief.value`, `$("shotCount").value`,
// `director.style`, `clientId`…), et rend son résultat par retour/callback au lieu de
// l'écrire dans des éléments DOM fixes. C'est ce qui permet N cartes simultanées sur le canvas.
//
// Chargement : <script src="js/engine.js"></script> → window.Engine (aucun bundler).
(function (global) {
  "use strict";

  // Endpoints — mêmes chemins que index.html (reverse-proxy nginx).
  const COMFY = "/comfy";
  const OLLAMA = "/ollama";
  const OLLAMA_MODEL = "gemma4:e4b";
  const templateCache = {};

  // Remplace `currentStyleText()` (qui lisait `director.style` ou `$("styleSelect").value`).
  function styleTextFor(styleId) {
    return (STYLE_PACKS[styleId] || STYLE_PACKS.none).text;
  }

  function buildGraph(raw, p) {
    const rep = {
      '"{{PROMPT}}"': JSON.stringify(p.prompt),
      '"{{NEGATIVE_PROMPT}}"': JSON.stringify(p.negative),
      '"{{SEED}}"': String(p.seed),
      '"{{WIDTH}}"': String(p.width),
      '"{{HEIGHT}}"': String(p.height),
      '"{{BATCH}}"': String(p.batch),
      '"{{DURATION}}"': String(p.duration || 5),
      '"{{FRAMES}}"': String((p.duration || 5) * (p.fps || LTX25_FPS) + 1),
      '"{{IMAGE}}"': JSON.stringify(p.image || ""),
      '"{{IMAGE2}}"': JSON.stringify(p.image2 || "")
    };
    let t = raw;
    for (const [k, v] of Object.entries(rep)) t = t.split(k).join(v);
    return JSON.parse(t);
  }

  async function getTemplate(file) {
    if (!templateCache[file]) {
      const res = await fetch(`workflows/${file}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`template ${file} introuvable`);
      templateCache[file] = await res.text();
    }
    return templateCache[file];
  }

  function extractFiles(output) {
    const found = [];
    for (const val of Object.values(output || {})) {
      if (!Array.isArray(val)) continue;
      for (const item of val) {
        if (item && typeof item === "object" && item.filename) found.push(item);
      }
    }
    return found;
  }

  // LoRA turbo alternative pour les pipelines fl2v (t2v/i2v, checkpoint
  // `minimax_h3_fl2va_pruned_w4a8_mixed.safetensors`) — validée par rendu réel à 4 steps.
  // PIÈGE N°12 (LESSONS) — PRÉCISION : « 4 steps casse la colorimétrie » ne vaut QUE pour
  // l'ANCIEN LoRA `H3/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors` (celui
  // câblé en dur dans les 3 templates Minimax H3). Le LoRA ci-dessous, spécifiquement
  // entraîné pour 4 steps, ne présente PAS cette dérive : 4 steps est donc exposable dans
  // l'UI, mais UNIQUEMENT avec ce LoRA-là. Son nom porte `fl2v` : il n'est PAS valide pour
  // le r2v, dont le checkpoint (`*_ref2va_*`) est différent et non interchangeable —
  // Ref2VideoNode appelle donc `applyMinimaxTurbo` SANS 3ᵉ argument et garde l'ancien LoRA.
  const MINIMAX_FL2V_LORA_4STEP = "H3/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors";

  // `steps` est OPTIONNEL et rétrocompatible : omis (appel à 2 arguments), le graphe rendu
  // est strictement celui d'avant — LoRA du template conservé, steps du template intouchés.
  // Fourni ET turbo actif : 4 → bascule sur MINIMAX_FL2V_LORA_4STEP + BasicScheduler.steps=4 ;
  // 6/8 → LoRA du template conservé + BasicScheduler.steps=steps.
  // turbo OFF : comportement inchangé (LoRA retirée, steps=20), quel que soit `steps`.
  function applyMinimaxTurbo(graph, turboOn, steps) {
    const loraEntry = Object.entries(graph).find(([, n]) =>
      n.class_type === "LoraLoaderModelOnly" && String(n.inputs.lora_name).startsWith("H3/"));
    if (!loraEntry) return graph;
    if (turboOn) {
      const n = Number(steps);
      if (n !== 4 && n !== 6 && n !== 8) return graph;   // pas de steps exploitable → historique
      if (n === 4) loraEntry[1].inputs.lora_name = MINIMAX_FL2V_LORA_4STEP;
      for (const node of Object.values(graph))
        if (node.class_type === "BasicScheduler") node.inputs.steps = n;
      return graph;
    }
    const [loraId, loraNode] = loraEntry;
    const src = loraNode.inputs.model; // sortie du UNETLoader, en amont de la LoRA
    for (const n of Object.values(graph)) {
      if (Array.isArray(n.inputs.model) && n.inputs.model[0] === loraId) n.inputs.model = src;
      if (n.class_type === "BasicScheduler") n.inputs.steps = 20;
    }
    delete graph[loraId];
    return graph;
  }

  // Retire `last_frame` (et son LoadImage) du graphe Minimax H3 quand aucune dernière
  // image n'est fournie. Le nœud `MiniMaxH3ImageToVideo` couvre à lui seul les trois
  // modes selon ce qui est branché : rien = t2v, `first_frame` seul = i2v, les deux =
  // FL2VA — nos templates t2v et i2v sont déjà le MÊME nœud à un champ près. Même idiome
  // de retrait qu'applyMinimaxTurbo : on supprime la clé et le nœud devenu orphelin.
  function applyMinimaxLastFrame(graph, hasLast) {
    const entry = Object.entries(graph).find(([, n]) => n.class_type === "MiniMaxH3ImageToVideo");
    if (!entry || hasLast) return graph;
    const src = entry[1].inputs.last_frame;
    delete entry[1].inputs.last_frame;
    if (Array.isArray(src)) delete graph[src[0]];
    return graph;
  }

  // ── LoRA de STYLE Minimax H3 — cumulable avec la LoRA turbo ci-dessus ───────────
  // Plus de curation manuelle : la liste réelle vient de fetchLoraOptions() (scan live de
  // /object_info/LoraLoaderModelOnly), voir plus bas. Seul le premier item ("Aucun") est
  // fixe ; le reste est peuplé de façon asynchrone après le chargement du module.
  const H3_STYLE_LORAS = [
    ["", "Aucun"]
  ];
  // Greffe une LoRA de style Minimax H3, CUMULABLE avec la LoRA turbo d'applyMinimaxTurbo —
  // même schéma qu'addKrea2Shared (un seul LoraLoaderModelOnly, strength_model 1), mais
  // insérée un cran plus loin : au lieu de brancher sur la sortie du UNETLoader, elle se
  // branche sur la sortie ACTUELLE de la chaîne `model` (celle que BasicScheduler et
  // BasicGuider consomment déjà dans les templates Minimax H3), qu'il s'agisse encore de la
  // LoRA turbo (turbo ON) ou directement du UNETLoader (turbo OFF, LoRA turbo retirée par
  // applyMinimaxTurbo). Le point d'ancrage est repéré via BasicScheduler.inputs.model
  // (présent dans les 3 templates Minimax H3, déjà utilisé par applyMinimaxTurbo ci-dessus) ;
  // tout nœud pointant vers cette même sortie (BasicScheduler ET BasicGuider) est reciblé
  // vers la nouvelle LoRA.
  // ORDRE OBLIGATOIRE — appeler APRÈS applyMinimaxTurbo, jamais avant : applyMinimaxTurbo
  // retrouve LUI-MÊME son nœud LoraLoaderModelOnly par class_type + préfixe `H3/` (la première
  // LoRA `H3/…` trouvée dans le graphe) pour la retirer ou changer son fichier ; appelé avant addH3StyleLora, tout irait
  // bien, mais appelé APRÈS, il retrouverait la LoRA de STYLE fraîchement ajoutée au lieu de
  // la LoRA turbo (ou la mauvaise des deux selon l'ordre d'itération des clés) et casserait
  // le graphe. `loraName` vide ⇒ graphe strictement inchangé (no-op strict).
  function addH3StyleLora(graph, loraName) {
    if (!loraName) return graph;
    const sched = Object.values(graph).find(n => n.class_type === "BasicScheduler");
    if (!sched) return graph;
    const src = sched.inputs.model;
    let maxId = 0;
    for (const key of Object.keys(graph)) { const v = Number(key); if (Number.isFinite(v)) maxId = Math.max(maxId, v); }
    const id = String(maxId + 1);
    // Reciblage AVANT l'ajout du nouveau nœud (qui référence lui-même `src`) : sinon la
    // boucle ci-dessous se reciblerait aussi elle-même et créerait une boucle sur elle-même.
    for (const n of Object.values(graph))
      if (Array.isArray(n.inputs.model) && n.inputs.model[0] === src[0] && n.inputs.model[1] === src[1])
        n.inputs.model = [id, 0];
    graph[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: [src[0], src[1]], lora_name: loraName, strength_model: 1 } };
    return graph;
  }

  // ── AJOUT Lot 5 : références additionnelles MiniMaxH3ReferenceToVideo ──────────
  // Le template api/minimax_h3_r2v.json ne câble que `ref_images.ref_image_0` et
  // `ref_images.ref_image_1` (personnage / décor). Ce helper greffe les références
  // supplémentaires en réutilisant EXACTEMENT la convention de clés du template
  // ("<famille>.<prefix><N>"), telle que /object_info la déclare pour les 4 familles
  // COMFY_AUTOGROW_V3 du nœud :
  //   ref_images       prefix "ref_image_"       IMAGE  max 9  (0/1 = les 2 planches)
  //   ref_videos       prefix "ref_video_"       IMAGE  max 3  (frames 24 fps, PAS un VIDEO)
  //   ref_video_audios prefix "ref_video_audio_" AUDIO  max 3  ("soundtrack of the
  //                                                             same-numbered reference video")
  //   ref_audios       prefix "ref_audio_"       AUDIO  max 3  (audio autonome)
  // UNE vidéo de référence = 1 LoadVideo → 1 GetVideoComponents dont les sorties `images`
  // (slot 0) et `audio` (slot 1) alimentent le COUPLE ref_video_N / ref_video_audio_N :
  // c'est l'appariement prévu par le nœud, aucune UI séparée n'est nécessaire pour l'audio
  // d'une vidéo de référence.
  // Ids des nœuds greffés : préfixe "ref" (non numérique, comme les "w0"/"h32" déjà
  // présents dans le template) — aucune collision possible avec les ids du template.
  // `refs` vide (ou absent) ⇒ graphe rendu strictement inchangé.
  function addMinimaxRefs(graph, refs) {
    const entry = Object.entries(graph).find(([, n]) => n.class_type === "MiniMaxH3ReferenceToVideo");
    if (!entry || !refs) return graph;
    const mm = entry[1];
    let k = 0;
    const add = (class_type, inputs) => { const id = "ref" + (++k); graph[id] = { class_type, inputs }; return id; };
    (refs.images || []).forEach((name, i) => {
      mm.inputs[`ref_images.ref_image_${i + 2}`] = [add("LoadImage", { image: name }), 0];
    });
    (refs.videos || []).forEach((name, i) => {
      const comp = add("GetVideoComponents", { video: [add("LoadVideo", { file: name }), 0] });
      mm.inputs[`ref_videos.ref_video_${i}`] = [comp, 0];
      mm.inputs[`ref_video_audios.ref_video_audio_${i}`] = [comp, 1];
    });
    (refs.audios || []).forEach((name, i) => {
      mm.inputs[`ref_audios.ref_audio_${i}`] = [add("LoadAudio", { audio: name }), 0];
    });
    return graph;
  }

  // ── AJOUT Lot 5 : 3ᵉ fiche optionnelle du storyboard (image3 de Qwen-Edit) ──────
  // `TextEncodeQwenImageEditPlus` accepte image1/image2/image3 et RIEN au-delà (confirmé
  // via /object_info : optional = vae, image1, image2, image3) — 3 est donc un plafond DUR.
  // api/qwen_edit_dual.json n'en câble que 2 ; ce helper ajoute le 3ᵉ conditionnement.
  // Le template n'est volontairement PAS modifié : il est partagé avec index.html, dont le
  // buildGraph ne connaît pas de placeholder {{IMAGE3}} — y injecter un 3ᵉ LoadImage
  // casserait l'app de prod. La greffe est donc faite ici, au moment de la construction.
  // PIÈGE N°10 : image3 ne va QUE dans les deux TextEncodeQwenImageEditPlus (positif et
  // négatif, comme image1/image2 dans le template) ; le VAEEncode (latent de départ) reste
  // alimenté par la SEULE image1 (la fiche personnage), il n'est jamais touché ici.
  function addQwenImage3(graph, name) {
    let maxId = 0;
    for (const key of Object.keys(graph)) { const v = Number(key); if (Number.isFinite(v)) maxId = Math.max(maxId, v); }
    const li = String(maxId + 1), sc = String(maxId + 2);
    graph[li] = { class_type: "LoadImage", inputs: { image: name } };
    graph[sc] = { class_type: "FluxKontextImageScale", inputs: { image: [li, 0] } };
    for (const n of Object.values(graph))
      if (n.class_type === "TextEncodeQwenImageEditPlus") n.inputs.image3 = [sc, 0];
    return graph;
  }

  // ── Qwen Image 2.1 : références supplémentaires de TextEncodeQwenImage21 ─────
  // api/qwen21_i2i.json câble `images.image_1` ({{IMAGE}}) ; buildGraph ne substitue
  // rien au-delà. Ce helper greffe une LoadImage par nom, à la suite, sous la clé autogrow
  // "images.image_<N>" (1-indexée, contiguë). Toutes les références sont symétriques
  // (conditioning seul, latent de départ vide déjà géré par le nœud) : pas de piège n°10
  // ici. Plafond prouvé en rendu : 10 images au total — c'est à l'appelant de borner `names`.
  function addQwen21Refs(graph, names) {
    const enc = Object.values(graph).find(n => n.class_type === "TextEncodeQwenImage21");
    if (!enc || !names) return graph;
    let n = Object.keys(enc.inputs).filter(k => k.startsWith("images.image_")).length;
    names.forEach((name, i) => {
      const id = "q21ref" + (i + 1);
      graph[id] = { class_type: "LoadImage", inputs: { image: name } };
      enc.inputs[`images.image_${++n}`] = [id, 0];
    });
    return graph;
  }

  const LTX25_FPS = 24;   // LTX 2.5 et Minimax H3 rendent en 24 fps (LTX 2.3 était en 25).

  function makeGraphBuilder() {
    const g = {}; let id = 0;
    const add = (class_type, inputs) => { g[String(++id)] = { class_type, inputs }; return String(id); };
    return { g, add };
  }

  // ── Branche image Krea 2 Turbo (8 steps, cfg 1 — copie de api/krea2_t2i.json) ──
  // ATTENTION (LESSONS piège n°16) : le négatif passe par ConditioningZeroOut, il n'est
  // même pas encodé — TOUTE contrainte doit être formulée POSITIVEMENT dans le prompt.
  //
  // LoRA de style OPTIONNELLE : `loraName` fourni (non vide) intercale un
  // `LoraLoaderModelOnly` entre le `UNETLoader` et tout ce qui consomme `kx.unet` en aval —
  // exactement le schéma de la LoRA turbo Minimax H3 (`applyMinimaxTurbo`) : un seul nœud,
  // `strength_model: 1`, branché sur la sortie du `UNETLoader`, et c'est SA sortie qui est
  // rendue comme `unet`. Argument omis ou vide ⇒ graphe strictement identique à avant.
  // Libellés humains côté UI : `KREA2_LORAS`.
  function addKrea2Shared(add, loraName) {
    let unet = add("UNETLoader", { unet_name: "krea2_turbo_fp8_scaled.safetensors", weight_dtype: "default" });
    if (loraName) unet = add("LoraLoaderModelOnly", { model: [unet, 0], lora_name: loraName, strength_model: 1 });
    const clip = add("CLIPLoader", { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2", device: "default" });
    const vae = add("VAELoader", { vae_name: "qwen_image_vae.safetensors" });
    return { unet, clip, vae };
  }
  // Catalogue des LoRA de style Krea 2 exposées dans l'UI : [nom de fichier, libellé].
  // Plus de curation manuelle : peuplé depuis fetchLoraOptions() (scan live de
  // /object_info/LoraLoaderModelOnly), voir plus bas. Le premier item ("") reste l'absence
  // de LoRA (graphe strictement inchangé) et reste toujours présent/en premier.
  const KREA2_LORAS = [
    ["", "Aucun"]
  ];

  // ── Auto-discovery des LoRA (remplace la curation manuelle ci-dessus) ───────────
  // /object_info/LoraLoaderModelOnly liste TOUS les fichiers présents sous le dossier loras,
  // rescanné live à chaque appel (vérifié empiriquement — pas de cache ComfyUI à contourner).
  // Chemins retournés préfixés par sous-dossier ("Krea2/…", "H3/…", …). On en déduit deux
  // listes filtrées par préfixe ; le libellé est le nom de fichier sans dossier ni extension.
  // Les 2 LoRA turbo H3 sont exclues de la liste "style" : elles restent pilotées par le
  // mécanisme dédié turbo/steps (MINIMAX_FL2V_LORA_4STEP, applyMinimaxTurbo), pas un choix
  // de style — ce sont les 2 SEULS noms exclus, aucun filtre heuristique au-delà.
  const H3_TURBO_LORAS = new Set([
    "H3/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors",
    "H3/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors"
  ]);
  function loraLabel(path) { return path.replace(/^.*\//, "").replace(/\.safetensors$/i, ""); }
  async function fetchLoraOptions() {
    try {
      const res = await fetch(`${COMFY}/object_info/LoraLoaderModelOnly`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.LoraLoaderModelOnly.input.required.lora_name[0] || [];
    } catch {
      return [];
    }
  }
  // Fire-and-forget au chargement du module : pas de top-level await possible (IIFE, pas un
  // module ES), et pas besoin d'en bloquer un — KREA2_LORAS/H3_STYLE_LORAS sont mutés EN
  // PLACE (push, pas réaffectation) pour que toute référence déjà prise sur le tableau (ex.
  // `global.Engine = { KREA2_LORAS, … }` plus bas) voie la mise à jour. Les points de lecture
  // (js/nodes-simple.js, js/nodes-advanced.js, canvas.html) relisent ces tableaux au moment
  // où le menu déroulant s'ouvre réellement, pas seulement à la construction du nœud.
  fetchLoraOptions().then(list => {
    for (const f of list) if (f.startsWith("Krea2/")) KREA2_LORAS.push([f, loraLabel(f)]);
    for (const f of list) if (f.startsWith("H3/") && !H3_TURBO_LORAS.has(f)) H3_STYLE_LORAS.push([f, loraLabel(f)]);
  });
  function addKrea2Shot(add, kx, prompt, seed, width, height, batch) {
    const lat = add("EmptyLatentImage", { width, height, batch_size: batch });
    const pos = add("CLIPTextEncode", { text: prompt, clip: [kx.clip, 0] });
    const zero = add("ConditioningZeroOut", { conditioning: [pos, 0] });
    const ks = add("KSampler", {
      model: [kx.unet, 0], seed, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple",
      positive: [pos, 0], negative: [zero, 0], latent_image: [lat, 0], denoise: 1
    });
    return add("VAEDecode", { samples: [ks, 0], vae: [kx.vae, 0] });
  }
  function addGrid(add, refs) {
    const stitch = (a, b, direction) => [add("ImageStitch", {
      image1: a, direction, match_image_size: true, spacing_width: 0, spacing_color: "white", image2: b
    }), 0];
    // Grille carrée adaptative (4 → 2×2, 9 → 3×3, 16 → 4×4) ; lignes remplies
    // à gauche : une ligne trop courte serait étirée par match_image_size.
    const cols = Math.ceil(Math.sqrt(refs.length));
    const rows = [];
    for (let i = 0; i < refs.length; i += cols) {
      let row = refs[i];
      for (let j = i + 1; j < Math.min(i + cols, refs.length); j++) row = stitch(row, refs[j], "right");
      rows.push(row);
    }
    let grid = rows[0];
    for (let r = 1; r < rows.length; r++) grid = stitch(grid, rows[r], "down");
    return grid;
  }

  const CAMERA_LIB = {
    extreme_close_up: { label: "Très gros plan",
      frame: "an extreme close-up in which the character's face fills almost the entire frame, cropped tightly just below the chin, only the head visible, no shoulders and no body in frame",
      motion: "very slow subtle push-in on the face, almost still" },
    close_up: { label: "Gros plan",
      frame: "a tight head-and-shoulders portrait framing, the character's head and the very tops of the shoulders filling most of the frame, everything below the upper chest cropped out",
      motion: "slow gentle push-in on the character" },
    medium: { label: "Plan moyen",
      frame: "a medium shot of the character from the waist up",
      motion: "steady framing with subtle natural movement" },
    wide: { label: "Plan large",
      frame: "a wide shot showing the character full-length within the surrounding environment",
      motion: "slow pull-back gradually revealing the surroundings" },
    extreme_wide: { label: "Plan d'ensemble",
      frame: "an extreme wide establishing shot in which the character is a small distant figure in the vast landscape",
      motion: "very slow sweeping camera drift across the vast landscape" },
    pov: { label: "Vue subjective",
      frame: "a close over-the-shoulder point-of-view framing from just behind the character, looking out at the environment ahead",
      motion: "smooth first-person forward movement through the scene" },
    low_angle: { label: "Contre-plongée",
      frame: "a low camera angle looking slightly up at the character, making them feel a little taller and more heroic",
      motion: "slow upward tilt, camera rising slightly" },
    high_angle: { label: "Plongée",
      frame: "a high camera angle looking slightly down at the character from a little above",
      motion: "slow downward tilt, camera craning gently down" },
    tracking: { label: "Travelling",
      frame: "a tracking shot positioned beside the character as if following alongside them through the environment",
      motion: "smooth lateral tracking movement following the character" },
    handheld: { label: "Caméra portée",
      frame: "a handheld-style shot of the character with natural, slightly loose framing",
      motion: "loose handheld camera with subtle organic sway" },
  };
  const LIGHTING_LIB = {
    morning: { label: "Matin",
      text: "The whole scene is lit by soft cool early-morning daylight, gentle long shadows and a fresh clear atmosphere." },
    golden_hour: { label: "Heure dorée",
      text: "The whole scene is bathed in warm golden-hour sunlight, long soft shadows and a glowing amber atmosphere." },
    overcast: { label: "Ciel couvert",
      text: "The whole scene sits under flat soft overcast daylight, with muted diffuse shadows and cool desaturated grey tones." },
    moonlight: { label: "Clair de lune",
      text: "The whole scene is lit only by cool blue moonlight, deep shadows and a low-key nocturnal mood under a dark night sky." },
    fire: { label: "Feu",
      text: "The whole scene is lit by flickering warm firelight, a strong orange glow on the character and dancing shadows in the surrounding darkness." },
    interior: { label: "Intérieur",
      text: "The whole scene is lit by soft warm interior lighting from practical lamps, with a cosy sheltered indoor ambience." },
    studio: { label: "Studio",
      text: "The whole scene is lit by clean balanced studio lighting, soft key and fill light and an even neutral exposure." },
    night: { label: "Nuit",
      text: "The whole scene is set at night under cool artificial lighting, with pools of light, deep shadow and a dark sky." },
  };
  // Porté du Studio (index.html, I13) : 14 styles curés sur les 9 familles de la taxonomie
  // Krea 2 (PHOTO / CINE / FASH / ILLU / PAINT / CGI / ANIME / EXP). Texte POSITIF (Krea 2
  // n'encode aucun négatif, piège n°16), toujours ajouté EN FIN de prompt (sujet > style).
  // Les ids none/cinematic/noir/documentary/anime et leurs textes sont inchangés : un nœud
  // enregistré avant cette liste garde son style.
  const STYLE_PACKS = {
    none: { label: "Aucun", text: "" },
    // PHOTO
    editorial: { label: "Éditorial",
      text: "Editorial photography, sophisticated composition, magazine aesthetic, controlled studio lighting, refined neutral palette." },
    analog35: { label: "Argentique 35 mm",
      text: "35mm film, analog grain, soft halation, warm natural light, gentle imperfect exposure." },
    documentary: { label: "Documentaire",
      text: "Naturalistic documentary photography look, available light, realistic muted colors and candid unposed framing." },
    // CINE
    cinematic: { label: "Cinématique",
      text: "Shot on 35mm Kodak Vision3 film, cinematic color grading, soft natural film grain, natural contrast and shallow depth of field." },
    noir: { label: "Film noir",
      text: "High-contrast black-and-white film-noir look, deep shadows, hard directional light and dramatic chiaroscuro." },
    arthouse: { label: "Cinéma d'auteur",
      text: "Arthouse cinema, restrained palette, symbolic composition, naturalistic soft light and quiet contemplative atmosphere." },
    scifi: { label: "SF blockbuster",
      text: "Cinematic science-fiction, ambitious production design, dramatic volumetric lighting, cool steel and neon palette." },
    // FASH
    quiet_luxury: { label: "Luxe discret",
      text: "Quiet luxury, minimalist styling, neutral palette, soft directional light, premium understated materials." },
    // CGI
    product: { label: "Packshot produit",
      text: "Premium product visualization, controlled studio environment, physically accurate materials, clean gradient backdrop, precise specular highlights." },
    // ANIME
    anime: { label: "Anime",
      text: "Stylized Japanese anime illustration look, clean cel-shaded artwork, vivid saturated colors and expressive linework." },
    // ILLU
    screenprint: { label: "Sérigraphie",
      text: "Screen print, flat inks, bold graphic shapes, halftone texture, limited high-contrast palette." },
    // PAINT
    oil: { label: "Peinture à l'huile",
      text: "Classical oil painting, controlled chiaroscuro, rich pigments, visible brushwork on canvas texture." },
    // EXP
    dreamlike: { label: "Onirique",
      text: "Dreamlike atmosphere, soft diffusion, ethereal light, hazy pastel palette and weightless depth." },
  };

  // Sujets d'un plan : `[{desc, kind}]` (ou une chaîne seule, l'ancien `charDesc` du Canvas),
  // dans l'ordre des entrées image. Un sujet sans description est écarté, comme dans le Studio.
  const asSubjects = s => (Array.isArray(s) ? s : [s])
    .map(x => (typeof x === "string" ? { desc: x } : x)).filter(x => x && x.desc);

  // ── Ancrage des keyframes Qwen-Edit : invariant sorti en constantes (porté du Studio) ──
  // Part NON NÉGOCIABLE du prompt de keyframe : le rendu est un plan de film unique et
  // l'identité de chaque référence est conservée (pièges n°21/n°31 : jamais donné à gemma,
  // toujours ré-apposé). SOLO = formulation du Studio, qui ne parle plus de sujet « standing »
  // ni de « costume » (piège n°17) ; DUAL = identité formulée pour n'importe quelle nature de
  // sujet et exemplaire COMPLET exigé de chacun (piège n°32). Texte au caractère près du Studio.
  const KEYFRAME_ANCHOR_DUAL =
    "Both subjects are fully integrated into the same scene, present together in that "
    + "location with correct perspective and scale. Each of them appears exactly once, as one "
    + "single complete and intact whole, assembled in one piece, never broken up, never taken "
    + "apart, never scattered as separate fragments. Do not place the references side by side, "
    + "do not create a split screen, diptych or collage, do not show any reference sheet, "
    + "contact sheet, grid, thumbnails, multiple poses, color swatches, panels, borders, "
    + "margins, black frame, caption or text anywhere. The whole picture is a single unified "
    + "live-action movie frame, one continuous scene that extends all the way to all four "
    + "edges. Keep each subject exactly as its own reference image shows it: same shape, "
    + "structure, proportions, surface, materials, markings and colors, and, for a living "
    + "character, the same anatomy, body plan, head and clothing.";
  const KEYFRAME_ANCHOR_SOLO =
    "The character is fully integrated into the scene, present in that location with correct "
    + "perspective and scale. Do not place the two references side by side, do not create a "
    + "split screen, diptych or collage, do not show any reference sheet, contact sheet, grid, "
    + "thumbnails, multiple poses, color swatches, panels, borders, margins, black frame, caption "
    + "or text anywhere. The whole picture is a single unified live-action movie frame, one "
    + "continuous scene that extends all the way to all four edges. Keep the character's anatomy, "
    + "body plan, head, surface, materials, markings, clothing if any and colors identical to the "
    + "first reference image.";

  // Porté du Studio (compileKeyframePrompt). `subjects` = `charDesc` (chaîne, un sujet) ou
  // `[{desc, kind}]` (1 ou 2 sujets), dans l'ordre des entrées image. Le décor est nommé
  // DEUX fois — phrase de rôle ET après le cadrage (piège n°28 : cette entrée image ne fait
  // que du conditioning, à cfg 1 le prompt fait loi). À deux sujets, chacun est nommé d'après
  // son `kind` et le décor passe sur la 3e entrée image (piège n°32) — branche prête, pas
  // encore câblée côté Canvas. Tout est formulé POSITIVEMENT, le négatif n'est jamais encodé.
  function compileKeyframePrompt(shot, subjects, locDesc, styleId) {
    const list = asSubjects(subjects);
    const charDesc = list[0] ? list[0].desc : "";
    const loc = String(locDesc ?? "").trim();
    const locHere = loc ? " The location is " + loc + "." : "";
    const cam = CAMERA_LIB[shot.camera] || CAMERA_LIB.medium;
    const light = LIGHTING_LIB[shot.lighting] || LIGHTING_LIB.golden_hour;
    const styleText = styleTextFor(styleId);
    const emotion = (shot.emotion || "").trim();
    const extra = (shot.extra || "").trim();
    let s;
    if (list.length > 1) {
      const noun = sub => (charKindOf(sub) === "other" ? "subject" : "character");
      s = "Use the first reference image only as the appearance guide for one single " + noun(list[0]) + ", "
        + list[0].desc
        + ", use the second reference image only as the appearance guide for one single other "
        + noun(list[1]) + ", " + list[1].desc
        + ", and use the third reference image only as the guide for the environment"
        + (loc ? ", " + loc : "") + ". "
        + "The first two reference images are multi-view reference sheets, each one showing the "
        + "same single thing from several angles: read them only to learn what that one thing "
        + "looks like. "
        + "Create one brand-new photorealistic cinematic film still that places exactly one single "
        + "complete instance of each of those two subjects together inside the environment of the "
        + "third reference image, both of them whole and clearly visible in the frame: "
        + shot.action + ". Frame it as " + cam.frame + "." + locHere;
      if (emotion) s += " The subjects' expressions and body language convey " + emotion + ".";
      s += " " + light.text;
      s += " " + KEYFRAME_ANCHOR_DUAL;
    } else {
      s = "Use the first reference image only as the appearance guide for one single character, "
        + charDesc
        + ", and use the second reference image only as the guide for the environment"
        + (loc ? ", " + loc : "") + ". "
        + "Create one brand-new photorealistic cinematic film still that places exactly one single "
        + "instance of that character inside the environment of the second reference image: "
        + shot.action + ". Frame it as " + cam.frame + "." + locHere;
      if (emotion) s += " The character's expression and body language convey " + emotion + ".";
      s += " " + light.text;
      s += " " + KEYFRAME_ANCHOR_SOLO;
    }
    if (extra) s += " " + extra;
    if (styleText) s += " " + styleText;
    return s;
  }

  // Piège n°9 : ordre action→charDesc→locDesc→…→Camera motion INTOUCHABLE (ancrage double).
  // holdMotion (tenue du plan final) substitue le mouvement de caméra du preset.
  function compileCutPrompt(shot, charDesc, locDesc, holdMotion, styleId) {
    const cam = CAMERA_LIB[shot.camera] || CAMERA_LIB.medium;
    const light = LIGHTING_LIB[shot.lighting] || LIGHTING_LIB.golden_hour;
    const styleText = styleTextFor(styleId);
    const emotion = (shot.emotion || "").trim();
    const extra = (shot.extra || "").trim();
    const motion = holdMotion || cam.motion;
    const action = shot.action + (emotion ? ", conveying " + emotion : "");
    let s = action + ". " + charDesc + ". " + locDesc + ". " + light.text
      + " Camera motion: " + motion + ".";
    if (extra) s += " " + extra;
    if (styleText) s += " " + styleText;
    return s;
  }

  // ── Grammaire de prompt Minimax H3 (Ref2VA / I2VA) — portée du Studio ─────────────
  // Composer de référence BMB12d3/minimax-h3-prompt-composer (piège n°19) :
  //   <Picture N> = l'entrée PHYSIQUE ComfyUI, 1-indexée → ref_image_{N-1}
  //   <Subject N> = une identité LOGIQUE ; la liaison tient en UNE phrase de
  //   subject_definitions, puis la prose n'emploie plus que <Subject N>.
  // Plafond du modèle : 7 000 caractères (capH3Prompt).
  const H3_PROMPT_CHARS = 7000;
  const h3Subject = n => `<Subject ${n}>`;
  const h3Picture = n => `<Picture ${n}>`;

  // Définition et note de rétention par nature de sujet. `leadMulti` (piège n°23) : deux
  // personnages ne peuvent pas être tous deux « the main character ».
  const H3_SUBJECT_KINDS = {
    character:   { lead: "is the main character in", leadMulti: "is a character in", note: "the complete defined identity, face, and body proportions are preserved." },
    environment: { lead: "is the location as defined by", note: "the environment's defined architecture, layout, and spatial continuity are retained." },
    reference:   { lead: "is an additional reference in", note: "the defined shape, proportions, materials, colors, and distinguishing features are retained." }
  };

  // Numérotation attribuée par l'app, jamais saisie : l'ordre des slots EST l'ordre des
  // sujets (ref_image_0 → <Picture 1> → <Subject 1>). `list` = [{kind, desc}] ; un sujet
  // « reference » sans description (pas de vision côté Canvas) garde sa définition sans texte.
  function h3AssignSubjects(list) {
    return list.map((sub, i) => ({ ...sub, picture: i + 1, label: h3Subject(i + 1) }));
  }

  // Résumé d'une ligne (champ `summary`) : première phrase du brief, bornée.
  function h3Summary(text) {
    const first = String(text || "").trim().split(/[.!?]/)[0].trim() || String(text || "").trim();
    return first.length > 200 ? `${first.slice(0, 197)}…` : first;
  }

  // Corps de detailed_description : phrase d'ancrage personnage → décor (labels), puis le brief.
  function h3RefBody(subjects, text) {
    const char = subjects.find(sub => sub.kind === "character");
    const env = subjects.find(sub => sub.kind === "environment");
    const anchor = char && env ? `${char.label} is in ${env.label}. ` : "";
    return anchor + String(text || "").trim();
  }

  // Assemble le bloc Ref2VA 6 champs. `subjects` sort de h3AssignSubjects.
  function buildH3RefPrompt({ subjects, summary, body }) {
    const multiChar = subjects.filter(sub => sub.kind === "character").length > 1;
    const defs = subjects.map(sub => {
      const kind = H3_SUBJECT_KINDS[sub.kind] || H3_SUBJECT_KINDS.reference;
      const desc = (sub.desc || "").trim().replace(/[.\s]+$/, "");
      const lead = (multiChar && kind.leadMulti) || kind.lead;
      return `${sub.label} ${lead} ${h3Picture(sub.picture)}${desc ? `, ${desc}` : ""}.`;
    }).join("\n");
    // Pas de parenthèse après le label : un seul plan par clip, rien à y mettre.
    const ret = subjects.map(sub => {
      const kind = H3_SUBJECT_KINDS[sub.kind] || H3_SUBJECT_KINDS.reference;
      return `${sub.label}: fully_preserved - ${kind.note}`;
    }).join("\n");
    return [
      `subject_definitions:\n${defs || "—"}`,
      `summary:\n[reference generation] ${summary}`,
      `retention_analysis:\n${ret || "—"}`,
      `detailed_description:\n${body}`,
      // Les deux derniers champs font partie de la grammaire : H3 les attend.
      "overall_soundscape:\nNatural diegetic ambience consistent with the scene.",
      "non_diegetic_music:\nNone."
    ].join("\n\n");
  }

  // Plafond dur du modèle, rogné en le disant (`onWarn(message)`, optionnel) : l'excédent
  // sort de la FIN de detailed_description, jamais des champs de fin, et un jeton
  // <Subject N> coupé en deux part avec la coupe.
  function capH3Prompt(text, onWarn) {
    if (text.length <= H3_PROMPT_CHARS) return text;
    if (onWarn) onWarn(`Prompt H3 de ${text.length} caractères — tronqué à ${H3_PROMPT_CHARS} (plafond du modèle).`);
    const over = text.length - H3_PROMPT_CHARS;
    const key = "detailed_description:\n", i = text.indexOf(key), end = text.lastIndexOf("\n\noverall_soundscape:");
    if (i >= 0 && end - (i + key.length) > over) return text.slice(0, end - over).replace(/<[A-Za-z]* ?\d*$/, "") + text.slice(end);
    // ponytail: plafond brut, la fin est perdue si le texte n'a pas la structure Ref2VA (i2v/t2v libre) ou si le corps ne suffit pas.
    return text.slice(0, H3_PROMPT_CHARS).replace(/<[A-Za-z]* ?\d*$/, "");
  }

  // Durée RÉELLEMENT rendue par Minimax H3 : grille 17n+5 à 24 fps (piège n°11), modulo à
  // la Python (piège n°20 : sans correction, 1 s donnerait 22 frames au lieu de 39).
  const h3VideoFrames = seconds => {
    const base = Math.max(5, Math.round(seconds * 24));
    return base + (((5 - (base % 17)) % 17) + 17) % 17;
  };
  const h3RealDuration = seconds => h3VideoFrames(seconds) / 24;

  // Phrase d'alignement temporel (header() du composer), en TÊTE du prompt I2VA/FL2VA : i2v
  // (première image seule) ou FL2VA (première ET dernière, repère de fin = durée rendue).
  function h3Alignment(hasLast, seconds) {
    if (!hasLast)
      return "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
    return "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with "
      + `the 0.00-second mark of the target video; <Picture 2> (from [Shot 1]) aligns with the `
      + `${h3RealDuration(seconds).toFixed(2)}-second mark of the target video.`;
  }

  // Cut H3 (i2v depuis une keyframe) : une seule entrée image, où personnage(s) et décor sont
  // déjà composés — tous les sujets se définissent donc sur <Picture 1>. `subjects` = sujets
  // du plan (`[{desc, kind}]` ou chaîne), passés par l'appelant.
  function h3CutSubjects(subjects, locDesc) {
    const list = asSubjects(subjects).map(sub => ({ kind: "character", desc: sub.desc }));
    if (locDesc) list.push({ kind: "environment", desc: locDesc });
    return list.map((sub, i) => ({ ...sub, picture: 1, label: h3Subject(i + 1) }));
  }

  // Corps narratif d'un cut H3 : même matière que compileCutPrompt SANS recopier les
  // descriptions (déjà dans subject_definitions), et TOUS les personnages placés dans le décor.
  function h3CutBodyText(shot, subjects, holdMotion, styleId) {
    const cam = CAMERA_LIB[shot.camera] || CAMERA_LIB.medium;
    const light = LIGHTING_LIB[shot.lighting] || LIGHTING_LIB.golden_hour;
    const emotion = (shot.emotion || "").trim();
    const extra = (shot.extra || "").trim();
    const styleText = styleTextFor(styleId);
    const env = subjects.find(sub => sub.kind === "environment");
    const chars = subjects.filter(sub => sub.kind === "character");
    const lead = chars.length && env
      ? `${chars.map(sub => sub.label).join(" and ")} ${chars.length > 1 ? "are" : "is"} in ${env.label}. `
      : "";
    let s = lead + shot.action + (emotion ? ", conveying " + emotion : "") + ". " + light.text
      + " Camera motion: " + (holdMotion || cam.motion) + ".";
    if (extra) s += " " + extra;
    if (styleText) s += " " + styleText;
    return s;
  }

  // Bloc complet d'un cut H3 : phrase d'alignement (la keyframe est l'instant 0) puis les
  // 6 champs. `bodyOverride` : corps ré-enrichi, la structure reste intacte. `hasLast` :
  // image de fin fournie (FL2VA).
  function buildH3CutPrompt(shot, subjects, locDesc, holdMotion, duration, bodyOverride, hasLast, styleId, onWarn) {
    const subs = h3CutSubjects(subjects, locDesc);
    const body = bodyOverride || h3CutBodyText(shot, subs, holdMotion, styleId);
    return capH3Prompt(`${h3Alignment(!!hasLast, duration)}\n\n` + buildH3RefPrompt({
      subjects: subs, summary: h3Summary(shot.action), body
    }), onWarn);
  }

  // Prompt d'un cut, moteur compris. LTX 2.5 garde EXACTEMENT compileCutPrompt (piège n°9),
  // l'identité étant les descriptions des sujets jointes par ". " (shotCharDesc du Studio).
  function compileCutPromptFor(shot, subjects, locDesc, holdMotion, engine, duration, hasLast, styleId, onWarn) {
    return engine === "minimax_h3"
      ? buildH3CutPrompt(shot, subjects, locDesc, holdMotion, duration, null, hasLast, styleId, onWarn)
      : compileCutPrompt(shot, asSubjects(subjects).map(sub => sub.desc).join(". "), locDesc, holdMotion, styleId);
  }

  // ── Normalisation de la sortie gemma (shotListFromBrief DNA) vers ids valides ──
  const CAMERA_ALIASES = [
    [/(extreme|very)\s*(close|tight)|face[\s-]?fill|macro/, "extreme_close_up"],
    [/close[\s-]?up|closeup|head[\s-]?and[\s-]?shoulders|headshot|tight on/, "close_up"],
    [/medium|waist[\s-]?up|mid[\s-]?shot|cowboy/, "medium"],
    [/extreme[\s-]?wide|very[\s-]?wide|establishing|vista|panorama|aerial/, "extreme_wide"],
    [/wide|full[\s-]?length|full[\s-]?body|long[\s-]?shot/, "wide"],
    [/pov|point[\s-]?of[\s-]?view|first[\s-]?person|over[\s-]?the[\s-]?shoulder|ots/, "pov"],
    [/low[\s-]?angle|worm|from[\s-]?below|looking[\s-]?up|upward/, "low_angle"],
    [/high[\s-]?angle|bird|overhead|top[\s-]?down|from[\s-]?above|looking[\s-]?down/, "high_angle"],
    [/track|dolly|follow|steadicam|alongside/, "tracking"],
    [/handheld|hand[\s-]?held|shaky/, "handheld"],
  ];
  const LIGHTING_ALIASES = [
    [/golden|sunset|dusk|sundown/, "golden_hour"],
    [/morning|sunrise|dawn/, "morning"],
    [/overcast|cloud|grey|gray|diffuse|flat[\s-]?light/, "overcast"],
    [/moon|starlight/, "moonlight"],
    [/fire|flame|torch|campfire|ember|firelight/, "fire"],
    [/interior|indoor|lamp|room|candle/, "interior"],
    [/studio|softbox|key[\s-]?light/, "studio"],
    [/night|dark|nocturnal|neon|artificial/, "night"],
  ];
  function normalizeId(raw, lib, aliases, fallback) {
    const v = String(raw == null ? "" : raw).toLowerCase().trim().replace(/\s+/g, " ");
    if (lib[v]) return v;                          // id exact
    const flat = v.replace(/[\s-]+/g, "_");
    if (lib[flat]) return flat;                    // "close up" / "close-up" -> "close_up"
    for (const [re, id] of aliases) if (re.test(v)) return id; // mapping par sous-chaîne
    return fallback;                               // inconnu -> medium / golden_hour
  }
  const normalizeCamera = raw => normalizeId(raw, CAMERA_LIB, CAMERA_ALIASES, "medium");
  const normalizeLighting = raw => normalizeId(raw, LIGHTING_LIB, LIGHTING_ALIASES, "golden_hour");

  // Repli statique : rotation de presets FIABLES (verdicts LOT A) — on évite
  // extreme_close_up & extreme_wide que l'ancrage Qwen-Edit rend mal (compression focale).
  const FALLBACK_ROTATION = ["wide", "medium", "close_up", "low_angle", "tracking", "high_angle", "pov", "handheld"];
  function fallbackShots(n, action) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({
      camera: FALLBACK_ROTATION[i % FALLBACK_ROTATION.length],
      lighting: "golden_hour",
      action: action || "the character moves through the scene",
      emotion: "",
    });
    return out;
  }
  // Normalise une liste de plans gemma en ids valides ; complète au repli si trop court/malformé.
  function normalizeShotList(rawShots, n, action) {
    const shots = (Array.isArray(rawShots) ? rawShots : [])
      .filter(s => s && typeof s === "object")
      .map(s => ({
        camera: normalizeCamera(s.camera),
        lighting: normalizeLighting(s.lighting),
        action: typeof s.action === "string" ? s.action : (action || ""),
        emotion: typeof s.emotion === "string" ? s.emotion : "",
      }));
    if (shots.length >= n) return shots.slice(0, n);
    const fb = fallbackShots(n, action);
    for (let i = shots.length; i < n; i++) shots.push(fb[i]);
    return shots;
  }

  // Appel gemma4 mutualisé : format JSON, think:false, retry sans think sur 4xx.
  // `images` (optionnel) : tableau de base64 SANS le préfixe data: — le champ `images`
  // du message utilisateur est la façon dont Ollama passe une image à un modèle vision.
  async function gemmaJSON(system, user, images) {
    const userMsg = { role: "user", content: user };
    if (images && images.length) userMsg.images = images;
    const body = {
      model: OLLAMA_MODEL, stream: false, format: "json", think: false,
      messages: [{ role: "system", content: system }, userMsg]
    };
    let res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    if (!res.ok) {
      delete body.think;
      res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
    }
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    return JSON.parse((await res.json()).message.content);
  }

  // gemma renvoie parfois un objet là où on attend une chaîne → on concatène ses valeurs.
  const fieldText = v => {
    if (typeof v === "string") return v.trim();
    if (v && typeof v === "object") return Object.values(v).map(fieldText).filter(Boolean).join(", ");
    return v == null ? "" : String(v);
  };

  // Consigne Krea 2 du Studio (ordre sujet→style→lumière→optique→composition, remplissage
  // banni, AUCUN négatif demandé — piège n°16), au même texte près de la clé de sortie :
  // {"prompt"} comme les autres consignes « ✨ Enrichir » du Canvas.
  const KREA2_ENRICH_SYSTEM = `You are a visual prompt architect for Krea 2, an aesthetic-focused image model.
Rewrite the user's brief into ONE English image prompt, built in this order and keeping only what carries visual information: subject, action, environment, style, lighting, camera and optics, composition, color, material and texture, atmosphere.
Rules:
- Name the main subject first and unambiguously; never let style wording replace or obscure it.
- Preserve the user's subject, action and intent exactly. Invent no detail the brief does not imply.
- Describe the visual result, not how to achieve it.
- Krea 2 never encodes a negative prompt, so express every constraint POSITIVELY: write "clean seamless background", never "no clutter"; write "both hands fully visible and correctly formed", never "no extra limbs".
- Keep one dominant style. Do not stack unrelated style keywords.
- 40 to 100 words. Every phrase must add visual information; delete filler.
- Never use "masterpiece", "best quality", "8k", "ultra detailed", "award winning", "stunning" or "beautiful lighting" — they carry no visual direction.
- A PRIMARY_STYLE line may follow the brief. Build the description so it fits that style, but do NOT restate the style wording itself: it is appended separately.
Before answering, re-read your prompt and delete any banned word that slipped in.
Answer ONLY with JSON: {"prompt": "..."}`;

  // Filet déterministe (porté du Studio) : gemma4:e4b n'honore PAS de façon fiable une
  // interdiction de vocabulaire. On retire ces termes après coup. Liste volontairement
  // étroite — uniquement des termes sans direction visuelle : "photorealistic", "fine
  // detail", "epic scale" et les mots-clés de STYLE_PACKS doivent survivre intacts.
  const PROMPT_PADDING = new RegExp("\\s*\\b(?:" + [
    "masterpiece", "best quality", "highest quality", "high quality",
    "award[- ]winning", "ultra[- ]detailed", "hyper[- ]detailed", "highly detailed",
    "extremely detailed", "insanely detailed", "super detailed", "highly rendered",
    "trending on artstation", "artstation", "cgsociety", "deviantart", "pixiv",
    "octane render", "rendered in octane", "unreal engine(?: \\d)?", "v-?ray", "redshift render",
    "8k(?: uhd)?", "4k", "16k", "32k", "uhd",
  ].join("|") + ")\\b", "gi");
  function stripPromptPadding(text) {
    const out = text.replace(PROMPT_PADDING, "")
      .replace(/,(\s*,)+/g, ",")
      .replace(/([.!?])\s*,\s*/g, "$1 ")
      .replace(/,\s*([.!?])/g, "$1")
      .replace(/\s+([,.!?])/g, "$1")
      .replace(/([.!?])(?:\s*[.!?])+/g, "$1")   // phrase entièrement retirée → "..".
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,]+/, "").replace(/[\s,]+$/, "").trim();
    return out || text;   // un prompt intégralement fait de remplissage : on garde l'original
  }

  // Ordre canonique des champs de fiche (personnage / décor) : la jointure ", " de ces
  // champs par les helpers ci-dessous reproduit EXACTEMENT l'ancienne chaîne charDesc/locDesc.
  // Deux squelettes (piège n°17) : visage/cheveux/tenue ne veulent rien dire hors d'un sujet
  // humain (un lion sortait anthropomorphe et habillé). Le second est volontairement générique
  // (animal, créature, robot, objet). `kind` (dans l'objet de champs, hors des deux listes donc
  // jamais compilé dans le prompt) choisit la liste ; une fiche sans `kind` reste humaine.
  const CHAR_FIELD_KEYS = ["face", "hair", "outfit", "accessories", "palette"];
  const CHAR_OTHER_FIELD_KEYS = ["subject", "form", "surface", "details", "palette"];
  const charKindOf = f => (f?.kind && f.kind !== "human" ? "other" : "human");
  const charFieldKeys = f => (charKindOf(f) === "other" ? CHAR_OTHER_FIELD_KEYS : CHAR_FIELD_KEYS);
  const LOC_FIELD_KEYS = ["place", "architecture", "materials", "lighting", "palette"];
  // Ces deux chaînes alimentent des graphes Krea 2 : même filtre de remplissage que
  // l'enrichissement, sinon un "ultra-detailed fur, 8k" lâché par gemma y atterrit tel quel.
  function charDescFromFields(f) {
    return stripPromptPadding(charFieldKeys(f).map(k => fieldText(f?.[k])).filter(Boolean).join(", "));
  }
  function locDescFromFields(f) {
    return stripPromptPadding(LOC_FIELD_KEYS.map(k => fieldText(f?.[k])).filter(Boolean).join(", "));
  }

  // `isCancelled` (optionnel, Studio) : vrai ⇒ l'attente lève « Projet annulé. » au tour suivant.
  async function waitForJobs(promptIds, isCancelled) {
    const pending = new Set(promptIds), done = {}, gone = {};
    while (pending.size) {
      await new Promise(r => setTimeout(r, 1500));
      if (isCancelled && isCancelled()) throw new Error("Projet annulé.");
      const missing = [];
      for (const id of [...pending]) {
        let entry;
        try { entry = (await (await fetch(`${COMFY}/history/${id}`, { cache: "no-store" })).json())[id]; }
        catch { continue; }
        if (!entry) { missing.push(id); continue; }
        if (entry.status?.status_str === "error") throw new Error(`Un job ComfyUI a échoué (${id}).`);
        if (entry.status?.completed) { done[id] = entry; pending.delete(id); }
      }
      if (!missing.length) continue;
      let queued;
      try {
        const q = await (await fetch(`${COMFY}/queue`, { cache: "no-store" })).json();
        queued = new Set([...q.queue_running, ...q.queue_pending].map(x => x[1]));
      } catch { continue; }
      for (const id of missing) {
        gone[id] = queued.has(id) ? 0 : (gone[id] || 0) + 1;
        if (gone[id] >= 2) throw new Error(`Job ${id} perdu (ComfyUI redémarré ?)`);
      }
    }
    return done;
  }

  // Fichiers de sortie d'une entrée /history filtrés par extension.
  function outputFiles(entry, ext) {
    const files = [];
    for (const nodeOut of Object.values(entry.outputs || {}))
      for (const f of extractFiles(nodeOut))
        if (f.filename.toLowerCase().endsWith(ext) && (f.type || "output") === "output") files.push(f);
    return files;
  }

  // Récupère une sortie via /view puis la ré-uploade en entrée (pattern uploadBlob).
  async function reupload(f) {
    const blob = await (await fetch(viewURL(f))).blob();
    const name = await uploadBlob(blob, f.filename.split("/").pop());
    return { name, blob };
  }

  async function imageSize(blob) {
    const bmp = await createImageBitmap(blob);
    const s = { w: bmp.width, h: bmp.height };
    bmp.close();
    return s;
  }
  // Format vidéo dérivé d'une keyframe (côté long ≤ 1280, multiples de 32).
  function videoSizeFor({ w, h }) {
    const scale = Math.min(1, 1280 / Math.max(w, h));
    return { w: Math.max(320, Math.round(w * scale / 32) * 32), h: Math.max(320, Math.round(h * scale / 32) * 32) };
  }

  // ── Résolution pilotée par mégapixels — porté VERBATIM depuis
  // ai-content-studio-cockpit/index.html (fonction `computeMPResolution`). Constante 1.045
  // (empirique, déjà validée) et formule INTOUCHÉES. Le pas d'arrondi dépend du moteur
  // (`unit`, voir `mpUnitForEngine`) : LTX 2.5 traite l'image en deux passes, dont la
  // seconde double la résolution, donc une taille non multiple de 64 se fait arrondir à
  // chaque passe et la vidéo rendue s'écarte de celle demandée.
  function computeMPResolution(mp, ratioStr, unit) {
    unit = unit || 32;
    const [rw, rh] = ratioStr.split(":").map(Number);
    const ar = rw / rh;
    const width = Math.round(Math.sqrt(1.045 * mp * 1000000 * ar) / unit) * unit;
    const height = Math.round(Math.sqrt(1.045 * mp * 1000000 / ar) / unit) * unit;
    return [width, height];
  }
  // Le canvas n'a pas de notion de "workflow id", seulement `properties.engine` sur les
  // cartes qui en exposent un ("ltx25" | "minimax_h3"). LTX 2.5 = architecture 2 passes
  // (arrondi ×64) ; Minimax H3 = arrondi direct ×32. `engine` absent (adv/r2v, qui n'a pas
  // de champ "engine" et n'est jamais LTX 2.5) ⇒ 32 par défaut.
  function mpUnitForEngine(engine) {
    return engine === "ltx25" ? 64 : 32;
  }
  // 14 valeurs exposées dans l'UI, mêmes valeurs pour les 2 familles de moteurs (seule
  // l'unité d'arrondi diffère).
  const MP_VALUES = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.5, 1.8, 2.0];

  // Krea 2 route le négatif dans ConditioningZeroOut : il n'est même pas encodé (LESSONS
  // piège n°16). Les contraintes autrefois portées par CHARSHEET_NEG/LOCSHEET_NEG sont donc
  // reformulées en instructions POSITIVES ci-dessous (même parade qu'au piège n°7).
  // `negText` (champ négatif de l'UI) est conservé dans la signature mais sans effet ici.
  const SHEET_CLEAN = "One single seamless uncut photograph filling the whole frame edge to edge, completely free of any text, letters, numbers, captions, labels, annotations, watermark, signature or logo, with no drawn borders, no panel lines, no grid lines, no black frame and no comic panel divisions. Pure photography: real photographic capture, sharp focus, high detail, correct anatomy, clean seamless background.";

  // ── Gabarits de planche personnage (portés du Studio, piège n°17) ──
  // Un gabarit ne décrit QUE la composition ; le vocabulaire qui dépend de la nature du sujet
  // sort de `sheetWords(kind)` et la clause anti-anthropomorphe (`SUBJECT_GUARD`) est ajoutée
  // hors gabarit : chaque gabarit marche sur un humain comme sur un lion ou un robot.
  // `turnaround` + sujet humain = au caractère près la formulation qualifiée au LOT 7 (et
  // l'ancien texte en dur de buildCharsheetGraph) — ne pas la retoucher sans rendu réel.
  // Les schémas SVG du sélecteur du Studio (`wire`) restent côté UI.
  const SUBJECT_GUARD = "The subject is photographed exactly as the thing it is: its anatomy, structure, proportions, number of limbs and parts, and its natural resting posture are strictly the ones described above and never those of a human being; it has no human face, and it wears nothing unless the description above says otherwise. ";

  const sheetWords = kind => kind === "other"
    ? { who: "subject", sheet: "reference sheet", design: "design",
        poses: "four views", stance: "natural posture",
        face: "the part that identifies it best: its head, or its front if it has no head",
        faceShort: "that same part", headshots: "photographs", expressions: "seen from different angles",
        details: "its surface, its materials and its distinctive details",
        flats: "its separable parts laid out flat", swatches: "the subject",
        identity: "shape, surface and markings" }
    : { who: "person", sheet: "character reference sheet", design: "character design",
        poses: "four standing poses", stance: "neutral relaxed stance",
        face: "the face", faceShort: "the face", headshots: "headshots",
        expressions: "showing different facial expressions: neutral, smiling, surprised, determined",
        details: "costume details", flats: "the garments laid out flat, seen from the front",
        swatches: "the outfit and hair", identity: "face, hair and costume" };

  const SHEET_HEAD = (d, w, guard) =>
    `A professional photorealistic ${w.sheet} of one single ${w.who}, composited as a clean multi-view layout on a smooth seamless light grey studio background: ${d}. ${guard}`;
  const SHEET_SWATCHES = w =>
    `Along the bottom edge, a horizontal strip of solid rectangular color swatches sampling the exact colors of ${w.swatches}. `;
  const SHEET_SAME = w =>
    `Every view shows the exact same single ${w.who} with identical ${w.identity}, consistent ${w.design}. `;

  const SHEET_TEMPLATES = {
    // Turnaround 4 vues + rangée d'expressions + détails de costume (gabarit historique).
    turnaround: { label: "Turnaround + expressions + costume", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows a full-body turnaround of the same ${w.who} in ${w.poses} evenly spaced across a row - front view, three-quarter view, side profile view, and back view - all in a ${w.stance}, evenly studio-lit. `
      + `Above the turnaround, one large tight close-up portrait of ${w.face}. `
      + `A row of several smaller close-up ${w.headshots} of ${w.faceShort} ${w.expressions}. `
      + `A cluster of detailed close-up photographs of ${w.details}. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) },

    // Colonne d'expressions à gauche + 3 vues + accessoires isolés (planche de modèle anime).
    expressions: { label: "Colonne d'expressions + accessoires", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows down its entire left side a vertical column of five close-up ${w.headshots} of ${w.faceShort} ${w.expressions}, evenly stacked. `
      + `Filling the rest of the frame, three large full-body views of the same ${w.who} side by side - front view, side profile view, and back view - at the same scale on the same ground, all in a ${w.stance}, evenly studio-lit. `
      + `In the lower left corner, below the column, a cluster of isolated close-up photographs of ${w.details}, each one floating separately on the empty background. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) },

    // Grand portrait héros à gauche + rangée de têtes + vues corps (planche 3D / casting).
    portrait: { label: "Grand portrait + rangée de têtes", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows one very large close-up portrait of ${w.face} filling the whole left third of the frame. `
      + `Across the top of the remaining space, a row of five smaller ${w.headshots} of ${w.faceShort} ${w.expressions}. `
      + `Below that row, three large full-body views of the same ${w.who} side by side - front view, side profile view, and back view - at the same scale on the same ground, all in a ${w.stance}, evenly studio-lit. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) },

    // Portrait + turnaround 4 vues + vêtements à plat (planche costume de production).
    wardrobe: { label: "Grand portrait + vêtements à plat", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows one large close-up portrait of ${w.face} in its upper left corner. `
      + `Across the middle and lower part of the frame, a full-body turnaround of the same ${w.who} in ${w.poses} evenly spaced across a row - front view, three-quarter view, side profile view, and back view - at the same scale on the same ground, all in a ${w.stance}, evenly studio-lit. `
      + `Along the right edge, a narrow vertical column of separate product photographs showing ${w.flats}, each isolated on its own plain background. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) },

    // Vues neutres + poses d'action + équipement (planche sport / personnage en mouvement).
    action: { label: "Poses d'action + équipement", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows across its top a row of four full-body views of the same ${w.who} - front view, three-quarter view, side profile view, and back view - at the same scale on the same ground, all in a ${w.stance}. `
      + `Below them, a second row of three full-body action poses of the same ${w.who} caught in mid-movement, each one isolated on the background. `
      + `In the upper right corner, one large close-up portrait of ${w.face}, and beside it four smaller ${w.headshots} ${w.expressions}. `
      + `In the lower right corner, a cluster of isolated close-up photographs of ${w.details} laid out flat. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) }
  };

  // Prompt de planche personnage à partir de la description DÉJÀ compilée. `kind` ("human" |
  // "other", défaut humain) et `templateId` (id de SHEET_TEMPLATES, défaut / "auto" / inconnu
  // = turnaround) sont optionnels : sans eux, texte identique à l'ancien gabarit en dur.
  function charsheetPromptFrom(desc, kind, templateId, styleId) {
    const styleText = styleTextFor(styleId);
    const layout = SHEET_TEMPLATES[templateId] || SHEET_TEMPLATES.turnaround;
    return `${layout.build(desc, sheetWords(kind), kind === "other" ? SUBJECT_GUARD : "")}${SHEET_CLEAN}${styleText ? " " + styleText : ""}`;
  }

  // Planche personnage multi-vues (ancre d'apparence, image 1 des keyframes duales).
  // Format 16:9 large obligatoire (layout prouvé au Lot 1), indépendant du ratio UI.
  // `kind`/`templateId` optionnels (voir charsheetPromptFrom).
  function buildCharsheetGraph(charDesc, negText, seed, width, height, styleId, loraName, kind, templateId) {
    const { g, add } = makeGraphBuilder();
    const kx = addKrea2Shared(add, loraName);
    const dec = addKrea2Shot(add, kx, charsheetPromptFrom(charDesc, kind, templateId, styleId), seed, 1920, 1088, 1);
    add("SaveImage", { images: [dec, 0], filename_prefix: "studio/story/charsheet" });
    return g;
  }

  // Planche décor multi-vues (ancre d'environnement, image 2 des keyframes duales).
  function buildLocsheetGraph(locDesc, negText, seed, width, height, styleId, loraName) {
    const { g, add } = makeGraphBuilder();
    const kx = addKrea2Shared(add, loraName);
    const styleText = styleTextFor(styleId);
    const dec = addKrea2Shot(add, kx,
      `A professional photorealistic environment reference sheet of one single location, composited as a clean multi-view layout on a smooth seamless dark neutral background: ${locDesc}. Arranged neatly, the sheet shows several wide establishing photographs of the same location from different angles across the top, below them a row of medium shots of key structures, and along the bottom a cluster of tight close-up material and detail studies. The location is completely empty and deserted, showing only architecture, materials and scenery. Consistent art direction, matching lighting and color palette across every view. ${SHEET_CLEAN}${styleText ? " " + styleText : ""}`,
      seed, 1920, 1088, 1);
    add("SaveImage", { images: [dec, 0], filename_prefix: "studio/story/locsheet" });
    return g;
  }


  function buildAnimaticGraph(videoNames, withAudio) {
    const { g, add } = makeGraphBuilder();
    const comps = videoNames.map(n => add("GetVideoComponents", { video: [add("LoadVideo", { file: n }), 0] }));
    let imgs = [comps[0], 0];
    for (let k = 1; k < comps.length; k++) imgs = [add("ImageBatch", { image1: imgs, image2: [comps[k], 0] }), 0];
    const inputs = { images: imgs, fps: LTX25_FPS, bit_depth: 8 };
    if (withAudio) {
      let aud = [comps[0], 1];
      for (let k = 1; k < comps.length; k++) aud = [add("AudioConcat", { audio1: aud, audio2: [comps[k], 1], direction: "after" }), 0];
      inputs.audio = aud;
    }
    const cv = add("CreateVideo", inputs);
    add("SaveVideo", { video: [cv, 0], filename_prefix: "studio/story/animatic", format: "auto", codec: "auto" });
    return g;
  }


  async function resolveImageJob(promptId) {
    const entry = (await waitForJobs([promptId]))[promptId];
    const file = outputFiles(entry, ".png")[0];
    const up = await reupload(file);
    return { ...up, file };
  }

  async function uploadBlob(blob, name) {
    const fd = new FormData();
    fd.append("image", new File([blob], name, { type: blob.type || "image/png" }));
    fd.append("overwrite", "false");
    const res = await fetch(`${COMFY}/upload/image`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(`Upload de "${name}" refusé par ComfyUI.`);
    const d = await res.json();
    return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
  }

  // URL de lecture directe d'un fichier de sortie ComfyUI (vignette/lecteur, pas de blob).
  function viewURL(f) {
    return `${COMFY}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${f.type || "output"}`;
  }

  // ── Couche paramétrée : ce que index.html lisait dans le DOM devient un argument ──────

  // submitGraph : `clientId` était une constante globale de page et le suivi passait par
  // trackJob()/addEvent() (éléments DOM fixes). Ici clientId est un paramètre et le suivi
  // est un callback optionnel `onEvent(code, text, cls)`.
  async function submitGraph(graph, label, sub, clientId, onEvent) {
    const res = await fetch(`${COMFY}/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId })
    });
    const data = await res.json();
    if (!res.ok || data.error)
      throw new Error(`ComfyUI a rejeté le job : ${data.error?.message || JSON.stringify(data.node_errors || data).slice(0, 300)}`);
    if (onEvent) onEvent("REQ", `Job soumis : ${label}.`, "req");
    return data.prompt_id;
  }

  // ── Progression WebSocket ComfyUI (best-effort, purement cosmétique) ────────────────
  // Porté d'ai-content-studio-cockpit (« ComfyUI WebSocket + jobs »). UNE connexion, UN
  // clientId — celui-ci, LA seule déclaration du projet côté canvas : nodes-simple.js et
  // nodes-advanced.js en avaient chacun un, si bien qu'un socket ouvert avec l'un n'aurait
  // jamais reçu la progression des jobs soumis avec l'autre.
  // Ce flux ne sert QU'À alimenter `node.progress` (0-100) pendant qu'un job tourne : la
  // détection de complétion reste entièrement à waitForJobs() (polling /history), inchangée.
  const clientId = crypto.randomUUID();
  const jobNodes = {};   // prompt_id -> nœud litegraph à faire progresser
  // Socket ouverte au premier job suivi, pas au chargement : le Studio charge aussi ce fichier
  // et a déjà la sienne (la progression d'un tout premier job peut donc être manquée).
  function registerJob(promptId, node) { if (!ws) connectWS(); if (node) jobNodes[promptId] = node; }

  function handleWS(msg) {
    const d = (msg && msg.data) || {};
    const node = jobNodes[d.prompt_id];
    if (!node) return;   // message d'un job qu'on ne suit pas : ignoré
    if (msg.type === "progress" && d.max) {
      node.progress = Math.round((d.value / d.max) * 100);
      node.setDirtyCanvas(true, true);
    } else if (msg.type === "execution_success" || msg.type === "execution_error" || msg.type === "execution_interrupted") {
      node.progress = null;
      node.setDirtyCanvas(true, true);
      delete jobNodes[d.prompt_id];   // job terminé, plus rien à suivre
    }
  }

  let ws = null;
  function connectWS() {
    try {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${COMFY}/ws?clientId=${clientId}`);
    } catch (e) { return; }   // hors navigateur (tests Node) : pas de socket, rien à suivre
    ws.onclose = () => setTimeout(connectWS, 4000);
    ws.onmessage = e => {
      if (typeof e.data !== "string") return;
      let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
      handleWS(msg);
    };
  }

  // Fiches gemma : `brief.value` devient l'argument `scene`, addEvent() devient onEvent.
  // Porté du Studio (piège n°17) : gemma tranche `kind` (human / other) et renseigne le jeu
  // de champs de ce kind, plus un `label` court (onglets, jamais compilé dans le prompt).
  async function characterSheetFromBrief(scene, onEvent) {
    try {
      const out = await gemmaJSON(
        `You are a character designer. From the user's scene, take the SINGLE most prominent character or subject and describe it so it stays IDENTICAL across shots. It can be anything: a human being, an animal, an imaginary creature, a robot or machine of any shape, an alien, a vehicle, a plant or an inanimate object. FIRST set "kind": "human" only for a human being, "other" for everything else. THEN use the field set of that kind, each value a dense ~10-20 word English string, no camera/scene/action wording. Also set "label": a plain 2-to-4-word name for this subject that tells it apart from other subjects of the same scene, e.g. "weary detective", "young farmhand", "adult male lion", "six-legged mining robot". If kind is "human", answer ONLY with JSON {"kind":"human","label":"...","face":"...","hair":"...","outfit":"...","accessories":"...","palette":"..."}. If kind is "other", answer ONLY with JSON {"kind":"other","label":"...","subject":"what it is, in its own terms: type or species, and how many limbs, heads, wheels or parts it has, e.g. adult male African lion, four-legged big cat, or six-legged insect-like mining robot","form":"its silhouette, structure, proportions and natural resting posture","surface":"what its body is made of and how it looks: fur, scales, skin, bark, metal, glass, worn paint","details":"the distinctive parts and marks that identify it","palette":"..."}. When kind is "other", describe it strictly as the thing it is: give it no human face, no human hair, no clothing and no human stance unless the user's scene explicitly says so.`,
        scene);
      // Le squelette se décide sur les champs que gemma a REMPLIS, pas sur l'étiquette `kind`
      // qu'il annonce (il décrit régulièrement un lion dans {subject, form, surface} en se
      // déclarant "human", et l'inverse). `palette`, commune aux deux jeux, ne départage rien ;
      // `kind` ne sert que d'arbitre à égalité.
      const filledCount = keys => keys.filter(k => k !== "palette" && fieldText(out[k])).length;
      const nHuman = filledCount(CHAR_FIELD_KEYS), nOther = filledCount(CHAR_OTHER_FIELD_KEYS);
      const fields = { kind: nOther > nHuman ? "other" : nHuman > nOther ? "human"
                             : (out.kind === "human" ? "human" : "other") };
      fields.label = fieldText(out.label);
      for (const k of charFieldKeys(fields)) fields[k] = fieldText(out[k]);
      // Une fiche réduite à la palette ne décrit aucun sujet : repli sur le brief.
      if (filledCount(charFieldKeys(fields))) { if (onEvent) onEvent("OK", `Fiche personnage générée par ${OLLAMA_MODEL}.`, "ok"); return fields; }
      throw new Error("aucun champ descriptif rempli");
    } catch (e) {
      if (onEvent) onEvent("WARN", `Fiche personnage LLM indisponible (${e.message}) — brief utilisé tel quel.`, "warn");
      return { face: scene, hair: "", outfit: "", accessories: "", palette: "" };
    }
  }

  async function locationSheetFromBrief(scene, onEvent) {
    try {
      const out = await gemmaJSON(
        `You are a location designer. From the user's scene, take the SINGLE main location/setting and describe it so the environment stays IDENTICAL across shots. Answer ONLY with JSON with these fields, each a dense ~10-20 word English string, no camera/character/action wording: {"place":"...","architecture":"...","materials":"...","lighting":"...","palette":"..."}.`,
        scene);
      const fields = {};
      for (const k of LOC_FIELD_KEYS) fields[k] = fieldText(out[k]);
      if (locDescFromFields(fields)) { if (onEvent) onEvent("OK", `Fiche décor générée par ${OLLAMA_MODEL}.`, "ok"); return fields; }
      throw new Error("format inattendu");
    } catch (e) {
      if (onEvent) onEvent("WARN", `Fiche décor LLM indisponible (${e.message}) — brief utilisé tel quel.`, "warn");
      return { place: scene, architecture: "", materials: "", lighting: "", palette: "" };
    }
  }

  // `$("videoDuration").value` devient l'argument `segDur`.
  async function shotListFromBrief(scene, n, segDur, onEvent) {
    const camIds = Object.keys(CAMERA_LIB).join(", ");
    const lightIds = Object.keys(LIGHTING_LIB).join(", ");
    let shots;
    try {
      const out = await gemmaJSON(
        `You are a storyboard cinematographer. The user gives ONE scene with fixed character and setting. Break it into exactly ${n} sequential shots of THAT SAME scene. The character's appearance and the setting NEVER change — only camera, light and moment vary. For EACH shot output an object with: "camera" = EXACTLY ONE id from [${camIds}], "lighting" = EXACTLY ONE id from [${lightIds}], "action" = short English description of what the single main character (exactly one subject in frame, a person, an animal, a creature, a machine or an object) is doing (~8-14 words), "emotion" = one or two words for the mood/expression. Answer ONLY with JSON: {"shots": [ {"camera":"...","lighting":"...","action":"...","emotion":"..."}, ... ]} with exactly ${n} entries.`,
        scene);
      shots = normalizeShotList(out.shots, n, scene);
      if (onEvent) onEvent("OK", `${n} plans Scene DNA (caméra/lumière/action) générés par ${OLLAMA_MODEL}.`, "ok");
    } catch (e) {
      if (onEvent) onEvent("WARN", `Shot list LLM indisponible (${e.message}) — presets de secours utilisés.`, "warn");
      shots = fallbackShots(n, scene);
    }
    return shots.map(s => ({
      camera: s.camera, lighting: s.lighting, action: s.action, emotion: s.emotion || "",
      duration: segDur, extra: ""
    }));
  }

  // Jobs storyboard : mêmes graphes/prompts, paramètres reçus en objet.
  async function submitCharsheetJob(p) {
    return submitGraph(buildCharsheetGraph(p.charDesc, p.negative, p.seed, p.width, p.height, p.styleId, p.lora, p.kind, p.templateId),
      "Storyboard · fiche personnage", `${p.modelLabel} · charsheet · seed ${p.seed}`, p.clientId, p.onEvent);
  }
  async function submitLocsheetJob(p) {
    return submitGraph(buildLocsheetGraph(p.locDesc, p.negative, p.seed, p.width, p.height, p.styleId, p.lora),
      "Storyboard · fiche décor", `${p.modelLabel} · locsheet · seed ${p.seed}`, p.clientId, p.onEvent);
  }
  async function submitKeyframeJob(p) {
    const g = buildGraph(p.anchorRaw, {
      prompt: compileKeyframePrompt(p.shot, p.charDesc, p.locDesc, p.styleId), negative: p.negative,
      seed: p.seed, image: p.charName, image2: p.locName, width: p.width, height: p.height, batch: 1
    });
    // AJOUT Lot 5 (strictement additif) : 3ᵉ fiche optionnelle. Sans `p.image3Name`,
    // le graphe produit est bit-à-bit celui d'avant.
    if (p.image3Name) addQwenImage3(g, p.image3Name);
    for (const node of Object.values(g))
      if (node.class_type === "SaveImage") node.inputs.filename_prefix = `studio/story/key_${String(p.idx + 1).padStart(2, "0")}`;
    return submitGraph(g, `Storyboard · keyframe ${p.idx + 1}/${p.total}`, `Qwen-Edit ancré · seed ${p.seed}`, p.clientId, p.onEvent);
  }
  async function submitGridJob(p) {
    const { g: gridG, add: gridAdd } = makeGraphBuilder();
    const refs = p.keys.map(k => [gridAdd("LoadImage", { image: k.name }), 0]);
    gridAdd("SaveImage", { images: addGrid(gridAdd, refs), filename_prefix: "studio/story/grid" });
    return submitGraph(gridG, "Storyboard · grille", `contact-sheet ${p.keys.length} cases`, p.clientId, p.onEvent);
  }
  async function submitCutJob(p) {
    const sz = videoSizeFor(await imageSize(p.keyObj.blob));
    const g = buildGraph(p.i2vRaw, {
      prompt: compileCutPrompt(p.shot, p.charDesc, p.locDesc, p.holdMotion, p.styleId), negative: p.negative,
      seed: p.seed, image: p.keyObj.name, width: sz.w, height: sz.h, batch: 1, duration: p.duration
    });
    for (const node of Object.values(g))
      if (node.class_type === "SaveVideo") node.inputs.filename_prefix = `studio/story/cut_${String(p.idx + 1).padStart(2, "0")}`;
    return submitGraph(g, `Storyboard · cut ${p.idx + 1}/${p.total}`,
      `LTX 2.5 i2v · ${p.duration}s · ${sz.w}x${sz.h} · seed ${p.seed}`, p.clientId, p.onEvent);
  }
  async function submitAnimaticJob(p) {
    return submitGraph(buildAnimaticGraph(p.cutNames, p.withAudio), "Storyboard · animatic (assemblage)",
      `${p.cutNames.length} cuts francs · ${p.withAudio ? "audio" : "muet"} · fps 24 · seed ${p.seed}`, p.clientId, p.onEvent);
  }

    global.Engine = {
      COMFY, OLLAMA, OLLAMA_MODEL,
      // construction de graphes
      buildGraph, makeGraphBuilder, getTemplate,
      buildCharsheetGraph, buildLocsheetGraph, buildAnimaticGraph,
      addKrea2Shared, addKrea2Shot, addGrid, applyMinimaxTurbo, applyMinimaxLastFrame,
      addMinimaxRefs, addQwenImage3,   // AJOUT Lot 5 : références additionnelles r2v / 3ᵉ fiche storyboard
      addQwen21Refs,   // AJOUT LOT Qwen21 : références additionnelles Qwen Image 2.1 (Canvas)
      addH3StyleLora,   // LoRA de style Minimax H3, cumulable avec applyMinimaxTurbo (appeler APRÈS)
      // prompts / libs
      CAMERA_LIB, LIGHTING_LIB, STYLE_PACKS, KREA2_LORAS, H3_STYLE_LORAS, SHEET_CLEAN,
      fetchLoraOptions, loraLabel, H3_TURBO_LORAS,   // découverte LoRA, partagée avec le Studio
      styleTextFor, compileKeyframePrompt, compileCutPrompt,
      // I13 : corrections de prompt du Studio (planches selon le sujet, ancrages keyframe,
      // grammaire Minimax H3) — dépendances en arguments, prêtes pour le Studio et le Canvas
      SHEET_TEMPLATES, charsheetPromptFrom, charKindOf, KEYFRAME_ANCHOR_SOLO, KEYFRAME_ANCHOR_DUAL,
      stripPromptPadding, KREA2_ENRICH_SYSTEM,
      h3AssignSubjects, h3Summary, h3RefBody, buildH3RefPrompt, capH3Prompt,
      h3Alignment, h3VideoFrames, h3RealDuration, h3CutSubjects, buildH3CutPrompt, compileCutPromptFor,
      // LLM
      gemmaJSON, characterSheetFromBrief, locationSheetFromBrief, shotListFromBrief,
      charDescFromFields, locDescFromFields,
      // ComfyUI I/O
      submitGraph, waitForJobs, outputFiles, extractFiles, reupload, uploadBlob, viewURL,
      // progression WebSocket : clientId partagé + enregistrement prompt_id -> nœud
      clientId, registerJob,
      imageSize, videoSizeFor, resolveImageJob,
      // résolution mégapixels (LTX 2.5 / Minimax H3) — porté de ai-content-studio-cockpit
      computeMPResolution, mpUnitForEngine, MP_VALUES,
      // jobs storyboard
      submitCharsheetJob, submitLocsheetJob, submitKeyframeJob, submitGridJob, submitCutJob, submitAnimaticJob
    };
  })(typeof window !== "undefined" ? window : globalThis);
