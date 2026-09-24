// canvas-gallery.js — tiroir de galerie pour le mode Canvas (canvas.html).
//
// Affiche le contenu de l'historique ComfyUI (dossier `output`), exactement comme la
// galerie du mode Studio (index.html : preloadGallery/addAsset/persistAsset/
// restoreGallery), mais en version tiroir bas-d'écran et simplifiée : pas de
// suppression, pas de regroupement par dossier, pas de prompts sauvegardés — juste
// les vignettes récentes, cliquables, réparties en deux onglets Images/Vidéos (même
// principe que .gallery-tabs/switchGalleryTab dans index.html), qui persistent au
// rechargement et peuvent être glissées sur une carte "Import média" du canvas.
//
// Fichier autonome (même principe que js/update-check.js) : injecte son propre <style>
// et son propre DOM, ne touche à rien d'existant dans canvas.html. Réutilise
// Engine.COMFY / Engine.viewURL / Engine.extractFiles (js/engine.js) au lieu de dupliquer
// cette logique.
(function () {
  // Ce fichier s'exécute AVANT `window.tr = tr` (canvas.html) : les libellés du tiroir sont posés en français,
  // en nœuds texte séparés, et traduits par translateTree(document.body) (à chaque changement de langue).
  // `T` ne sert qu'aux textes créés plus tard (dépôt sur une carte), quand `window.tr` existe.
  const T = (s) => (window.tr ? window.tr(s) : s);

  // ── Style ────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    #cgDrawer{position:fixed;left:0;right:0;bottom:0;width:100%;height:40px;z-index:30;
      display:flex;flex-direction:column;overflow:hidden;
      background:var(--card);backdrop-filter:blur(14px);
      border-top:1px solid var(--border);border-radius:var(--radius) var(--radius) 0 0;
      box-shadow:0 -8px 30px var(--shadow);
      transition:height .25s ease;}
    #cgDrawer.expanded{height:22vh;max-height:25vh;}
    #cgHandle{flex:0 0 40px;width:100%;display:flex;align-items:center;justify-content:center;
      gap:8px;border:none;background:transparent;cursor:pointer;font:inherit;
      font-weight:600;font-size:12px;color:var(--text);}
    #cgHandle:hover{color:var(--brand);}
    #cgHandle .cg-chevron{color:var(--text-2);display:inline-block;transition:transform .25s ease;}
    #cgDrawer.expanded #cgHandle .cg-chevron{transform:rotate(180deg);}
    #cgBody{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;}
    .cg-tabs{flex:0 0 auto;display:flex;gap:6px;padding:8px 14px 6px;}
    .cg-tab{border:1px solid var(--border);background:var(--card-2);color:var(--text-2);
      border-radius:var(--radius);padding:5px 12px;font:inherit;font-size:12px;font-weight:600;
      cursor:pointer;}
    .cg-tab:hover{color:var(--text);}
    .cg-tab.active{background:var(--accent-soft);border-color:var(--brand);color:var(--brand);}
    .cg-tray{flex:1 1 auto;min-height:0;overflow-x:auto;overflow-y:hidden;
      display:flex;align-items:center;gap:10px;padding:0 14px 10px;}
    .cg-tray .cg-thumb{height:100%;width:auto;flex:0 0 auto;cursor:pointer;
      background:var(--disabled);border:1px solid var(--border);border-radius:8px;
      object-fit:cover;display:block;}
    #cgHandle:focus-visible,.cg-tab:focus-visible,.cg-thumb:focus-visible{outline:2px solid var(--brand);outline-offset:2px;}
  `;
  document.head.appendChild(style);

  // ── DOM ──────────────────────────────────────────────────────────────────
  const drawer = document.createElement("div");
  drawer.id = "cgDrawer";
  drawer.innerHTML = `
    <div id="cgBody">
      <div class="cg-tabs">
        <button class="cg-tab active" id="cgTabImages" type="button" data-tab="images"><span>Images</span> <span class="cg-n">(0)</span></button>
        <button class="cg-tab" id="cgTabVideos" type="button" data-tab="videos"><span>Vidéos</span> <span class="cg-n">(0)</span></button>
      </div>
      <div id="cgTrayImages" class="cg-tray"></div>
      <div id="cgTrayVideos" class="cg-tray" style="display:none"></div>
    </div>
    <button id="cgHandle" type="button" aria-expanded="false">
      <span>Galerie</span>
      <span class="cg-chevron">▲</span>
    </button>
  `;
  document.body.appendChild(drawer);
  const handle = drawer.querySelector("#cgHandle");
  const tabImages = drawer.querySelector("#cgTabImages");
  const tabVideos = drawer.querySelector("#cgTabVideos");
  const trayImages = drawer.querySelector("#cgTrayImages");
  const trayVideos = drawer.querySelector("#cgTrayVideos");

  // ── Onglets Images/Vidéos ────────────────────────────────────────────────
  const counts = { images: 0, videos: 0 };
  function switchTab(tab) {
    tabImages.classList.toggle("active", tab === "images");
    tabVideos.classList.toggle("active", tab === "videos");
    trayImages.style.display = tab === "images" ? "" : "none";
    trayVideos.style.display = tab === "videos" ? "" : "none";
  }
  tabImages.addEventListener("click", () => switchTab("images"));
  tabVideos.addEventListener("click", () => switchTab("videos"));
  function bumpCount(isVideo) {
    counts[isVideo ? "videos" : "images"]++;
    tabImages.querySelector(".cg-n").textContent = `(${counts.images})`;
    tabVideos.querySelector(".cg-n").textContent = `(${counts.videos})`;
  }

  // ── Données / persistance (clé localStorage dédiée, distincte de Studio) ──
  const STORE_KEY = "canvasGalleryAssets";
  const seenAssets = new Set();
  // Valeur illisible (JSON cassé, pas un tableau, entrées sans nom de fichier) : galerie vide, sans exception.
  const galleryAssets = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(v) ? v.filter(a => a && typeof a.filename === "string") : [];
    } catch { return []; }
  })();

  function persistAsset(f, label) {
    const k = `${f.subfolder || ""}/${f.filename}`;
    const entry = { filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output", label };
    const out = [entry], seen = new Set([k]);
    for (const a of galleryAssets) {
      const ak = `${a.subfolder}/${a.filename}`;
      if (seen.has(ak)) continue;
      seen.add(ak); out.push(a);
    }
    galleryAssets.length = 0; galleryAssets.push(...out.slice(0, 200));
    // Quota plein ou stockage bloqué : la galerie de la session continue, seule la persistance est perdue.
    try { localStorage.setItem(STORE_KEY, JSON.stringify(galleryAssets)); }
    catch (e) { console.warn("Galerie : sauvegarde impossible", e); }
  }

  // Glisser-déposer vers une carte "Import média" du canvas : pose dans le
  // dataTransfer le fichier ComfyUI {filename, subfolder, type} déjà utilisé pour
  // construire l'URL de la vignette — pas de blob, le fichier est déjà côté serveur.
  function addAssetCard(f, url, isVideo) {
    const el = document.createElement(isVideo ? "video" : "img");
    el.className = "cg-thumb";
    el.src = url;
    el.title = f.filename;
    if (isVideo) { el.controls = true; el.muted = true; el.playsInline = true; }
    else el.alt = f.filename;
    const open = () => window.open(url, "_blank");
    el.addEventListener("click", open);
    if (!isVideo) {   // une <img> n'est pas atteignable au clavier : bouton nommé, Entrée et Espace = clic (une <video controls> l'est déjà)
      el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-label", f.filename);
      el.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
    }
    el.draggable = true;
    el.addEventListener("dragstart", (event) => {
      const payload = { filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" };
      event.dataTransfer.setData("application/json", JSON.stringify(payload));
      event.dataTransfer.effectAllowed = "copy";
    });
    (isVideo ? trayVideos : trayImages).prepend(el);
    bumpCount(isVideo);
  }

  function addAsset(f, label, persist = true) {
    if (/\.(mp3|wav|opus|flac|ogg)$/i.test(f.filename)) return; // pistes audio seules : pas de vignette
    const key = `${f.subfolder || ""}/${f.filename}`;
    if (seenAssets.has(key)) return;
    seenAssets.add(key);
    if (persist) persistAsset(f, label);
    addAssetCard(f, Engine.viewURL(f), /\.(mp4|webm|mov)$/i.test(f.filename));
  }

  function restoreGallery() {
    for (const a of galleryAssets) addAsset(a, a.label, false);
  }

  async function preloadGallery() {
    try {
      const h = await (await fetch(`${Engine.COMFY}/history?max_items=24`)).json();
      for (const entry of Object.values(h)) {
        if (!entry.status?.completed) continue;
        for (const nodeOut of Object.values(entry.outputs || {}))
          for (const f of Engine.extractFiles(nodeOut)) addAsset(f, "Historique");
      }
    } catch {} // ComfyUI temporairement indisponible : silence, comme index.html
  }

  // ── Ouverture/fermeture + rafraîchissement périodique (tiroir ouvert seulement) ──
  let refreshTimer = null;
  handle.addEventListener("click", () => {
    const open = !drawer.classList.contains("expanded");
    drawer.classList.toggle("expanded", open);
    handle.setAttribute("aria-expanded", String(open));
    if (open) {
      preloadGallery();
      if (!refreshTimer) refreshTimer = setInterval(preloadGallery, 8000);
    } else if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  });

  restoreGallery();
  preloadGallery();

  // ── Glisser-déposer vers une carte "Import média" posée sur le canvas ──────
  // Le fichier est déjà sur le disque ComfyUI (vignette de la galerie) : on adopte
  // directement outFile/src sur le nœud sous le point de dépôt, sans repasser par
  // E.uploadBlob/importFile (pas de ré-upload). Écoute posée sur le <canvas> DOM
  // lui-même (#lgcanvas), qui couvre tout le viewport (#stage{position:fixed;inset:0}).
  const canvasEl = document.getElementById("lgcanvas");
  if (canvasEl) {
    canvasEl.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    canvasEl.addEventListener("drop", (event) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData("application/json");
      if (!raw) return;
      let file;
      try { file = JSON.parse(raw); } catch { return; }
      if (!file || !file.filename) return;

      const C = window.__canvas;
      if (!C || !C.graph || !C.lgcanvas) return;
      const { graph, lgcanvas } = C;

      // screen = (graphPos + offset) * scale  ⇒  graphPos = screen / scale - offset
      // (même transformation que syncOverlays() dans canvas.html, inversée).
      const rect = canvasEl.getBoundingClientRect();
      const s = lgcanvas.ds.scale;
      const ox = lgcanvas.ds.offset[0], oy = lgcanvas.ds.offset[1];
      const graphX = (event.clientX - rect.left) / s - ox;
      const graphY = (event.clientY - rect.top) / s - oy;

      let node = null;
      if (typeof graph.getNodeOnPos === "function") {
        node = graph.getNodeOnPos(graphX, graphY);
      } else {
        for (const n of graph._nodes) {
          if (graphX >= n.pos[0] && graphX <= n.pos[0] + n.size[0] &&
              graphY >= n.pos[1] && graphY <= n.pos[1] + n.size[1]) { node = n; break; }
        }
      }
      if (!node || node.type !== "simple/import") return;

      node.properties.outFile = { filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" };
      node.properties.filename = file.filename;
      node.properties.src = Engine.viewURL(node.properties.outFile);
      node.buildOverlay();
      node.status = "done";
      node.statusMsg = T("Depuis la galerie");
      node.boxcolor = "#2a7d2a"; node.color = "#2a7d2a"; // STATUS_COLOR.done (nodes-simple.js)
      node.setDirtyCanvas(true, true);
      window.__canvas.save();
    });
  }
})();
