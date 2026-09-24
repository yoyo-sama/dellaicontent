// Vérifie au chargement si une mise à jour git est disponible et propose de l'installer.
// Backend : GET update/status -> {updateAvailable, localSha, remoteSha}
//           POST update/apply -> {success, error?}
// Chemins relatifs (pas de "/" initial) pour rester compatibles avec un préfixe de proxy.
// Ensuite (une fois l'app à jour) : si ComfyUI est plus ancien que workflows/manifest.json
// "comfyui.min", propose de le mettre à jour via le ComfyUI-Manager (proxy nginx /comfy/) :
// POST v2/manager/queue/update_comfyui?stable=true -> queue/start -> GET queue/status -> POST reboot.
(function () {
  const T = (s) => (window.tr ? window.tr(s) : s);
  let reloading = false;

  function checkForUpdate() {
    return fetch("update/status")
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.updateAvailable !== true) return;
        if (!confirm(T("Une mise à jour est disponible. L'installer maintenant ?"))) return;
        return applyUpdate();
      })
      .catch(() => {}); // service updater absent/down : ne rien afficher
  }

  function applyUpdate() {
    return fetch("update/apply", { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.success === true) {
          if (confirm(T("Mise à jour installée. Rafraîchir la page maintenant ?"))) {
            reloading = true;
            location.reload();
          }
        } else {
          alert(T("Échec de la mise à jour : ") + ((data && data.error) || "erreur inconnue"));
        }
      })
      .catch(() => {
        alert(T("Échec de la mise à jour : ") + "erreur inconnue");
      });
  }

  // ── ComfyUI trop ancien ──────────────────────────────────────────────
  const CM = "comfy/v2/manager/";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const semver = (s) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s)); // tolère "v" initial et suffixe
    return m && m.slice(1).map(Number);
  };
  const older = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const fetchT = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const getJSON = (url) =>
    fetchT(url, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(url + " : HTTP " + r.status);
      return r.json();
    });
  const comfyVersion = () => getJSON("comfy/system_stats").then((s) => s && s.system && s.system.comfyui_version);
  // Rappelle fn() toutes les `every` ms jusqu'à une valeur vraie ; null au bout de `total` ms (jamais de boucle infinie).
  async function until(fn, total, every) {
    for (const end = Date.now() + total; Date.now() < end; await sleep(every)) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {} // réseau : ComfyUI en cours de redémarrage, on réessaie
    }
    return null;
  }

  async function checkComfyVersion() {
    if (reloading) return;
    try {
      if (sessionStorage.getItem("comfyUpdateDeclined")) return;
    } catch (e) {}
    let cur, min;
    try {
      const m = await getJSON("workflows/manifest.json");
      min = m && m.comfyui && m.comfyui.min;
      if (!semver(min)) return;
      cur = await comfyVersion();
      if (!semver(cur)) return;
    } catch (e) {
      return; // manifest sans clé, ComfyUI injoignable ou sans version : silence
    }
    if (!older(semver(cur), semver(min))) return;
    if (!confirm(T(`ComfyUI est en version ${cur}, mais la version minimale attendue est ${min} : certains modèles exigent une version plus récente de ComfyUI.\n\nVeux-tu le mettre à jour maintenant vers le dernier stable ?\n\nAttention : la mise à jour redémarre ComfyUI (environ 30 s) et interrompt les jobs en cours.`))) {
      try {
        sessionStorage.setItem("comfyUpdateDeclined", "1");
      } catch (e) {}
      return;
    }
    const back = `git -C ~/comfyui-spark/run/ComfyUI checkout v${semver(cur).join(".")} && docker restart comfyui-nvidia`;
    let updated = false;
    try {
      const q = await getJSON("comfy/queue");
      if (!q || !Array.isArray(q.queue_running) || !Array.isArray(q.queue_pending)) throw new Error("réponse inattendue de /queue");
      if (q.queue_running.length || q.queue_pending.length) {
        alert(T("ComfyUI a des jobs en cours ou en attente : la mise à jour le redémarrerait et les interromprait. Réessaie quand la file est vide."));
        return;
      }
      const id = "acs-" + Date.now(); // client_id et ui_id (requis par le Manager)
      let r = await fetchT(`${CM}queue/update_comfyui?client_id=${id}&ui_id=${id}&stable=true`, { method: "POST" });
      if (!r.ok) throw new Error("queue/update_comfyui : HTTP " + r.status);
      r = await fetchT(CM + "queue/start", { method: "POST" }); // 200 démarré, 201 déjà en cours
      if (!r.ok) throw new Error("queue/start : HTTP " + r.status);
      const idle = await until(async () => {
        const s = await getJSON(CM + "queue/status");
        return s.is_processing === false && s.total_count === 0;
      }, 600000, 3000);
      if (!idle) throw new Error("le Manager n'a pas fini la mise à jour au bout de 10 min");
      // Le statut d'une tâche update_comfyui vaut "error" même en cas de succès : seul `result` fait foi.
      const h = (await getJSON(CM + "queue/history?ui_id=" + id)).history;
      const res = h && h.result;
      if (res === "skip") throw new Error(`ComfyUI est déjà au dernier stable (${cur}), qui est inférieur au minimum ${min}`);
      if (typeof res !== "string" || !res.startsWith("success")) throw new Error("échec de la mise à jour côté Manager (" + res + ")");
      updated = true; // l'ancien code est parti : à partir d'ici on rappelle le retour arrière
      const rb = await fetchT(CM + "reboot", { method: "POST" }).catch(() => null); // la connexion tombe : normal
      if (rb && rb.status < 500 && !rb.ok) throw new Error("reboot : HTTP " + rb.status);
      const now = await until(async () => {
        const v = await comfyVersion();
        return v && v !== cur && v;
      }, 180000, 3000);
      if (!now) throw new Error("ComfyUI ne répond pas (ou toujours en " + cur + ") 3 min après le redémarrage : vérifie `docker logs comfyui-nvidia`");
      alert(T(`ComfyUI est passé de la version ${cur} à la version ${now}.` + (older(semver(now), semver(min)) ? ` Attention : c'est encore inférieur au minimum ${min}.` : "") + `\n\nPour revenir en arrière :\n${back}`));
    } catch (e) {
      alert(T("Mise à jour de ComfyUI impossible : ") + e.message + (updated ? T("\n\nPour revenir à l'ancienne version :\n") + back : ""));
    }
  }

  function run() {
    checkForUpdate().then(checkComfyVersion);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
