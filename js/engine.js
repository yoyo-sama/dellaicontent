// engine.js — logique de génération de `index.html` extraite en fonctions paramétrées.
//
// EXTRACTION, PAS REFACTOR : `index.html` est inchangé et reste fonctionnel tel quel.
// Ce fichier duplique la même logique métier (templates, substitutions, ordre des appels
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
      '"{{FRAMES}}"': String((p.duration || 5) * (p.fps || 25) + 1),
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
    const loraEntry = Object.entries(graph).find(([, n]) => n.class_type === "LoraLoaderModelOnly");
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
  // retrouve LUI-MÊME son nœud LoraLoaderModelOnly par class_type (le premier trouvé dans le
  // graphe) pour le retirer ou changer son fichier ; appelé avant addH3StyleLora, tout irait
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

  const FLF2V_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
  const LTX25_FPS = 24;   // LTX 2.5 et Minimax H3 rendent en 24 fps (LTX 2.3 était en 25).

  function makeGraphBuilder() {
    const g = {}; let id = 0;
    const add = (class_type, inputs) => { g[String(++id)] = { class_type, inputs }; return String(id); };
    return { g, add };
  }

  // Ressources partagées LTX 2.5 (mêmes fichiers que workflows/api/ltx25_flf2v.json).
  // Un seul jeu de loaders pour toute la chaîne multi-segments.
  function addLtx25Shared(add) {
    const unet = add("UNETLoader", {
      unet_name: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", weight_dtype: "default"
    });
    const vae = add("VAELoader", { vae_name: "ltx-2.5-video-vae-bf16.safetensors" });
    const audioVae = add("VAELoader", { vae_name: "ltx-2.5-audio-vae-bf16.safetensors" });
    const te = add("CLIPLoader", {
      clip_name: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", type: "ltxv", device: "default"
    });
    const enhClip = add("CLIPLoader", { clip_name: "gemma4_e2b_it_bf16.safetensors", type: "ltxv", device: "default" });
    const sampler = add("SamplerEulerAncestral", { eta: 0, s_noise: 1 });
    const sigmas = add("ManualSigmas", { sigmas: FLF2V_SIGMAS });
    return { unet, vae, audioVae, te, enhClip, sampler, sigmas };
  }

  // Prompt-enhancer intégré LTX 2.5 : contrairement au 2.3, il accepte une entrée
  // image — l'ancrer sur la 1ʳᵉ image du segment évite qu'il invente une scène (piège n°9).
  function addLtx25Enhance(add, sh, prompt, seed, imageRef) {
    return [add("TextGenerateLTX2Prompt", {
      clip: [sh.enhClip, 0], prompt, max_length: 600,
      sampling_mode: "on", "sampling_mode.temperature": 0.7, "sampling_mode.top_k": 64,
      "sampling_mode.top_p": 0.95, "sampling_mode.min_p": 0.05,
      "sampling_mode.repetition_penalty": 1.15, "sampling_mode.seed": seed,
      "sampling_mode.presence_penalty": 0, image: imageRef, thinking: false, use_default_template: true
    }), 0];
  }

  // Chaîne FLF2V LTX 2.5 : imageRefs = [nodeId, slot][], un prompt de transition par
  // segment. Le bloc de sampling est celui de api/ltx25_flf2v.json (guider dual-CFG,
  // audio natif) répété par segment ; images concaténées ImageBatch, audio AudioConcat.
  function addFLF2VChain(add, sh, imageRefs, durations, promptTexts, negText, seed, width, height, withAudio) {
    const negEnc = add("CLIPTextEncode", { text: negText, clip: [sh.te, 0] });
    const decoded = [], audios = [];
    for (let k = 0; k < imageRefs.length - 1; k++) {
      const frames = 8 * Math.max(1, Math.round((durations[k] * LTX25_FPS - 1) / 8)) + 1;
      const p1 = add("LTXVPreprocess", { image: imageRefs[k], img_compression: 18 });
      const p2 = add("LTXVPreprocess", { image: imageRefs[k + 1], img_compression: 18 });
      const pos = add("CLIPTextEncode", {
        text: addLtx25Enhance(add, sh, promptTexts[k], seed + k, [p1, 0]), clip: [sh.te, 0]
      });
      const cond = add("LTXVConditioning", { positive: [pos, 0], negative: [negEnc, 0], frame_rate: LTX25_FPS });
      const lat = add("EmptyLTXVLatentVideo", { width, height, length: frames, batch_size: 1 });
      const g1 = add("LTXVAddGuide", {
        positive: [cond, 0], negative: [cond, 1], vae: [sh.vae, 0],
        latent: [lat, 0], image: [p1, 0], frame_idx: 0, strength: 0.7
      });
      const g2 = add("LTXVAddGuide", {
        positive: [g1, 0], negative: [g1, 1], vae: [sh.vae, 0],
        latent: [g1, 2], image: [p2, 0], frame_idx: -1, strength: 0.7
      });
      const noise = add("RandomNoise", { noise_seed: seed + k });
      const guider = add("LTXVDualCFGGuider", {
        model: [sh.unet, 0], positive: [g2, 0], negative: [g2, 1], video_cfg: 1, audio_cfg: 1
      });
      let samplerInput = [g2, 2], videoLatent;
      if (withAudio) {
        const aLat = add("LTXVEmptyLatentAudio", {
          frames_number: frames, frame_rate: LTX25_FPS, batch_size: 1, audio_vae: [sh.audioVae, 0]
        });
        samplerInput = [add("LTXVConcatAVLatent", { video_latent: [g2, 2], audio_latent: [aLat, 0] }), 0];
      }
      const sca = add("SamplerCustomAdvanced", {
        noise: [noise, 0], guider: [guider, 0], sampler: [sh.sampler, 0], sigmas: [sh.sigmas, 0], latent_image: samplerInput
      });
      if (withAudio) {
        const sep = add("LTXVSeparateAVLatent", { av_latent: [sca, 1] });
        videoLatent = [sep, 0];
        audios.push(add("LTXVAudioVAEDecode", { samples: [sep, 1], audio_vae: [sh.audioVae, 0] }));
      } else {
        videoLatent = [sca, 1];
      }
      const crop = add("LTXVCropGuides", { positive: [g2, 0], negative: [g2, 1], latent: videoLatent });
      decoded.push(add("VAEDecodeTiled", {
        samples: [crop, 2], vae: [sh.vae, 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16
      }));
    }
    let chain = decoded[0];
    for (let k = 1; k < decoded.length; k++) chain = add("ImageBatch", { image1: [chain, 0], image2: [decoded[k], 0] });
    let audioOut = null;
    if (withAudio) {
      let aChain = audios[0];
      for (let k = 1; k < audios.length; k++)
        aChain = add("AudioConcat", { audio1: [aChain, 0], audio2: [audios[k], 0], direction: "after" });
      audioOut = [aChain, 0];
    }
    return { videoImages: [chain, 0], audioOut };
  }

  function addVideoOutput(add, chain, prefix) {
    const inputs = { images: chain.videoImages, fps: LTX25_FPS, bit_depth: 8 };
    if (chain.audioOut) inputs.audio = chain.audioOut;
    const video = add("CreateVideo", inputs);
    add("SaveVideo", { video: [video, 0], filename_prefix: prefix, format: "auto", codec: "auto" });
  }

  function buildFLF2VGraph(imageNames, durations, prompt, negativeText, seed, width = 1280, height = 720, withAudio = false) {
    const { g, add } = makeGraphBuilder();
    const sh = addLtx25Shared(add);
    // Mise au format du latent (cover + crop centré) : sans ça, LTXVAddGuide
    // recadre brutalement les images dont le ratio diffère de la vidéo.
    const refs = imageNames.map(n => {
      const l = add("LoadImage", { image: n });
      return [add("ImageScale", { image: [l, 0], upscale_method: "lanczos", width, height, crop: "center" }), 0];
    });
    const chain = addFLF2VChain(add, sh, refs, durations, Array(refs.length - 1).fill(prompt),
      negativeText, seed, width, height, withAudio);
    addVideoOutput(add, chain, "studio/sequence");
    return g;
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

  // ── Tâche complète : Campagne (posters + thumbnails + teaser) ──
  function mergeGraph(g, other, prefix) {
    for (const [nid, n] of Object.entries(other)) {
      const copy = JSON.parse(JSON.stringify(n));
      for (const [k, v] of Object.entries(copy.inputs)) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && other[v[0]] !== undefined)
          copy.inputs[k] = [prefix + v[0], v[1]];
      }
      g[prefix + nid] = copy;
    }
  }
  async function buildCampaignFullGraph(prompt, negText, seed, batch, teaserDur) {
    const { g, add } = makeGraphBuilder();
    const img = addKrea2Shared(add);
    [["poster", 832, 1216, batch, "Poster composition with space for title text."],
     ["thumbnail", 1280, 720, batch, "YouTube thumbnail composition, bold and readable."],
     ["social", 1024, 1024, 1, "Square social media visual."]].forEach(([name, w, h, b, suffix], i) => {
      const dec = addKrea2Shot(add, img, `${prompt} ${suffix}`, seed + 200 + i, w, h, b);
      add("SaveImage", { images: [dec, 0], filename_prefix: `studio/campaign/${name}` });
    });
    // Teaser vertical : réutilise le template LTX 2.5 t2v validé (2 passes + upscale,
    // audio natif câblé dans le template — aucun ajout côté JS).
    const raw = await getTemplate("api/ltx25_t2v.json");
    const t2v = buildGraph(raw, {
      prompt: `${prompt} Dynamic cinematic teaser, energetic camera movement.`,
      negative: negText, seed, width: 720, height: 1280, batch: 1, duration: teaserDur
    });
    for (const n of Object.values(t2v)) if (n.class_type === "SaveVideo") n.inputs.filename_prefix = "studio/campaign/teaser";
    mergeGraph(g, t2v, "tv_");
    return g;
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
  const STYLE_PACKS = {
    none: { label: "Aucun", text: "" },
    cinematic: { label: "Cinématique",
      text: "Shot on 35mm Kodak Vision3 film, cinematic color grading, soft natural film grain, natural contrast and shallow depth of field." },
    noir: { label: "Film noir",
      text: "High-contrast black-and-white film-noir look, deep shadows, hard directional light and dramatic chiaroscuro." },
    documentary: { label: "Documentaire",
      text: "Naturalistic documentary photography look, available light, realistic muted colors and candid unposed framing." },
    anime: { label: "Anime",
      text: "Stylized Japanese anime illustration look, clean cel-shaded artwork, vivid saturated colors and expressive linework." },
  };

  // `locDesc` (texte de la fiche décor) est injecté EXACTEMENT comme dans compileCutPrompt :
  // le conditionnement image seul (planche décor en image 2) est trop souvent dominé par
  // l'image d'ancrage personnage (image 1, qui alimente aussi le VAEEncode — piège n°10),
  // et la keyframe fixe la géométrie/identité du décor pour tout le plan qui en découle.
  // Les instructions anti-collage / anti-split-screen / anti-planche-contact restent
  // inchangées (piège Qwen-Edit : aucun vocabulaire « storyboard/keyframe/contact sheet »,
  // tout formulé positivement).
  function compileKeyframePrompt(shot, charDesc, locDesc, styleId) {
    const cam = CAMERA_LIB[shot.camera] || CAMERA_LIB.medium;
    const light = LIGHTING_LIB[shot.lighting] || LIGHTING_LIB.golden_hour;
    const styleText = styleTextFor(styleId);
    const emotion = (shot.emotion || "").trim();
    const extra = (shot.extra || "").trim();
    const loc = (locDesc || "").trim();
    let s = "Use the first reference image only as the appearance guide for one single character, "
      + charDesc
      + ", and use the second reference image only as the guide for the environment"
      + (loc ? ", " + loc : "") + ". "
      + "Create one brand-new photorealistic cinematic film still that places exactly one single "
      + "instance of that character inside the environment of the second reference image: "
      + shot.action + ". Frame it as " + cam.frame + ".";
    if (emotion) s += " The character's expression and body language convey " + emotion + ".";
    s += " " + light.text;
    s += " The character is fully integrated into the scene, standing in that location with correct "
      + "perspective and scale. Do not place the two references side by side, do not create a "
      + "split screen, diptych or collage, do not show any reference sheet, contact sheet, grid, "
      + "thumbnails, multiple poses, color swatches, panels, borders, margins, black frame, caption "
      + "or text anywhere. The whole picture is a single unified live-action movie frame, one "
      + "continuous scene that extends all the way to all four edges. Keep the character's face, "
      + "hair, costume and colors identical to the first reference image.";
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

  // Mouvement de caméra figé pour la tenue du plan final (pseudo-shot du dernier plan).
  const HOLD_MOTION = "Locked camera holding on the final shot, subtle ambient motion only.";

  // Appel gemma4 mutualisé : format JSON, think:false, retry sans think sur 4xx.
  async function gemmaJSON(system, user) {
    const body = {
      model: OLLAMA_MODEL, stream: false, format: "json", think: false,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
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
    return JSON.parse((await res.json()).message.content);
  }

  // gemma renvoie parfois un objet là où on attend une chaîne → on concatène ses valeurs.
  const fieldText = v => {
    if (typeof v === "string") return v.trim();
    if (v && typeof v === "object") return Object.values(v).map(fieldText).filter(Boolean).join(", ");
    return v == null ? "" : String(v);
  };

  // Ordre canonique des champs de fiche (personnage / décor) : la jointure ", " de ces
  // champs par les helpers ci-dessous reproduit EXACTEMENT l'ancienne chaîne charDesc/locDesc.
  const CHAR_FIELD_KEYS = ["face", "hair", "outfit", "accessories", "palette"];
  const LOC_FIELD_KEYS = ["place", "architecture", "materials", "lighting", "palette"];
  function charDescFromFields(f) {
    return CHAR_FIELD_KEYS.map(k => fieldText(f?.[k])).filter(Boolean).join(", ");
  }
  function locDescFromFields(f) {
    return LOC_FIELD_KEYS.map(k => fieldText(f?.[k])).filter(Boolean).join(", ");
  }

  async function waitForJobs(promptIds) {
    const pending = new Set(promptIds), done = {};
    while (pending.size) {
      await new Promise(r => setTimeout(r, 1500));
      for (const id of [...pending]) {
        let entry;
        try { entry = (await (await fetch(`${COMFY}/history/${id}`, { cache: "no-store" })).json())[id]; }
        catch { continue; }
        if (!entry) continue;
        if (entry.status?.status_str === "error") throw new Error(`Un job ComfyUI a échoué (${id}).`);
        if (entry.status?.completed) { done[id] = entry; pending.delete(id); }
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
    const q = `filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${f.type || "output"}`;
    const blob = await (await fetch(`${COMFY}/view?${q}`)).blob();
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
  // ai-content-studio-cockpit/index.html (fonction `computeMPResolution`, cf.
  // docs/LOT-D-MEGAPIXELS.md du cockpit pour le détail du piège d'arrondi LTX 2.5 deux-
  // passes). Constante 1.045 (empirique, déjà validée) et formule INTOUCHÉES.
  function computeMPResolution(mp, ratioStr, unit) {
    unit = unit || 32;
    const [rw, rh] = ratioStr.split(":").map(Number);
    const ar = rw / rh;
    const width = Math.round(Math.sqrt(1.045 * mp * 1000000 * ar) / unit) * unit;
    const height = Math.round(Math.sqrt(1.045 * mp * 1000000 / ar) / unit) * unit;
    return [width, height];
  }
  // Équivalent de `mpUnitForWorkflow(wf)` du cockpit (qui teste `wf.id.startsWith("ltx25_")`) :
  // le canvas n'a pas de notion de "workflow id", seulement `properties.engine` sur les
  // cartes qui en exposent un ("ltx25" | "minimax_h3"). LTX 2.5 = architecture 2 passes
  // (arrondi ×64, cf. LOT-D-MEGAPIXELS.md du cockpit) ; Minimax H3 = arrondi direct ×32
  // (inchangé). `engine` absent (adv/r2v, qui n'a pas de champ "engine" et n'est jamais
  // LTX 2.5) ⇒ 32 par défaut.
  function mpUnitForEngine(engine) {
    return engine === "ltx25" ? 64 : 32;
  }
  // 14 valeurs exposées dans l'UI, mêmes valeurs pour les 2 familles de moteurs (seule
  // l'unité d'arrondi diffère) — reprises telles quelles de #megapixelsSelect du cockpit.
  const MP_VALUES = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.5, 1.8, 2.0];

  // Krea 2 route le négatif dans ConditioningZeroOut : il n'est même pas encodé (LESSONS
  // piège n°16). Les contraintes autrefois portées par CHARSHEET_NEG/LOCSHEET_NEG sont donc
  // reformulées en instructions POSITIVES ci-dessous (même parade qu'au piège n°7).
  // `negText` (champ négatif de l'UI) est conservé dans la signature mais sans effet ici.
  const SHEET_CLEAN = "One single seamless uncut photograph filling the whole frame edge to edge, completely free of any text, letters, numbers, captions, labels, annotations, watermark, signature or logo, with no drawn borders, no panel lines, no grid lines, no black frame and no comic panel divisions. Pure photography: real photographic capture, sharp focus, high detail, correct anatomy, clean seamless background.";

  // Planche personnage multi-vues (ancre d'apparence, image 1 des keyframes duales).
  // Format 16:9 large obligatoire (layout prouvé au Lot 1), indépendant du ratio UI.
  function buildCharsheetGraph(charDesc, negText, seed, width, height, styleId, loraName) {
    const { g, add } = makeGraphBuilder();
    const kx = addKrea2Shared(add, loraName);
    const styleText = styleTextFor(styleId);
    const dec = addKrea2Shot(add, kx,
      `A professional photorealistic character reference sheet of one single person, composited as a clean multi-view layout on a smooth seamless light grey studio background: ${charDesc}. Arranged neatly, the sheet shows a full-body turnaround of the same person in four standing poses evenly spaced across a row - front view, three-quarter view, side profile view, and back view - all in a neutral relaxed stance, evenly studio-lit. Above the turnaround, one large tight close-up portrait of the face. A row of several smaller close-up headshots of the face showing different facial expressions: neutral, smiling, surprised, determined. A cluster of detailed close-up photographs of costume details. Along the bottom edge, a horizontal strip of solid rectangular color swatches sampling the exact colors of the outfit and hair. Every view shows the exact same single person with identical face, hair and costume, consistent character design. ${SHEET_CLEAN}${styleText ? " " + styleText : ""}`,
      seed, 1920, 1088, 1);
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
    fd.append("overwrite", "true");
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
  function registerJob(promptId, node) { if (node) jobNodes[promptId] = node; }

  function handleWS(msg) {
    const d = (msg && msg.data) || {};
    const node = jobNodes[d.prompt_id];
    if (!node) return;   // message d'un job qu'on ne suit pas : ignoré
    if (msg.type === "progress" && d.max) {
      node.progress = Math.round((d.value / d.max) * 100);
      node.setDirtyCanvas(true, true);
    } else if (msg.type === "execution_success" || msg.type === "execution_error") {
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
  connectWS();

  // Fiches gemma : `brief.value` devient l'argument `scene`, addEvent() devient onEvent.
  async function characterSheetFromBrief(scene, onEvent) {
    try {
      const out = await gemmaJSON(
        `You are a character designer. From the user's scene, take the SINGLE most prominent character and describe them so they stay IDENTICAL across shots. Answer ONLY with JSON with these fields, each a dense ~10-20 word English string, no camera/scene/action wording: {"face":"...","hair":"...","outfit":"...","accessories":"...","palette":"..."}.`,
        scene);
      const fields = {};
      for (const k of CHAR_FIELD_KEYS) fields[k] = fieldText(out[k]);
      if (charDescFromFields(fields)) { if (onEvent) onEvent("OK", `Fiche personnage générée par ${OLLAMA_MODEL}.`, "ok"); return fields; }
      throw new Error("format inattendu");
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
        `You are a storyboard cinematographer. The user gives ONE scene with fixed character and setting. Break it into exactly ${n} sequential shots of THAT SAME scene. The character, costume and setting NEVER change — only camera, light and moment vary. For EACH shot output an object with: "camera" = EXACTLY ONE id from [${camIds}], "lighting" = EXACTLY ONE id from [${lightIds}], "action" = short English description of what the single main character (exactly one person in frame) is doing (~8-14 words), "emotion" = one or two words for the mood/expression. Answer ONLY with JSON: {"shots": [ {"camera":"...","lighting":"...","action":"...","emotion":"..."}, ... ]} with exactly ${n} entries.`,
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
    return submitGraph(buildCharsheetGraph(p.charDesc, p.negative, p.seed, p.width, p.height, p.styleId, p.lora),
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

  // Orchestrations complètes — même ordre d'appels réseau qu'index.html. Tout ce qui était
  // lu au DOM (brief, negative, shotCount, holdDuration, audioToggle, turboToggle, styleSelect,
  // videoDuration, workflow courant) arrive dans `p` ; `setAnchors` remplace setSoulAnchors().
  async function generateStoryboardV2(p) {
    const onEvent = p.onEvent;
    if (onEvent) onEvent("REQ", `Fiche personnage + fiche décor + ${p.shotCount} plans via ${OLLAMA_MODEL}…`, "req");
    const charDesc = charDescFromFields(await characterSheetFromBrief(p.brief, onEvent));
    const locDesc = locDescFromFields(await locationSheetFromBrief(p.brief, onEvent));
    const shots = await shotListFromBrief(p.brief, p.shotCount, p.segmentDuration, onEvent);

    const base = { ...p, charDesc, locDesc, modelLabel: p.modelLabel };
    const csId = await submitCharsheetJob({ ...base, seed: p.seed });
    const lsId = await submitLocsheetJob({ ...base, seed: p.seed + 101 });
    const charRef = await resolveImageJob(csId), locRef = await resolveImageJob(lsId);
    const charName = charRef.name, locName = locRef.name;
    if (p.setAnchors) p.setAnchors(charRef, locRef);

    const anchorRaw = await getTemplate(p.anchorTemplate);
    const keyIds = [];
    for (let i = 0; i < p.shotCount; i++)
      keyIds.push(await submitKeyframeJob({ ...base, anchorRaw, shot: shots[i], charName, locName,
        seed: p.seed + 11 + i, idx: i, total: p.shotCount }));
    const keyEntries = await waitForJobs(keyIds);
    const keys = [];
    for (const id of keyIds) keys.push(await reupload(outputFiles(keyEntries[id], ".png")[0]));

    await submitGridJob({ ...base, keys });

    const i2vRaw = await getTemplate("api/ltx25_i2v.json");
    const plan = shots.map((shot, k) => ({ keyObj: keys[k], shot, dur: shot.duration, holdMotion: null }));
    if (p.holdDuration > 0)
      plan.push({ keyObj: keys[keys.length - 1], shot: shots[shots.length - 1], dur: p.holdDuration, holdMotion: HOLD_MOTION });
    const cutIds = [];
    for (let k = 0; k < plan.length; k++)
      cutIds.push(await submitCutJob({ ...base, i2vRaw, keyObj: plan[k].keyObj, shot: plan[k].shot,
        holdMotion: plan[k].holdMotion, duration: plan[k].dur, seed: p.seed + 31 + k, idx: k, total: plan.length }));
    const cutEntries = await waitForJobs(cutIds);
    const cutNames = [];
    for (const id of cutIds) cutNames.push((await reupload(outputFiles(cutEntries[id], ".mp4")[0])).name);

    const animaticId = await submitAnimaticJob({ ...base, cutNames, withAudio: p.withAudio, seed: p.seed });
    return { charRef, locRef, shots, keys, cutNames, animaticId };
  }

  async function generateReference2Video(p) {
    const onEvent = p.onEvent;
    if (onEvent) onEvent("REQ", `Fiche personnage + fiche décor via ${OLLAMA_MODEL}…`, "req");
    const charDesc = charDescFromFields(await characterSheetFromBrief(p.brief, onEvent));
    const locDesc = locDescFromFields(await locationSheetFromBrief(p.brief, onEvent));

    const base = { ...p, charDesc, locDesc };
    const csId = await submitCharsheetJob({ ...base, seed: p.seed });
    const lsId = await submitLocsheetJob({ ...base, seed: p.seed + 101 });
    const charRef = await resolveImageJob(csId), locRef = await resolveImageJob(lsId);
    const charName = charRef.name, locName = locRef.name;
    if (p.setAnchors) p.setAnchors(charRef, locRef);

    const raw = await getTemplate(p.templateFile);
    const graph = buildGraph(raw, {
      prompt: `${charDesc}. ${locDesc}. ${p.brief}`, negative: p.negative,
      seed: p.seed + 201, width: p.width, height: p.height, duration: p.duration,
      image: charName, image2: locName
    });
    applyMinimaxTurbo(graph, p.turbo);
    const promptId = await submitGraph(graph, "Personnage + décor cohérents (Minimax H3 r2v)",
      `${p.modelLabel} · r2v · ${p.duration}s · ${p.turbo ? "turbo 8 steps" : "20 steps"} · seed ${p.seed}`,
      p.clientId, onEvent);
    return { charRef, locRef, promptId };
  }

    global.Engine = {
      COMFY, OLLAMA, OLLAMA_MODEL,
      // construction de graphes
      buildGraph, makeGraphBuilder, mergeGraph, getTemplate,
      buildFLF2VGraph, buildCampaignFullGraph, buildCharsheetGraph, buildLocsheetGraph, buildAnimaticGraph,
      addKrea2Shared, addKrea2Shot, addGrid, addLtx25Shared, addFLF2VChain, addVideoOutput, applyMinimaxTurbo,
      addMinimaxRefs, addQwenImage3,   // AJOUT Lot 5 : références additionnelles r2v / 3ᵉ fiche storyboard
      addH3StyleLora,   // LoRA de style Minimax H3, cumulable avec applyMinimaxTurbo (appeler APRÈS)
      // prompts / libs
      CAMERA_LIB, LIGHTING_LIB, STYLE_PACKS, KREA2_LORAS, H3_STYLE_LORAS, HOLD_MOTION, SHEET_CLEAN,
      styleTextFor, compileKeyframePrompt, compileCutPrompt,
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
      submitCharsheetJob, submitLocsheetJob, submitKeyframeJob, submitGridJob, submitCutJob, submitAnimaticJob,
      // orchestrations
      generateStoryboardV2, generateReference2Video
    };
  })(typeof window !== "undefined" ? window : globalThis);
