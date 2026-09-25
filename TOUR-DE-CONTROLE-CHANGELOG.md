# Tour de contrôle — changelog

## 2026-09-25 — Lot UX-DND : glisser-déposer galerie → entrées d'image, file de jobs repliable (Studio)

Deux demandes de l'utilisateur, `index.html` seul (`js/canvas-gallery.js` et `js/engine.js` intacts).
- **File de jobs repliable** : `<details class="job-queue" id="jobQueue">` ouvert par défaut, même apparence que « Options avancées » (CSS du
  `summary` partagé). Titre `dyn("jobQueue", n)` (n = enfants de `#jobList`, mis à jour dans `trackJob` après la purge à 8, `langSelect`, `toggle`),
  état mémorisé sous `jobQueueOpen` (localStorage sous `try/catch`), un job qui arrive n'ouvre rien, un job en erreur pendant le repli allume
  la pastille « Erreur » du `summary` jusqu'à la prochaine ouverture ; bloc masqué à vide (`.output-panel > .job-queue:has(> #jobList:empty)`).
  La clé I18N « Job Queue » (plus lue) est remplacée par l'entrée DYN.
- **Glisser-déposer** : vignettes de galerie `draggable` (`application/json` `{filename, subfolder, type}` = format du Canvas + `text/plain`), clic
  « agrandir » inchangé. `dropZone()` sur 4 zones : image d'entrée (`#imageInputWrap`, `selectedAsset` comme « → Utiliser en entrée »),
  dernière image FL2VA (`#lastImageWrap`), références (`#refDropZone` = libellé de `#refImagesInput` + `#refSubjects` ; ajout cumulatif, plafond 9
  en i2i Qwen 2.1, 7 en r2v / storyboard Qwen 2.1) et animatic FLF2V (`#seqWrap`, `addSeqImage` comme « ➕ Séquence », plafond 6). Fichiers de
  l'ordinateur (`image/*`) acceptés partout ; vidéo / non-image / dépassement refusés avec message. Hors zone : `dragover`/`drop` annulés (pas de
  navigation vers le fichier, pas de `text/plain` collé dans le brief), sauf `<input type="file">` natif (LoRA). 1 clé I18N + 8 entrées DYN neuves
  (4 langues, tutoiement), bandeau `#dropToast` aria-live, journal FR (`OK`/`WARN` neufs, messages existants inchangés).
- Non couverts, volontairement : les 3 `<input type="file" hidden>` derrière un bouton (« 📥 Importer une image » des planches personnage/décor,
  image de fin d'un segment Relay), `#refVideosInput`/`#refAudiosInput`, `#loraFile`, le Canvas ; le toucher (HTML5 DnD absent, les boutons restent).
- Preuves : matrice 37 scénarios identique (112 corps `/prompt`, 407 243 o, 219 uploads, 17 corps ollama, 15 103 o) ; `bench-q21`, `bench-refs` verts ;
  proofs 4a/4b/mem 159/92/44 PASS (4a : 3 libellés « File de jobs » → « File de jobs (1) », attente adaptée) ; parité 52 119 contrôles ; banc DnD 141
  vérifications (vrais événements CDP `Input.dispatchDragEvent` + `DragEvent` synthétiques, graphes déposés = Browse/bouton octet pour octet) ;
  banc file 42 vérifications ; audit i18n vide ×4 langues (48 états dont 6 neufs) ; scan de registre vide ; check-keys : 6 orphelines préexistantes
  identiques à HEAD, 0 nouvelle ; 192 captures (390/768/1250/1440, clair/sombre, FR/EN), contraste ≥ 4,5, aucun débordement horizontal.

## 2026-09-25 — Lot Q21-CANVAS : Qwen Image 2.1 dans la carte Canvas « Création d'image »

Suite de Q21-STUDIO (piste « carte Canvas Text2Image Qwen Image 2.1 »). La carte `simple/krea2` a un champ **« Moteur »**
(Krea 2 Turbo par défaut / Qwen Image 2.1), sur le modèle de « Édition d'image ».
- `js/nodes-simple.js` : `engine` (défaut `krea2`, sérialisé), widget « moteur » posé après le bouton ; `generate()` en Qwen =
  `api/qwen21_t2i.json` + `Engine.buildGraph` comme le Studio (taille `RATIOS`, négatif `""`, `batch` 1, `SaveImage`
  `canvas/qwen21_t2i`), jamais de LoRA (`lora`/`mp` non lus). Branche Krea 2 inchangée.
- `canvas.html` : champ `engine` + `modelValues` de `CARDS["simple/krea2"]`, `mp`/`lora` masqués en Qwen (`when`), pied
  « Qwen Image 2.1 · W×H », aide sous « Moteur », statut « Génération Qwen Image 2.1 en cours… » et « Mégapixels » traduits
  (4 langues, tutoiement). Enrichissement : `ENHANCE.qwenImagePrompt` (texte de `ENRICH_SYSTEM`, clé `{"prompt"}`, sans
  négatif) — `ENRICH_SYSTEM` n'étant pas exporté par `Engine`, copie locale ; **`js/engine.js` et `index.html` intacts**
  (`Object.keys(Engine)` = 76). Largeur de carte inchangée (185 px mesurés pour 296).
- Écarts assumés : la carte n'a ni « Variantes » ni seed (`batch` 1) ni style Krea (le Studio ajoute `currentStyleText()`).
- Preuves : 5 cartes Krea 2 neuves + graphe sauvegardé par HEAD rechargé = 5 corps identiques à HEAD (5 492 o) ; graphes Qwen
  ×4 ratios = Studio octet pour octet ; bascule Krea→Qwen→Krea sans fuite ; rechargement en Qwen ; zéro job ; `bench-a3`
  0 groupe en écart ; parité des prompts 52 119 contrôles ; 1 rendu réel (30 s, regardé) :
  `output/canvas/qwen21_t2i_00001_.png`. Détail : `docs/NOUVEAUX-MODELES-QWEN21.md` § « Canvas : carte Text2Image Qwen
  Image 2.1 ».

## 2026-09-25 — Lot Q21-REFS : jusqu'à 10 images en Image2Image Qwen Image 2.1 (Studio)

Suite de Q21-STUDIO (piste « références supplémentaires en i2i »). Avec le moteur Qwen Image 2.1 du pipeline `image2image`, le Studio
envoie l'image d'entrée (`<image1>`) + jusqu'à 9 références (`<image2>`…), dans l'ordre affiché. Qwen-Edit 2509 strictement inchangé.
- `index.html` seul (`js/engine.js` intact : `addQwen21Refs` existait, aucune ligne ajoutée) : le bloc « Références supplémentaires »
  (`#refExtrasWrap`/`#refImagesInput`) est réutilisé, pas dupliqué ; `refCtx()` (`r2v`/`sb`/`i2i`) choisit plafond (7/7/9), texte d'aide
  et liste ordonnée (étiquettes `<imageN>`, croix de retrait, lignes au-delà de 9 barrées). Visible pour `qwen21_i2i` seulement, sans
  contrôle de manifest ; images de l'i2i mises de côté hors contexte (`refStash`/`swapRefFiles`, ni perdues au changement de moteur, ni
  partagées avec r2v/storyboard). Handler Generate : `collectQ21I2IRefs` (upload unique partagé par les marchés, plafond 9 avec WARN nouveau)
  puis `addQwen21Refs` ; 0 référence ⇒ graphe identique octet pour octet. `enrichBrief` protège les `<imageN>` du brief (jeton nu
  `Q21IMAGEREF<N>` retiré/remis, brief d'origine gardé + WARN si gemma les perd), `ENRICH_SYSTEM` inchangé. 4 clés `I18N` neuves FR/EN/ES/DE.
- Preuves : matrice 37 scénarios identique (112 corps `/prompt`, 407 243 o, 219 uploads, 17 corps ollama, 15 103 o) ; `bench-q21` vert ;
  banc neuf 18 scénarios (0/1/3/9/12 références, marchés, 2509 avec références en mémoire, zéro job, retrait, persistance, enrichissement) ;
  parité 52 119 contrôles ; audit i18n vide ×4 langues ; proofs 4a/4b/mem 159/92/44 PASS ; 1 rendu réel (111 s, regardé) :
  `output/studio/qwen21_i2i_00005_.png` (pêcheur + pomme + canard pirate, les deux références intégrées, scène source respectée).
- Non mesuré : le comportement du vrai gemma4:e4b sur le jeton nu (le mécanisme n'en dépend pas). Détail :
  `docs/NOUVEAUX-MODELES-QWEN21.md` § « Références multiples en Image2Image du Studio ».

## 2026-09-25 — Lot Q21-STUDIO : Qwen Image 2.1 sélectionnable dans Text2Image et Image2Image du Studio

Demande : l'utilisateur ne trouvait pas Qwen Image 2.1 dans les pipelines Text2Image et Image2Image (il n'était câblé que
dans l'ancrage des keyframes de `storyboard_v2` et la carte Canvas « Édition d'image »). Il est maintenant un choix de la
liste « Moteur », **à côté** de Krea 2 Turbo (t2i) et Qwen-Edit 2509 (i2i), qui restent premiers et défauts.
- `workflows/api/qwen21_t2i.json` (nouveau, `qwen21_i2i.json` sans `LoadImage` ni `images.image_1`, `SaveImage`
  `studio/qwen21_t2i`) ; `workflows/manifest.json` : entrées `qwen21_t2i` et `qwen21_i2i`, ordre existant inchangé ;
  `scripts/models.txt` inchangé (les 3 modèles y sont déjà).
- `index.html` seul : `WORKFLOW_LABELS` (« Qwen Image 2.1 », nom propre, aucune clé `I18N` ajoutée) ; `updateModelLabel`
  masque le contrôle LoRA pour `qwen21_*` (jamais de LoRA Krea 2 sur Qwen) ; le handler Generate calcule la taille de l'i2i
  2.1 depuis l'image d'entrée (~1 MP, multiples de 32, formule du Canvas) et garde `batch: 1`. Enrichissement : chemin
  générique existant, aucune nouvelle consigne. `js/engine.js`, Canvas et prompts dupliqués intacts.
- Preuves : matrice de 37 scénarios identique octet pour octet (112 corps `/prompt`, 407 243 o, 219 uploads, 17 corps
  ollama, 15 103 o) ; banc neuf de 10 scénarios Qwen (t2i 1 et 4 variantes × 3 ratios, i2i 832×480 et 480×832, marchés,
  enrichissement, témoins Krea 2 / 2509, zéro job) ; parité des prompts 52 119 contrôles ; audit i18n vide ×4 langues ;
  2 rendus réels (33 s chacun, regardés) : `output/studio/qwen21_t2i_00001_.png`, `output/studio/qwen21_i2i_00002_.png`.
- Pistes non construites : jusqu'à 10 références en i2i (`addQwen21Refs` sait le faire, aucun contrôle ne l'expose) ;
  carte Canvas Text2Image Qwen Image 2.1. Détail : `docs/NOUVEAUX-MODELES-QWEN21.md` § « Extension aux pipelines
  Text2Image / Image2Image du Studio ».

## 2026-09-25 — correctif jauge mémoire (mémoire unifiée GB10)

Le Studio affichait « Mémoire GPU 95 % » (`#sbGpu`, `#gaugeVram`) pour une machine à ~42 %. Cause : sur GB10 (CPU et GPU
partagent 121,6 Gio), `vram_free` de `/comfy/system_stats` vient de CUDA et exclut le cache de pages du noyau (récupérable).
`index.html` seul : `isUnifiedMem` (`vram_total` ≈ `ram_total` à 5 %) ; en unifiée, pourcentage = celui de la RAM
(`ram_free`), jauge RAM masquée (grille à 2 colonnes), libellés « Mém. unifiée » / « Mémoire unifiée » (4 langues) et `title`
« 50,9 / 121,6 Go ». GPU discret : comportement inchangé. Docs : `docs/ARCHITECTURE.md` (barre de session), `AGENTS.md` (pièges).

## 2026-09-25 — v1.3.0 — Clôture des Vagues 3 et 4 des revues du 2026-09-23 : UX Studio et Canvas, i18n, portage des prompts au Canvas

Cahier des charges : `docs/CODE-REVIEW-ERGONOMIE.md` (34 trouvailles, chacune porte désormais sa ligne
d'état) et `docs/CODE-REVIEW-OPTIMISATIONS.md` (I13). `VERSION` 1.2.0 → 1.3.0
(aucun tag git posé). Chaque lot Studio (A1, 3A, 3B, 3C, 4A, 4B) a été rendu à la même matrice de graphes :
**37 scénarios · 112 corps `/prompt` (407 243 o) · 219 uploads · 17 corps ollama (15 103 o), identiques octet
pour octet** avant/après ; les lots Canvas (3D, 4C) à leurs bancs Canvas (graphes identiques, 0 écart), et A2/A3
changent volontairement des textes de cartes, mesurés par le banc de cartes. Zéro job soumis sur simple
interaction partout. Méthode et emplacement des bancs : `docs/TESTING.md` § 3.

### Compléments de la Vague 2 (livrés après sa documentation, `103ae30`)
- `3df4c65` — updater non root (Q9) : `user: "${APP_UID:-1000}:${APP_GID:-1000}"`, `APP_UID`/`APP_GID` écrits dans
  `.env` par `install.sh`, qui signale un `.git` appartenant à quelqu'un d'autre (`docker-compose.yml`,
  `docker/updater/server.py`, `install.sh`).
- `ed6b216` — `tools/validate.py --no-submit` : validation structurelle après une mise à jour de ComfyUI, sans GPU.
- `ecd141c` — `workflows/manifest.json` déclare `"comfyui": {"min": "0.37.0"}` ; `js/update-check.js` propose la
  mise à jour par le ComfyUI-Manager (`/comfy/v2/manager/`) avec un seul `confirm` par session, refusée tant que la
  file n'est pas vide, retour arrière rappelé (`git -C ~/comfyui-spark/run/ComfyUI checkout <tag> && docker restart comfyui-nvidia`).
- Jeton Hugging Face : `install.sh` le passe à `curl -K -` (jamais en argument) ; la stack ComfyUI le lit dans
  `~/comfyui-spark/.env` (`HF_TOKEN`), plus jamais en dur dans son `compose.yaml` (hors dépôt).

### Vague 3 — portage des prompts au Canvas (I13) et UX
Décision de l'utilisateur du 2026-09-24 : porter au Canvas les corrections de prompt qualifiées dans le Studio.
- **A1** — `55b02ff` (`js/engine.js`) : fiches selon le type de sujet, keyframe à un sujet et branche à deux sujets prête,
  `stripPromptPadding`, grammaire H3 Ref2VA et cuts H3, `STYLE_PACKS` 5 → 14 styles, `KREA2_ENRICH_SYSTEM`
  exporté ; `Engine` 57 → 75 clés, dépendances en arguments. Banc de texte : 3 232 contrôles contre les fonctions
  du Studio (témoin négatif : 3 071 échecs contre l'ancien engine.js).
- **A2** — `4145b2c` (`canvas.html`, `js/nodes-advanced.js`, `js/nodes-simple.js`) : cartes branchées (type de sujet détecté
  transmis à la planche, cuts H3 et carte Vidéo H3 en grammaire, r2v, « Enrichir » avec la consigne du Studio),
  9 libellés de style traduits. Banc de cartes réelles : 355 contrôles, 130 clés changent (cuts H3, carte Vidéo H3, r2v),
  533 identiques.
- **A3** — `d001015` (`canvas.html`, `js/engine.js`, `js/nodes-advanced.js`) : cuts `minimax_h3_r2v` en grammaire Ref2VA
  (`<Picture 3>` = keyframe du plan), sélecteur « Type de sujet » (auto / humain / autre) sur la fiche personnage,
  `characterSheetFromBrief(scene, onEvent, forceKind)` et `h3CutBodyText` exportés : `Engine` 75 → **76 clés**, les
  25 noms du Studio inchangés. 550 contrôles de texte, 29 contrôles d'interface. Un rendu réel : cut r2v de 2 s
  (56 images, 24 fps, audio), identité et décor tenus. Non qualifié : un seul rendu r2v (sujet animal), pas de rendu
  Krea 2 avec type imposé, pas d'essai à plusieurs cuts.
- **3A** — `04e5161` (`index.html`) : quatre cartes d'objectif à la place des profils métiers et des onglets (S1, S5, S6, X2,
  S8 partiel) ; le brief n'est plus jamais écrit par l'app (l'exemple est un `placeholder`) ; garde de brief vide ;
  libellé du bouton principal selon le pipeline. 38 preuves spécifiques. Écart assumé : un brief vide bloque aussi
  `sequence2video` (l'app y écrivait auparavant un exemple).
- **3B** — `057bc1f` (`index.html`) : barre de session `#sessionBar` (vignettes ancrées, stepper 1-2-3, « Job k/n · mm:ss »,
  mémoire GPU), en-tête en grille, jauges réparées (S3, S10 stepper, S12, S13, S15, S16, S17). 41 preuves ; jauge
  remplie sur 583 px contre 0 avant.
- **3C** — `7764e91` (`index.html`) : mise en page sous 768 px, rail dans le flux, en-tête compact (213 → 93 px à 390 px),
  cibles de 44 px, contrôles de génération remontés au-dessus du bouton (S4, S14, S19). 70 preuves dont zéro job sur
  108 pages d'interaction ; desktop et 768 px inchangés (captures identiques à l'octet, sauf 4 états à 12–78 pixels de bruit).
- **3D** — `f95edd8` (`canvas.html`) : Canvas sous 768 px, palette et Propriétés en feuilles basculantes, ⤢ qui cadre les
  cartes, `resize` corrigé à la racine (C1, C8, C9 partiel). 68 cas, 0 écriture DOM au repos (M13 non régressé).

### Vague 4 — i18n, vocabulaire, annulation, Canvas résiduel
- **4A** — `692f0c0` (`index.html`) : `tr()` applique les entrées `fr:` (cause racine de S7), `translateTree` traduit `title` et
  `aria-label`, statuts de job traduits, `PIPELINE_LABELS`/`WORKFLOW_LABELS` (le manifest garde ses libellés techniques),
  vocabulaire unifié (image du plan, « Plan-séquence (Relay) », « Moteur », « Régénérer », « ✎ Réécrire l'action »,
  « ✎ Prompt image complet », « ✨ Enrichissement auto »), tutoiement en FR/ES/DE (S7, S8, S9, X4, C11). Le journal et
  les erreurs restent non traduits (contrat des benches). 159 preuves, audit i18n vide dans les 4 langues.
- **4B** — `703994e` (`index.html`) : `undoToast` (suppression de galerie et `removeSubject` annulables, 5 s, garde « projet
  changé »), titres de galerie lisibles (`assetTitle`, extrait du prompt), bande de vignettes `#shotStrip` (S11, S18, S10).
  159 + 92 preuves, 0 `/comfy/prompt` sur les 37 pages.
- **4C** — `7fb2df2` (`canvas.html`, `js/canvas-gallery.js`, `js/nodes-advanced.js`, `js/nodes-simple.js`) : UX résiduelle du
  Canvas (C2 à C11, X1, X3, X4) : plus de « + » inopérant en 2509, `syncWidgets` après `graph.configure`, « Générer »/« Régénérer »
  et statuts traduits, chevron des listes, étiquette technique retirée de l'en-tête de carte, trailer de gauche à droite,
  textes ≥ 12 px, tiroir traduit et au clavier, clés `theme`/`lang` partagées avec le Studio, ordre « Studio | Canvas ».
  Bancs canvas : 550 contrôles, 0 écart ; 170 preuves.
- **doc** — ce lot : `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/TROUBLESHOOTING.md` et `.fr.md`,
  états des deux revues, `README.md` et `README.fr.md`, `VERSION`, ce changelog.

### Écarts assumés
- **Duplication Studio/Canvas maintenue** : le code de compilation de prompts est porté dans `js/engine.js`, pas partagé ;
  les deux copies doivent rester identiques jusqu'à I13-B (source unique, décision de l'utilisateur en attente). Le test
  de parité `node tools/parity-prompts.js` (ajouté après ce lot, `docs/TESTING.md` § « Parité des prompts Studio / Canvas »)
  compare les deux copies (une seule différence de flux voulue, `forceKind` : le Canvas lit le jeu imposé de gemma, le Studio reverse le texte décidé, à conserver lors de I13-B) ; les bancs de graphes et d'UI vivent hors dépôt (`~/.cache/ai-content-studio/`).
- **Non traité** : Trailer illisible à 768 px (C7) ; texte dessiné du canvas litegraph à ≈ 2,6:1 en thème clair (C10) ;
  « Mégapixels » et « Style H3 (LoRA) » sans clé `I18N` au Canvas ; sélection d'entrée non rétablie après « Annuler » d'une
  suppression de galerie (S11) ; compteur de jobs par rafale (le relay repart à 1/1 à chaque segment, S12) ; gestes tactiles
  réels non validés sur appareil (C1) ; forme du sélecteur de langue (X1) et icônes SVG/émojis (X4) non harmonisées ; keyframes
  à deux sujets non câblées au Canvas.
- Les bancs des vagues antérieures ne sont pas rejouables tels quels (libellés renommés) : seuls les bancs de graphes font foi.

### Incidents et leçons
- Des **limites de dépense mensuelle** ont interrompu des agents en cours de lot (comme déjà pour 2B en Vague 2).
- Un banc a **soumis par erreur un vrai job Krea 2** (même famille d'erreur que 2D) ; le PNG produit a été supprimé à la
  demande de l'utilisateur. Règle : un banc qui clique « Générer » bouche `/comfy/prompt` et compte les soumissions.
- Une affirmation « aucun job GPU » s'est révélée fausse et a été corrigée : ne jamais l'écrire sans le compteur de
  soumissions du banc qui la prouve.
- `.git/objects` appartenait à **root** (écritures d'une session ou d'un conteneur), ce qui cassait `git add` : corrigé par
  `chown -R` sur `.git` ; `install.sh` détecte désormais le cas et affiche la commande (`docs/TROUBLESHOOTING.md` § 8).

### Retour arrière
- Vague 4 : `git revert 703994e 692f0c0 7fb2df2` (4B, 4A, 4C, du plus récent au plus ancien : 4B s'appuie sur 4A dans
  `index.html`). Les lots 3A à 3D et I13 sont antérieurs et ne dépendent pas de la Vague 4.
- Vague 3 : `git revert` des commits `f95edd8 7764e91 057bc1f 04e5161` ; I13 : `d001015 4145b2c 55b02ff`, du plus récent au plus ancien.
- Mise à jour de ComfyUI : commande de retour arrière de la section « Compléments de la Vague 2 » ci-dessus.

### Reste à faire
- I13-B (source unique Studio/Canvas pour la compilation de prompts) : décision de l'utilisateur.
- Décisions de l'utilisateur, toutes tranchées : Q1 porter les prompts au Canvas (I13, fait) ; Q2 ne pas fermer Ollama au LAN (`0.0.0.0:11434` reste voulu) ; Q4 jeton HF en `.env` (fait) ; Q8 tutoiement (fait, Studio et Canvas) ; Q9 updater non root + mise à jour de ComfyUI (`3df4c65`, `ecd141c`).
- Les réserves de la section « Écarts assumés ».

## 2026-09-24 (suite) — Vague 2 des revues du 2026-09-23 : infra, Canvas, storyboard, E/S, nettoyage, dédoublonnage

Cahier des charges : `docs/CODE-REVIEW-OPTIMISATIONS.md` (état de chaque trouvaille renseigné en
fin de section). Sept lots, commits locaux, non poussés. Planification et vérification : Opus
(Fable indisponible). Exécution : Sonnet pour 2-INFRA, 2B, 2C, 2D et doc ; Opus pour 2A et 2E.

### Lots et résultats
- **2-INFRA** — `90a0122` (I4, I5 volet nginx, M10 volet outils, M11, M12, M16, M17, K5, `[FAIL]` audio
  de `validate.py`) : `/update/` sans tampon de requête, read_timeout 600 s ; `/ollama/` 300 s ;
  `/comfy/` 500m ; `updateAvailable` faux hors `main` ou si le SHA distant est déjà ancêtre de HEAD ;
  `/status` en cache 60 s ; `/apply` refusé hors `main` ; `install.sh` télécharge vers `.part` puis `mv`,
  jeton HF via `curl -K -` ; doublon `qwen_image_vae` retiré de `scripts/models.txt` ; index des modèles
  par chemin relatif à la catégorie, fps 24 par défaut.
- **2A** — `f6a13c3` (I6-I10, M18, M19 a-c, M20) : statut par keyframe et par cut (un échec ne coûte
  que son plan, relançable par 🔄), `cancelProject` interrompt par `prompt_id`, bouton d'étape 2 masqué
  quand des keyframes existent, relais lisant explicitement le sujet 1, segment relais `continue` sans
  frame de transition refusé, objectURLs révoquées, gardes de session. Banc : 20 cas, 17 échouent avant, 20 passent après.
- **2B** — `dc7b5d8` (I5 volet gemmaJSON, I11, I12, M3-M8, M21) : job perdu détecté (« Job … perdu
  (ComfyUI redémarré ?) » après 2 tours d'absence de `/history` et `/queue`), resynchronisation à la
  reconnexion WebSocket, `execution_interrupted` traité, `saveLocal`, `assetPrompts` purgé, LoRA
  téléversée visible sans rechargement, `gemmaJSON` lève « ollama <code> », `submitGraph`/`uploadBlob`
  dédoublonnés, moniteur en pause onglet masqué, uploads `overwrite=false`, clé Gemini en en-tête. Banc : 29 PASS après, 15 FAIL avant.
- **2C** — `8037bde` (M1, M2, M9, M10 volet JS, K1, K2, K3) : chaîne Auto morte supprimée
  (`js/engine.js` −218 lignes, `Engine` 63 → 54 clés, `soulAnchors` supprimé), `capH3Prompt` rogne
  `detailed_description`, `{{FRAMES}}` à 24 fps par défaut, i18n, docs.
- **2D** — `0dc544f` + `dd86b67` (M13, M14, K4, M15) : plus d'écriture DOM au repos (`graph.start()`
  retiré), état sauvegardé illisible et quota localStorage plein tolérés, palette d'états unique dans
  `js/nodes-simple.js`, litegraph.js 0.7.18 et son CSS vendorisés dans `js/vendor/` (plus de jsdelivr).
  Banc : 0 écriture DOM au repos sur 3 s contre 1260 avant ; état illisible (JSON tronqué, structure invalide) et quota plein tolérés.
- **2E** — `aff8a12` (I14) : `index.html` charge `js/engine.js` et en déstructure 25 fonctions
  (liste dans `docs/ARCHITECTURE.md` § Code partagé Studio/Canvas) ; `gemmaJSON(system, user, images)`,
  `waitForJobs(ids, isCancelled)`, WebSocket de l'engine ouverte au premier job suivi ; `Engine` = 57 clés.
  Preuves : 37 scénarios, 112 corps `/prompt` (407 243 o) et 219 uploads comparés avant/après, 17 corps
  ollama identiques octet pour octet, 25 fonctions comparées, témoin négatif ; rendus réels : t2i
  Studio, relais H3 à 2 sujets, carte t2i Canvas.
- **doc** — ce lot : `docs/ARCHITECTURE.md`, `AGENTS.md`, `README.md`/`README.fr.md` (doublon VAE retiré,
  modèles Qwen Image 2.1 ajoutés, 22 fichiers), état de chaque trouvaille, ce changelog.

### Écarts assumés
- **M4** : les messages de journal de `submitGraph` remplacent ceux des anciennes copies.
- **M16** : pas de `git fetch` dans l'updater (il tourne en root et salirait `.git`) ; le SHA distant
  vient de `git ls-remote`, comparé par `git merge-base --is-ancestor`.
- **M18** : traité par un refus, pas par un repli silencieux en coupure.
- **M19 (d)/(e)** non faits : l'aperçu et la séquence relisent ces URL, les révoquer les casserait.
- **I13** non traité : porter ou non les corrections de prompt au Canvas reste à décider par l'utilisateur.
- **2D** : le banc a soumis par erreur un job Krea 2 réel ; le PNG produit a été supprimé à la demande
  de l'utilisateur.
- **2B** a été interrompu par la limite de dépense mensuelle, puis repris.
- Décisions : litegraph.css vendorisé ; un état Canvas illisible est supprimé sans sauvegarde.
- Reste dupliqué Studio/Canvas : `resolveImageJob`, tout ce qui porte du texte de prompt, la WebSocket et
  `handleWS`, `LTX25_FPS` (2 exemplaires, à garder égaux). `resolveImageJob` subsiste aussi, sans appelant,
  dans `js/engine.js` (M2 l'y listait).

### Incidents et leçons
- Les setters de style ne sont pas sur `CSSStyleDeclaration.prototype` dans ce Chromium : pour compter les
  écritures DOM, envelopper `HTMLElement.prototype.style` par un Proxy.
- Un banc qui clique « Générer » doit bloquer `/comfy/prompt`, sans quoi il soumet un vrai job (2D).
- Un banc CDP qui réutilise un profil Chrome persistant peut servir un `engine.js` périmé depuis le cache
  HTTP : profil vierge à chaque comparaison. `python3 -m http.server` n'envoie pas `Cache-Control`.

### Reste à faire
- Vagues 3 et 4 (UX, `docs/CODE-REVIEW-ERGONOMIE.md`) ; décisions Q1, Q2, Q4, Q8, Q9 en attente.
- I13 (voir plus haut).
- Changelog de clôture et bump de version (`VERSION`) en fin de chantier.

## 2026-09-24 — Vague 1 des revues du 2026-09-23 : exposition réseau et 3 bugs critiques

Cahier des charges : `docs/CODE-REVIEW-OPTIMISATIONS.md` (43 trouvailles) et
`docs/CODE-REVIEW-ERGONOMIE.md` (34), commit `1f50fff`. Vague 1 = ce qui était urgent ou critique.
Planifiée par Opus (Fable ayant atteint sa limite de dépense), deux lots séquentiels car ils
touchent tous deux `index.html` et que le premier recrée le conteneur ComfyUI dont le second a
besoin pour ses rendus.

### Lot 1B — exposition réseau (I1, I2, I3) — `b2700a0`
- **nginx** : plus aucun fichier interne servi (`.git/`, `.env`, `.claude/`, `tools/`, `docker/`,
  `scripts/` → 403, vérifié en localhost et en IP LAN). Les locations de proxy passent en `^~` : une
  location regex l'emporterait sinon sur un préfixe simple.
- **ComfyUI** : publié uniquement sur `127.0.0.1:8188`, `SECURITY_LEVEL: normal`, retrait de
  `--enable-cors-header` (le middleware « origin only » de ComfyUI s'active alors ; le proxy
  same-origin de `:8090` le passe, WebSocket comprise, vérifié par handshake HTTP 101 depuis deux
  origines). Gabarits `docker/stacks/*.yml` et stack déployée `~/comfyui-spark/compose.yaml`
  (hors dépôt, contient un jeton HF en clair — non affiché, non déplacé, sauvegarde `.bak-2026-09-24`).
- **Updater** : requêtes `Sec-Fetch-Site` cross-site refusées (403), téléversement LoRA sans
  écrasement (409, `os.link` au lieu de `os.rename`), `.part` unique et nettoyé, fichier publié en 0644
  (`mkstemp` crée en 0600 et le conteneur écrit en root : ComfyUI ne l'aurait pas lu).
- Lien « Open ComfyUI » du Studio : `/comfy/` (le `:8188` direct n'est plus joignable à distance).
- **Non fait, décision utilisateur en attente** : Ollama déployé reste sur `0.0.0.0:11434` — Open
  WebUI et Spark Control Center l'atteignent par `host.docker.internal` et se casseraient s'il passait
  en 127.0.0.1. Seul le gabarit du dépôt est durci.
- Imprévu : ComfyUI était arrêté au démarrage du lot (mise à jour système + reboot à 07:35, conteneur
  tué juste avant, non relancé par `unless-stopped`). L'agent s'est arrêté et a demandé plutôt que de
  le relancer seul ; relancé ensuite avec la config durcie (`RestartCount` 0).

### Lot 1A — bugs critiques C1, C2, C3 — `91bbd90`
- **C1** : `applyMinimaxTurbo` (2 copies, `index.html` et `js/engine.js`) ne cible plus que la LoRA
  `H3/…`. Avant, décocher « Turbo » puis passer sur Localized Assets retirait la LoRA Lightning de
  Qwen-Edit (rendu dégradé, statut « success »). Contrôle négatif rejoué sur l'état avant correctif :
  1 LoRA → 0. `docs/LESSONS.md` et `docs/ARCHITECTURE.md` corrigés.
- **C2** : `applyMinimaxLastFrame` porté dans `js/engine.js` et appelé par les cartes Canvas
  « Vidéo » et « Génération vidéo » en moteur H3 (elles échouaient depuis le 2026-09-22). Rendu réel
  H3 i2v depuis le graphe Canvas : frames 0/19/38 fidèles, audio présent (−31,5 dB moyen).
  **Le mécanisme d'échec du rapport était faux** : ComfyUI accepte le prompt (200) et échoue à
  l'exécution sur `lastimg` (`Is a directory`), il ne le rejette pas à la validation. Rapport corrigé.
- **C3** : `scripts/models.txt` place la LoRA Lightning dans `loras/Qwen/` (là où les gabarits la
  cherchent) — invisible sur ce GB10 où le fichier existe aux deux endroits, cassait une install neuve.
- Harnais réexécutable : `node ~/.cache/ai-content-studio/vague1/harness-1a.js` (18 cas).

### Restes signalés par les lots, à traiter en Vague 2
- Commentaire d'`index.html` (~L4270) « no-op sur tout graphe sans LoraLoaderModelOnly » devenu
  imprécis ; indentation approximative de 2 lignes ajoutées par le lot 1A (cosmétique).
- `tools/validate.py --audio` affiche un `[FAIL]` parasite sur un mp4 de 0 octet supprimé, alors que
  la piste audio réelle est `[OK]`.
- Le contrôle d'objets git du plan (`… | git cat-file --batch-check`) donnait de faux « missing » :
  il faut `cut -d' ' -f1` avant `--batch-check`.
- Les 60 captures UX du rapport ergonomie ont été perdues avec le scratchpad de session (vidé le
  2026-09-24) : à refaire avant la Vague 3.

## 2026-09-23 — v1.2.0 — Qwen Image 2.1, en coexistence avec Qwen-Edit 2509

Cadrage initial (`/architect`, `docs/QWEN-IMAGE-2.1-ROADMAP.md`) puis qualification réelle et intégration (4 commits). Le livré diffère du cadrage sur plusieurs points importants — voir plus bas, le compte-rendu complet est `docs/NOUVEAUX-MODELES-QWEN21.md`.

### Qualification

Les deux fichiers modèles annoncés au cadrage (`qwen3.5_9b_..._pe_t2i`/`pe_i2i`) ne sont **pas** des encodeurs mais des LLM de réécriture de prompt : câblés comme encodeur ils rendent du bruit pur avec un job ComfyUI `success` (piège n°14 typique). Le vrai encodeur, qualifié par comparaison de rendus : `qwen3vl_8b_int8_convrot.safetensors`. Qualifié aussi sur rendu comparatif contre 2509, mêmes seeds, même prompt compilé par l'app : dual charsheet+locsheet en une passe native (mieux que 2509 sur tous les critères — un seul exemplaire du sujet, action suivie, cadrage suivi), multi-référence fidèle jusqu'à 10 images, texte incrusté exact (2509 fautif), plafond storyboard 2 planches + 7 références prouvé (identité et décor tiennent simultanément). Deux sujets par plan : aucun des deux moteurs n'est fiable au-delà de 2 — le plafond existant n'est pas relevé.

### Modèles

`scripts/models.txt` : les 3 fichiers réellement référencés par les gabarits (`qwen_image_2.1_int8_convrot.safetensors`, `qwen3vl_8b_int8_convrot.safetensors`, `qwen_image_2.1_vae_bf16.safetensors`) — pas les `pe_t2i`/`pe_i2i` du cadrage initial, écartés par la qualification.

### Canvas — carte « Édition d'image »

`QwenEditNode` gagne une propriété `engine` (2509 par défaut, chemin inchangé au caractère près ; `qwen21` en option). Mode 2.1 : gabarit `api/qwen21_i2i.json`, `WIDTH`/`HEIGHT` calculés depuis les dimensions réelles de l'image d'entrée (jamais 1024×1024 en dur — ce gabarit fixe son latent de départ, un ratio faux sort recadré au carré). Références supplémentaires par le slot autogrow déjà écrit pour `reference2video` : jusqu'à 10 au total.

### Studio storyboard — choix du moteur d'ancrage des keyframes

Nouvelle entrée manifest `storyboard_v2_qwen21` (même pipeline `storyboard_v2`, `anchor: api/qwen21_dual.json`) : le moteur se choisit comme un modèle de plus dans le menu, 2509 reste l'entrée par défaut. Le décor d'un plan à 2 sujets passe en `<image3>` via `addQwen21Refs` (porté verbatim dans `index.html`, qui ne charge pas `js/engine.js`) plutôt que `addKeyframeThirdRef` (qui vise un nœud absent du gabarit 2.1), suivi des références supplémentaires du contrôle déjà utilisé par Minimax H3 r2v — même liste, même plafond 7, désormais pleinement consommé en moteur 2.1 (il ne l'était pas, et ne l'est toujours pas, en moteur 2509). `reference2video` ne reçoit aucun sélecteur : ce pipeline n'a pas d'étape d'ancrage (un seul job Minimax H3 direct).

### Nuance à retenir (AGENTS.md)

Le plafond « 2 sujets par plan » n'a plus la même origine selon le moteur : plafond du **nœud** en 2509 (`TextEncodeQwenImageEditPlus`, 3 entrées image max), plafond de **fiabilité constatée au rendu** en 2.1 (`TextEncodeQwenImage21` accepte jusqu'à 16 entrées, 10 prouvées, mais les deux moteurs échouent pareillement au-delà de 2 sujets). Ne pas confondre les deux en lisant le piège.

## 2026-09-22 (suite) — v1.1.0 — Le studio storyboard, de la planche à l'animatic

Première version numérotée depuis la v1.0.8 (2026-09-09), qui ne couvrait que le déploiement. Tout ce qui a été fait depuis porte sur l'application elle-même, et principalement sur le studio storyboard. C'est aussi la première fois que des pièces de ce chantier sont **constatées en rendu réel** chez l'utilisateur, et non seulement en headless.

### Ce que la v1.1.0 apporte depuis la v1.0.8

- **Qualité Krea 2** : consigne d'enrichissement dédiée, bibliothèque de 14 styles curés sur la taxonomie Krea 2, retrait déterministe du remplissage dans les prompts, couverture de tous les points où Krea 2 rend une image, et plus aucun titre incrusté demandé aux modèles.
- **Grammaire de prompt Minimax H3** portée du composer de référence, description des sources par vision, et **FL2VA** (première et dernière image) sur le même nœud que l'i2v.
- **Fiches de sujet qui suivent le sujet** : gemma tranche humain ou non, une bascule le corrige par sujet, et le gabarit de planche se choisit parmi cinq compositions sur un sélecteur visuel.
- **Plusieurs sujets par storyboard**, taggés plan par plan, deux au maximum plus le décor.
- **Plus de mode Auto** : la revue étape par étape est le seul chemin, et rien ne part en rendu sans un clic.
- **Keyframes en face de leur plan**, régénérables et verrouillables.
- **Prompts éditables partout**, appliqués verbatim et rangés avec le projet.
- **Moteur des cuts au choix**, LTX 2.5 ou Minimax H3.
- **Prompt Relay** : jusqu'à dix segments enchaînés, liaison continue ou coupure.
- **Annuler le projet**, et un montage dont les clips sont numérotés d'après les plans.

### Annuler le projet

Une session lancée ne pouvait qu'aller à son terme. Deux boutons « Annuler le projet » (formulaire et studio) vident la session et le projet en stock. Le point non évident est ailleurs : les attentes `waitForJobs` déjà lancées continuaient de résoudre après coup et réécrivaient dans une session disparue. Un compteur d'annulation, relu par chaque attente, les fait abandonner.

### Le clip de tenue n'est plus compté comme un plan de plus

La « tenue du plan final » ajoute un cut supplémentaire sur la dernière keyframe. Le montage le numérotait comme un plan, donc six plans donnaient sept clips numérotés jusqu'à « Plan 7/6 ». Il porte maintenant son propre libellé, « Tenue du plan 6 », et la numérotation des plans s'arrête à six.

### Prompt Relay : composer de scénario, re-rendu par segment, transition au choix, image de fin

Quatre compléments, aucun ne lançant de génération de lui-même.

Un **composer de scénario** (moteur H3 seul) découpe un récit saisi en N segments dans la structure attendue par H3. La légende des sujets envoyée à gemma est construite depuis la fonction qui les numérote réellement, pour qu'elle ne puisse pas mentir sur la numérotation.

Le **re-rendu d'un segment seul** : chaque segment range son image de départ, ce qui rend un re-rendu possible sans relancer toute la chaîne. Les segments suivants sont marqués « à re-générer » et attendent un clic.

L'**image de transition au choix** : cinq candidates sont extraites en fin de segment (la dernière frame et les quatre qui la précèdent, par pas de trois) et proposées en vignettes cliquables. L'index visé est **positif** et calculé en JS depuis la durée : un index négatif vise une tranche vide dans l'implémentation de référence du nœud, donc son comportement dépend de la version installée (piège n°27).

Une **image de fin** par segment (H3 seulement) bascule le cut en FL2VA. Masquée sur LTX 2.5, dont le template n'a pas d'équivalent.

Correctif au passage : les jetons `<Subject N>` partaient tels quels à l'enrichissement et revenaient déformés. Ils sont désormais remplacés par un mot nu avant l'appel et remis après ; le normaliseur de secours ne s'applique qu'à la sortie de gemma, jamais au texte de l'utilisateur (piège n°26).

### Le décor n'était nommé nulle part

Première vraie session de storyboard sur GB10 : la planche de décor était un court de tennis en terre battue, trois keyframes sur quatre se passaient dans un désert. Le prompt ne désignait le lieu que par « the second reference image ». Or cette entrée ne touche jamais le latent — seule l'image 1 alimente le `VAEEncode` — et Qwen-Edit tourne à cfg 1, donc le texte fait loi : le modèle ne gardait de la planche que sa dominante ocre et inventait le reste. Le lieu est maintenant écrit en toutes lettres, dans la phrase de rôle **et** après l'action. C'est l'ancrage double déjà en place sur les cuts depuis le piège n°9, qui manquait au seul endroit qui en avait le plus besoin. Confirmé en rendu par l'utilisateur. Piège n°28.

### Une planche qui redevenait une photo

Un sujet ajouté à la main puis décrit dans « ✎ Prompt » ne rendait plus de planche, seulement une belle photo de scène. L'enrichissement envoyait le prompt **entier** à gemma sous la consigne d'image unique de Krea 2, qui emportait la composition multi-vues avec elle. Le « strip-then-reappend » s'applique désormais aussi aux planches — le squelette est retiré avant l'appel et remis après — et gemma reçoit une consigne dédiée qui ne décrit que ce que le sujet ou le lieu **est**, ni fond, ni cadrage, ni lumière, le gabarit posant déjà tout cela. Pièges n°29 et n°30.

Au passage : une description saisie uniquement dans la modale laissait les champs du sujet vides, et ce sont eux que lisent les keyframes et les cuts — le plan partait donc avec une identité vide. Elle est maintenant reversée dans le premier champ quand il n'y en a aucune. Le prompt, lui, part toujours verbatim.

### Un prompt de keyframe sans son ancrage

Un plan rendait un collage : la planche produit, sa grille de vignettes et son bandeau de palette recollés dans l'image. Son prompt avait été remplacé à la main par la seule phrase d'action, et il est parti verbatim — donc sans les phrases de rôle des images et sans le bloc d'ancrage, qui est précisément ce qui interdit de recopier une planche. Le bloc est désormais remis sur **tout** prompt appliqué qui ne le porte plus, comme il l'était déjà après un ré-enrichissement. « Verbatim » porte sur les mots de l'utilisateur, pas sur les invariants que le graphe exige. La légende de la modale distingue maintenant le prompt du moteur de la description du plan, qui a son propre bouton. Piège n°31.

### Deux sujets : un objet n'est pas un personnage

Premier run réel du chemin à deux sujets — il n'avait jamais été qualifié, contrairement à celui à un sujet. Une chaussure et une raquette de tennis : la raquette est sortie éclatée en morceaux éparpillés sur un plan, absente sur un autre. Le câblage était correct. Deux défauts de texte : le prompt appelait les deux sujets « characters » dont il fallait préserver « anatomy, body plan, head, clothing », et rien n'interdisait l'éparpillement en pièces détachées ni n'exigeait que chaque sujet soit visible. Le nom du sujet suit maintenant sa nature, comme le vocabulaire des planches le fait déjà, les deux planches sont annoncées comme des planches multi-vues d'une seule chose, et un exemplaire complet, entier et visible est exigé de chacun. La branche à un sujet reste inchangée au caractère près. Piège n°32.

Correctif voisin, plus tôt dans la journée : un cut à deux sujets les décrivait tous deux comme « the main character », ce qui les faisait fusionner.

### Vérification

Headless uniquement pour l'essentiel : le banc bouchonne ComfyUI et Ollama, sert l'application telle quelle et vérifie les prompts compilés, le câblage des graphes soumis, la persistance et le rendu de l'interface (clair/sombre, 390/768/1250/1440 px). Ni ComfyUI ni Ollama ne tournent en session distante. Trois points sont en revanche **constatés en image** par l'utilisateur sur son GB10 : le décor tenu par les keyframes, la disparition du collage, et deux sujets entiers dans un même plan.

## 2026-09-22 — Retours de la première session de test sur GB10

Sept points remontés par l'utilisateur après sa première vraie session de bout en bout. Six sont traités ici, le septième était une question.

### Une seule cause derrière trois des points

Les planches « à vues identiques », la génération qui partait toute seule à l'ajout d'un sujet et le gabarit qui n'était pas repris venaient du même endroit. La variante de planche rangeait `charDescFromFields(...)` — la description des champs — là où l'app attend le prompt réellement soumis, qui est cette description **enrobée du gabarit** (turnaround, expressions, bandeau de palette, `SHEET_CLEAN`). Invisible au premier rendu ; visible dès qu'on ouvre « ✎ Prompt », qui rouvrait la description nue, et qu'on applique : le prompt part verbatim, donc sans gabarit, et Krea 2 rend cinq fois la même pose. Corrigé en compilant le prompt une fois, au point de soumission, et en rangeant **celui-là**. Détail et règle générale : `docs/LESSONS.md`, piège n°24.

### Ajout d'un sujet : plus rien ne part tout seul

« + Ajouter un sujet » demandait à gemma le sujet suivant du brief puis lançait sa planche. Sur un brief à un seul sujet, gemma n'a rien à trouver : il invente, humain par défaut (un panda roux est ressorti en Superman). Le bouton pose maintenant un emplacement **vide** — ni appel LLM, ni job. L'utilisateur décrit le sujet dans les champs ou dans « ✎ Prompt », puis lance « Générer la planche », qui reprend le gabarit figé de la session et une seed propre au sujet. La porte des keyframes reste fermée tant que la planche manque. Piège n°25.

### Deux planches d'ancrage pour un plan

C'était déjà possible mais illisible : les pastilles de sujets se lisaient comme un choix unique. Elles portent maintenant une coche ou un plus, `aria-pressed`, et le libellé annonce le plafond (« cliquez pour en ancrer jusqu'à 2 », puis « 2 au maximum par plan »). Le plafond lui-même ne bouge pas : il vient des trois entrées image du nœud d'ancrage, décor compris.

### Le champ Action est enrichissable avant les keyframes

Chaque carte de plan porte « ✎ Prompt de l'action », disponible dès l'étape 1. Même modale que le reste ; ce qui est appliqué remplace le champ Action. La consigne interdit à gemma d'y écrire caméra, lumière ou couleur — l'app les appose plus tard — et lui passe les descriptions des sujets **taggés sur ce plan** : à deux sujets, les deux doivent agir dans la phrase. Même exigence sur le prompt de keyframe, dont l'enrichissement réclame les trois phrases de rôle (deux personnages + décor) et écarte une sortie gemma qui en a perdu une.

Corollaire : une keyframe **jamais éditée à la main** recompile son prompt à la régénération, sinon éditer l'action ou tagger un second sujet ne changeait rien. Une keyframe dont le prompt a été édité n'est jamais recompilée par-dessus.

### La question (point 7)

« Générer les keyframes » soumet un job Qwen-Edit ancré par plan et affiche chaque case en face de son plan — aucune grille n'est produite à cette étape. Le contact-sheet n'apparaît qu'au Montage, avec les cuts. Vérifié en headless : 6 plans → 6 jobs, aucun autre.

### Vérification

49 assertions headless (Chromium, ComfyUI et Ollama bouchonnés) : prompt de planche rangé = prompt envoyé, gabarit repris par le sujet 2, ajout sans job ni appel LLM, persistance d'un sujet sans planche, double ancrage jusqu'au graphe soumis (3e entrée image), enrichissement de l'action à deux sujets, prompt édité jamais recompilé. Captures clair/sombre à 390, 768, 1250 et 1440 px. **Rien n'est vérifié en rendu réel** — ni ComfyUI ni Ollama en session distante.

## 2026-09-21 (suite 6) — Prompt Relay, prompts éditables, composer H3 sur les cuts

Trois demandes de l'utilisateur, posées ensemble parce qu'elles touchent le même code de studio, et deux documents de référence fournis par lui : l'ontologie de styles et le system prompt Qwen-Image-Edit-2509.

### 1. Prompts éditables partout, ré-enrichissement par moteur

Un bouton « ✎ Prompt » sur les deux planches, sur chaque keyframe et sur chaque cut ouvre une modale montrant le texte réellement envoyé au graphe. Le texte appliqué part **verbatim** — l'app ne recompile rien par-dessus — et il est rangé sur l'objet (variante, keyframe, cut), donc il survit à la persistance et une régénération ultérieure ne ramène pas la compilation d'origine.

Trois consignes, une par moteur : planches → `KREA2_ENRICH_SYSTEM` (existante), keyframes → `QWEN_EDIT_ENRICH_SYSTEM` (nouvelle, tirée du document fourni : dire quoi changer et quoi préserver, rôles d'images explicites, identité non réinventée, formulation positive puisque cfg 1, interdiction du vocabulaire « storyboard/planche »), cuts → consigne dépendante du moteur ciblé.

L'invariant d'ancrage des keyframes sort en constantes et n'est jamais soumis à gemma : détail et règle générale dans `docs/LESSONS.md`, piège n°21.

### 2. Moteur des cuts : LTX 2.5 ou Minimax H3

Le menu Montage expose un sélecteur. LTX 2.5 reste le défaut, prompt inchangé au caractère près (formulation qualifiée au LOT 4, piège n°9). Minimax H3 réutilise la grammaire du Prompt Composer déjà portée pour le `reference2video`, avec **une seule adaptation** : un cut n'a qu'une image d'entrée, la keyframe, où personnage et décor sont déjà composés ensemble — tous les sujets se définissent donc sur `<Picture 1>` et seule la numérotation des `<Subject>` varie. La phrase d'alignement dit au modèle que la keyframe est l'instant 0 du clip ; le graphe part en turbo 8 steps, sans `last_frame`.

Le moteur est rangé **sur chaque cut** : re-rendre un plan ne change jamais son moteur, même si le sélecteur a bougé depuis, sinon un montage finirait mi-LTX mi-H3 sans que rien ne le dise. La grille 17n+5 est annoncée avant le lancement et rappelée sur chaque clip, qui a sa propre durée.

### 3. Prompt Relay

Porté depuis la piste « Cinema Studio » (`yoyo-sama/cinema-ai-studio`), où la chaîne a été qualifiée en rendu réel. Nouvelle section du studio, ouverte dès les planches validées (elle n'a pas besoin des keyframes du storyboard, elle compose les siennes). De 1 à 10 segments, chacun avec son prompt, sa durée, son enrichissement et sa **liaison** : 🔗 continu (la dernière frame du segment précédent est ré-uploadée telle quelle) ou 🎞 coupure (keyframe composée). L'assemblage réutilise les cuts francs de l'animatic.

Pourquoi deux liaisons plutôt qu'une : `docs/LESSONS.md`, piège n°22 — repasser la frame de transition par Qwen-Edit produit une coupure visible, c'est l'inverse de l'effet recherché.

### Vérification

75 assertions headless (Chromium, ComfyUI et Ollama bouchonnés) : invariant d'ancrage et ses trois replis d'enrichissement, grammaire H3 des cuts, câblage réel des graphes soumis, éditeur de prompt, chaîne relay complète (suite de jobs `key,cut,frame,cut,frame,key,cut` sur trois segments en liaisons coupure/continu/coupure), persistance. Captures clair et sombre à 1440 et 390 px.

**Rien n'est vérifié en pixels** : ni ComfyUI ni Ollama ne tournent dans une session distante. Restent à constater sur le GB10 : la tenue d'un cut H3 par rapport au même plan en LTX, et la continuité réelle d'un raccord 🔗.

## 2026-09-21 (suite 5) — FL2VA Minimax H3

L'utilisateur signale que le nœud `MiniMaxH3ImageToVideo` couvre trois modes selon ce qui est branché : rien = t2v, `first_frame` seul = i2v, `first_frame` + `last_frame` = FL2VA. Capture de son ComfyUI à l'appui, les deux entrées y figurant comme facultatives.

Vérifié dans le dépôt : nos templates `minimax_h3_t2v.json` et `minimax_h3_i2v.json` utilisent **déjà le même nœud**, à la seule présence de `first_frame` près. Le FL2VA H3 ne coûtait donc qu'une entrée `last_frame` et son `LoadImage` — ce que la note précédente annonçait comme « presque gratuit », confirmé.

### Ce qui change

- `api/minimax_h3_i2v.json` câble `last_frame` sur un `LoadImage` alimenté par `{{IMAGE2}}`. Aucune dernière image fournie ⇒ `applyMinimaxLastFrame` retire la clé et le nœud orphelin, et le graphe redevient **identique à l'ancien** (23 nœuds, aucun lien pendant — vérifié).
- Un champ « dernière image (facultatif — FL2VA) » apparaît, piloté par le **modèle** sélectionné et non par `pipelines[].controls` : la capacité appartient au workflow, et le champ n'a aucun sens sur `ltx25_i2v`, qui partage pourtant le pipeline `image2video`. Vérifié affiché sur `minimax_h3_i2v`, masqué sur `ltx25_i2v` et hors pipeline image.
- La phrase d'alignement temporel prend sa forme FL2VA quand les deux images sont là, et son repère de fin est la durée **réellement rendue** — pas celle demandée. H3 se cale sur la grille 17n+5 : annoncer « à 5,00 s » sur un clip qui en rend 5,17 placerait la dernière image avant la fin.

### Un piège rencontré en chemin

Transcrire la formule 17n+5 en JavaScript ne marche pas telle quelle : le `%` de `ComfyMathExpression` est un modulo à la Python, positif sur une valeur négative, là où celui de JS garde le signe. La version naïve rendait **22 frames** pour une demande de 1 s au lieu des 39 mesurées en rendu réel — 40 % d'écart, silencieux. Détail dans `docs/LESSONS.md`, piège n°20.

Autre rappel, refait malgré sa présence dans le dépôt : `.gb-field` est un `<label>` en `text-transform:uppercase`, une phrase d'aide y devient illisible. Constaté en capture, corrigé en `title`.

### Vérifications

JS validé, graphes construits hors navigateur dans les deux modes (i2v inchangé, FL2VA câblé, aucun lien orphelin), `h3VideoFrames(1) = 39` recoupé avec la mesure en rendu réel du piège n°11, UI capturée en clair/sombre à 1440 et 390 px avec la visibilité du champ vérifiée sur les trois cas. **Aucun rendu réel** — ComfyUI tourne sur la machine de l'utilisateur.

---

## 2026-09-21 (suite 6) — Rebase derrière les fiches personnage

La branche `claude/fiches-personnage-animaux-np87b7` ayant été fusionnée en premier (PR #1, `812499c`), le travail des suites 4 et 5 a été rebasé derrière elle. Trois conflits résolus à la main, aucun arbitrage silencieux :

- `AGENTS.md`, deux fois : les deux branches réécrivaient le même paragraphe de repères JS puis la même puce Minimax H3. Les deux apports sont conservés, pas l'un à la place de l'autre.
- `index.html` : `main` a supprimé `generateStoryboardV2` (le sélecteur Auto/Réalisateur a disparu, la revue est le seul mode) pendant que la suite 4 insérait ses sections juste après. Suppression conservée, sections conservées.

Deux points d'intégration relevés en relisant plutôt qu'en se fiant au résumé :

- `characterSheetFromBrief` renvoie désormais un objet de champs passé tel quel à `submitCharsheetJob` ; le chemin r2v reprend cette version, la couche vision n'y touchant pas (elle produit une chaîne, indépendante de ce schéma).
- Le rebase avait introduit un **doublon de clé** dans `I18N` : `"Sujet"` existait des deux côtés, avec un allemand différent (`Subjekt` contre `Motiv`). La dernière écrasait silencieusement la première. L'entrée de `main` est conservée — les onglets de sujet et les puces d'insertion doivent dire le même mot — et l'allemand des libellés associés a été aligné sur `Motiv`.

La frontière convenue avec l'autre fil tient et a été vérifiée dans le navigateur : les puces d'insertion n'apparaissent que sur `reference2video`, jamais sur `storyboard_v2`, donc aucun jeton `<Subject N>` ne peut fuiter dans le prompt Qwen-Edit via le brief.

---

## 2026-09-21 (suite 4) — Grammaire de prompt Minimax H3 et description des sources par vision

Demande de l'utilisateur : intégrer la mécanique de `BMB12d3/minimax-h3-prompt-composer`, et pouvoir décrire les images sources par un modèle Ollama — nécessaire en Ref2VA pour les notions de `<Subject x>`.

### Ce que fait le composer de référence

Un seul fichier HTML (9 492 lignes), aucune dépendance, aucun appel réseau — même architecture que nous. Il **ne génère rien et n'appelle aucun modèle** : on remplit des champs, il assemble un prompt structuré, il le vérifie, on copie-colle dans ComfyUI. Sa valeur tient à la grammaire H3 et à son validateur ; le reste (planificateur de caméra 3D, extracteur de frames, assistants d'édition) est du cockpit, contraire à la raison d'être de cette démo, et n'a pas été repris.

### Le mécanisme `<Subject x>`, et l'écart qu'il révélait

Deux numérotations distinctes : `<Picture N>` est l'entrée physique ComfyUI 1-indexée (`ref_image_{N-1}`), `<Subject N>` une identité logique, la liaison tenant en une phrase de `subject_definitions`. Nos deux planches r2v **étaient** bien `ref_image_0`/`ref_image_1`, mais le prompt était la chaîne plate `charDesc. locDesc. brief` : rien ne disait au modèle laquelle des deux images était le personnage. Le job passait, l'image sortait — d'où un défaut invisible jusqu'ici. Détail dans `docs/LESSONS.md`, piège n°19.

### Ce qui change

- Ref2VA émet les 6 champs de la grammaire (`buildH3RefPrompt`), les chemins (revue des planches, bypass fiches) passant par le même point unique `submitReference2VideoGraph`.
- I2VA reçoit la phrase d'alignement temporel (`H3_I2V_ALIGNMENT`), absente du template.
- Plafond dur de 7 000 caractères appliqué (`capH3Prompt`), il ne l'était nulle part.
- Les références fournies par l'utilisateur sont décrites par `gemma4:e4b` en vision (`describeRefImages`) — capacité confirmée par l'utilisateur en direct, et sondée au premier usage plutôt que supposée. C'est sur le chemin « Ignorer les fiches » que ça compte le plus : sans fiche générée, c'était la seule chose qui pouvait dire au modèle ce que contiennent ses images.
- UI : attribution des numéros de sujet **par l'app**, jamais saisie (option « implicite », tranchée par l'utilisateur). Légende de slot sous chaque image de référence, et une rangée de puces d'insertion sous le brief pour les cas où plusieurs sujets agissent dans le même plan — « `<Subject 1>` tend la boîte à `<Subject 2>` » n'a aucune autre façon de s'exprimer en Ref2VA.

### Vérifications

JS validé (`node --check`), builder exercé hors navigateur sur cas nominal et cas limites (aucune description, brief sans ponctuation, description déjà ponctuée, troncature à 7 000). UI capturée en headless Chromium en clair et sombre à 1440 et 390 px : puces et légendes correctes, insertion au curseur fonctionnelle, aucun débordement horizontal, aucune erreur JS. Les 4 langues vérifiées. **Aucun rendu réel** : ComfyUI et Ollama tournent sur la machine de l'utilisateur, pas dans la session — l'effet en vidéo reste à constater par lui.

---

## 2026-09-21 (suite 3) — Couverture Krea 2 complète, plus de titre incrusté, et la vraie cause du « je ne vois pas les styles »

Trois demandes de l'utilisateur après le second A/B.

### 1. Pas de titre incrusté par défaut

Arbitrage tranché : Krea 2 rend parfois un titre lisible (« LONE EXPLORER », run de qualification) et parfois du charabia (« TUMLILE », « FIWDE TIMLE », constatés aujourd'hui). Devant un client, le second cas coûte plus que le premier ne rapporte. Les trois suffixes de `buildCampaignFullGraph` demandent désormais une image **sans aucun lettrage**, l'affiche réservant son tiers supérieur à un titre ajouté après coup. Formulation calquée sur `SHEET_CLEAN`, la seule validée en rendu réel sur ce point. La note de `docs/LESSONS.md` qui vantait le titre lisible est marquée comme révisée plutôt que supprimée.

### 2. Tous les chemins Krea 2 passent par le même système de prompt

Audit des appelants de `addKrea2Shot`/`addKrea2Shared` — trois sites, pas un de plus :

| Site | Prompt | Couverture |
|---|---|---|
| `krea2_t2i` (chemin générique) | brief + style | `enrichBrief` (consigne Krea 2 + filtre) |
| `buildCampaignFullGraph` | brief + suffixe de format + style | idem, `campaign_full` est dans `KREA2_WORKFLOWS` |
| `buildCharsheetGraph` / `buildLocsheetGraph` | `SHEET_CLEAN` + description gemma + style | **était le trou** |

Les fiches personnage et décor sont bien rendues par Krea 2, mais leur description vient de `characterSheetFromBrief`/`locationSheetFromBrief` (consignes gemma distinctes, hors `enrichBrief`) : un « ultra-detailed skin, 8k » lâché dans un champ atterrissait tel quel dans le prompt Krea 2. Le filtre est donc appliqué dans `charDescFromFields`/`locDescFromFields`, **point de passage unique** de tous les appelants — mode Auto, mode Réalisateur, projet restauré et menus Personnage/Décor du studio. Une seule ligne par fonction, aucune autre à toucher.

### 3. « Je ne vois pas les 14 styles » — c'était le cache navigateur

Les 14 entrées sont bien présentes et le champ s'affiche : vérifié sur le HEAD courant (`Aucun / Éditorial / Argentique 35 mm / Documentaire / Cinématique / Film noir / Cinéma d'auteur / SF blockbuster / Luxe discret / Packshot produit / Anime / Sérigraphie / Peinture à l'huile / Onirique`). La cause est ailleurs : **`nginx.conf` n'envoyait aucun en-tête de cache**. Sans `Cache-Control`, le navigateur applique sa mise en cache heuristique et continue de servir l'ancien `index.html` après un `git pull` — d'où le `Ctrl+Shift+R` que la doc traîne depuis des mois comme une fatalité. `location /` envoie désormais `Cache-Control: no-cache` : revalidation à chaque requête, 304 si rien n'a changé. Ce n'est pas `no-store`, rien n'est retéléchargé inutilement.

Conséquence : cette modification-ci est la seule du lot à exiger un redémarrage (`docker compose up -d`), `nginx.conf` étant monté dans le conteneur.

### Vérification

12 assertions headless : les 14 libellés dans le champ Style et le champ effectivement visible (display calculé, pas seulement l'attribut) ; `charDescFromFields`/`locDescFromFields` retirent le remplissage y compris la famille ArtStation, et une fiche vide reste vide (le test de truthiness qui pilote le repli sans LLM n'est pas cassé) ; les 3 visuels de campagne exigent une image sans lettrage, l'ancienne formulation a disparu, l'affiche réserve sa zone de titre, le sujet reste en tête et le style est toujours appliqué.

**Non vérifié** : `nginx -t` n'a pas pu être exécuté, Docker n'étant pas disponible dans l'environnement de travail. La modification est d'une ligne dans un bloc existant, mais elle n'a pas été validée par nginx lui-même — à confirmer au redémarrage.

## 2026-09-21 (suite 2) — Premier A/B en image, et élargissement du filtre aux « boosters »

**Premier résultat visuel** (même brief `A red panda astronaut poster…`, 16:9, un rendu par condition — n=1, pas une qualification).

- **Sans enrichissement** : cadrage très serré sur la tête, le panda remplit le cadre, fond noir avec bokeh. Le modèle a **dessiné du faux texte** dans le bas de l'image — « FIWDE TIMLE » — parce que le brief demande littéralement « space for title text ». Aucune place laissée pour un titre : l'affiche est inutilisable telle quelle.
- **Avec enrichissement** : plan plus large, décor de nébuleuse conforme au brief, **aucun texte parasite**, et le tiers supérieur est effectivement libre. C'est la différence entre une image et une affiche exploitable.

L'écart le plus net n'est donc pas la « beauté » mais la **composition** et l'absence de faux texte : l'enrichisseur a traduit « space for title text » en « leaving significant clean negative space at the top for title typography », ce que le modèle interprète comme *laisser de la place* et non *écrire un titre*.

Réserve : la version enrichie a viré vers l'illustration 3D (combinaison argentée inventée, rendu lisse) là où la version brute était plus photographique. Cohérent avec la queue du prompt — `trending on ArtStation, Octane render`.

**Élargissement du filtre.** Le §24 du document de référence n'était qu'un point de départ, pas un inventaire. gemma produit spontanément la famille « booster » héritée de Stable Diffusion, absente de ce §24 : `trending on ArtStation`, `Octane render`. `PROMPT_PADDING` les couvre désormais, avec `cgsociety`, `deviantart`, `pixiv`, `unreal engine`, `v-ray`, `redshift render`, `uhd`. Ajout aussi d'une règle de ponctuation : quand une phrase entière n'est que du remplissage, son retrait laissait un `..`.

Un blocage par liste reste une liste — ajouter un terme est une ligne. C'est assumé : la contrainte est vérifiable en code, donc elle n'a rien à faire dans une consigne adressée à un modèle de 4 Md de paramètres.

### Vérification

9 assertions headless rejouant la sortie gemma réelle du jour : les quatre termes de remplissage disparaissent, le sujet et la consigne de composition restent, `highly reflective` (qui n'est pas du remplissage) survit, et le prompt se termine proprement sur `typography.`. Zéro régression sur `SHEET_CLEAN`, les 14 `STYLE_PACKS` et les formulations de la taxonomie (`high-end CGI render`, `architectural clay model`, `fine detail`, `epic cinematic scale`).

**Reste ouvert** : l'effet du filtre sur l'image n'a pas encore été vu — l'A/B ci-dessus a été rendu avec les boosters encore présents.

## 2026-09-21 (suite) — gemma n'obéit pas à l'interdiction de vocabulaire : filet déterministe

Premier test en rendu réel sur le GB10, après bascule sur la branche. La consigne `KREA2_ENRICH_SYSTEM` porte sur deux points des trois visés, mais pas sur le troisième.

Brief : `A red panda astronaut poster, cinematic lighting, poster composition with space for title text.`

- **Avant** (consigne générique, `main`) : « A whimsical and detailed poster featuring a red panda dressed as an astronaut… vintage sci-fi poster… **Ultra-detailed, photorealistic, 8k**, deep space nebula background, volumetric lighting. » — le prompt s'ouvre sur « poster », et trois directions se disputent (*whimsical*, *vintage sci-fi poster*, *photorealistic*).
- **Après** (nouvelle consigne) : « **A photorealistic red panda astronaut standing confidently**… Cinematic volumetric lighting… Poster composition, centered subject with ample negative space… science fiction aesthetic, **ultra-detailed, 8k, highly rendered**, epic scale. » — le sujet passe en tête, l'ordre sujet → environnement → lumière → composition → style est respecté, et les styles concurrents se réduisent à *photorealistic* + *science fiction*, compatibles.

**Le remplissage, lui, survit.** `ultra-detailed`, `8k` et `highly rendered` traversent une interdiction pourtant explicite. C'est un comportement attendu d'un modèle local de cette taille : une consigne négative enfouie dans une liste de règles n'est pas fiable, surtout en `format: "json"`. Conclusion retenue : **ne pas compter sur le modèle pour une contrainte vérifiable en code**.

`stripPromptPadding()` retire donc ces termes de la sortie de gemma, sur le chemin Krea 2 uniquement, avant que le prompt n'atteigne le graphe et le champ brief. La liste `PROMPT_PADDING` est volontairement étroite — seulement des termes sans direction visuelle (`masterpiece`, `best quality`, `award-winning`, `ultra/hyper/highly/extremely/insanely detailed`, `highly rendered`, `8k`/`4k`/`16k`/`32k`). Vérifié comme survivant intacts : `photorealistic`, `photorealistic CGI`, `fine detail`, `epic cinematic scale` et les mots-clés des 14 `STYLE_PACKS`. Garde-fou : un prompt intégralement composé de remplissage est renvoyé tel quel plutôt que vidé. Une ligne du journal indique le nombre de caractères retirés. La consigne gagne au passage une relecture finale explicite, sans qu'on compte dessus.

### Vérification

11 assertions headless supplémentaires, en rejouant **la sortie gemma réelle observée** comme réponse stubée : les trois termes disparaissent du `CLIPTextEncode` soumis, `epic scale` et la description de composition restent, la ponctuation ne casse pas, le champ brief montre à l'utilisateur le prompt nettoyé, et rien n'est retiré hors Krea 2 (où le négatif continue d'être réécrit normalement).

**Toujours non vérifié** : l'effet sur l'image. Les prompts sont maintenant conformes à la grammaire du document, reste à confirmer que ça se voit au rendu.

## 2026-09-21 — Qualité des contenus Krea 2 : consigne d'enrichissement dédiée + bibliothèque de styles

Point de départ : deux documents fournis par l'utilisateur — une taxonomie des styles visuels Krea 2 (9 familles, 72 styles, séparation style / look / technique / lumière / caméra / composition / couleur / texture) et un system prompt « architecte de prompt Krea 2 » (ordre de construction, sujet d'abord, 40–100 mots, formulations bannies, résolution de conflits). Comparaison faite avec ce que le code fabriquait réellement, puis deux niveaux retenus sur trois proposés (la cible à quatre phases du document — moteur de compatibilité, panneau à dix champs — a été écartée : elle ajoute des réglages là où la démo existe pour en retirer).

### Niveau 1 — l'enrichissement parlait à tous les moteurs et à aucun

`ENRICH_SYSTEM` faisait trois lignes et demandait « un prompt de diffusion + un negative prompt correspondant », quel que soit le moteur ciblé. Sur Krea 2 ce négatif n'arrive nulle part : le `KSampler` reçoit un `ConditioningZeroOut` du positif (piège n°16) et `api/krea2_t2i.json` n'a même pas de placeholder `{{NEGATIVE_PROMPT}}`. Toute contrainte que gemma choisissait de formuler en négatif était donc perdue au lieu d'être reformulée en positif.

- `KREA2_ENRICH_SYSTEM` ajouté : ordre sujet → action → environnement → style → lumière → optique → composition → couleur → matière → atmosphère, sujet nommé en premier, 40–100 mots, vocabulaire de remplissage explicitement banni (`masterpiece`, `8k`, `best quality`…), un seul style dominant, et **toute contrainte exprimée positivement** — la discipline déjà appliquée par `SHEET_CLEAN` aux planches perso/décor.
- `enrichBrief(wf)` choisit la consigne via `isKrea2Workflow(wf)` (`krea2_t2i`, `campaign_full`) et **n'écrit plus jamais** dans le champ négatif pour ces workflows. Le style courant est transmis en ligne `PRIMARY_STYLE` pour que gemma compose autour de lui sans en inventer un concurrent ; il n'est pas réécrit dans le prompt, il est ajouté à la soumission (vérifié : une seule occurrence).
- Champ « Negative prompt » désactivé, avec une note traduite, quand la cible est Krea 2 — plutôt que laissé actif, prérempli et sans effet.
- `storyboard_v2` et `minimax_h3_r2v` passent à `"enrich": "builtin"` dans le manifest. L'auto-enrichissement s'exécutait avant le dispatch vers les builders et réécrivait le brief en y injectant caméra, lumière et composition, alors que `characterSheetFromBrief`/`locationSheetFromBrief` ont pour consigne explicite « no camera/scene/action wording ». Les deux se contredisaient.

### Niveau 2 — 5 styles, et pas là où Krea 2 génère

`STYLE_PACKS` comptait 5 entrées et n'était exposé que sur `storyboard_v2`. Les deux chemins où Krea 2 fabrique les images de la démo (`text2image`, `campaign_full`) n'avaient aucun vocabulaire de style.

- 14 entrées curées sur les 9 familles de la taxonomie (PHOTO, CINE, FASH, CGI, ANIME, ILLU, PAINT, EXP), au format mots-clés + affinités lumière/optique/couleur/texture recommandé par le document, et non plus une phrase figée. Les 5 ids historiques (`none`, `cinematic`, `noir`, `documentary`, `anime`) sont conservés : un projet enregistré garde son style.
- Contrôle `style` ajouté à `text2image`, `campaign_full` et `reference2video` dans `workflows/manifest.json` **et** dans `PIPELINES_FALLBACK` (miroir utilisé si le fetch du manifest échoue).
- Le style est ajouté **en fin** de prompt sur le chemin générique et sur les 3 visuels + le teaser de la campagne : le sujet reste en tête, conformément à l'ordre de priorité sujet > style déjà appliqué par `compileKeyframePrompt`/`compileCutPrompt`.
- Correctif au passage : `currentStyleText()` ne renvoie du texte que si le pipeline courant expose le contrôle `style`. Le `<select>` gardait sa valeur même masqué, si bien que les fiches perso/décor de `reference2video` recevaient « cinematic » sans que rien ne l'affiche. `reference2video` expose maintenant le champ.

### Vérification

`node --check` sur le JS extrait, `manifest.json` relu en JSON. 51 assertions passées dans trois harnais headless (Chromium `headless_shell`) qui pilotent la page réelle via ses propres fonctions et interceptent `fetch` :

- **UI / câblage (25)** — 14 styles dont les 9 nouveaux et les 5 ids historiques ; champ Style visible sur `text2image`, `campaign_full`, `reference2video`, `storyboard_v2` et masqué sur `text2video` ; `currentStyleText()` vide sur un pipeline sans le contrôle (plus de fuite) ; champ négatif désactivé sur Krea 2 et réactivé ailleurs ; libellés et note traduits en EN.
- **Prompts soumis (18)** — graphe `krea2_t2i` intercepté : un seul `CLIPTextEncode`, sujet en tête, style présent et placé après le sujet, aucun texte négatif dans le graphe ; style « Aucun » laisse le brief intact ; sous auto-enrichissement, consigne Krea 2 envoyée, `PRIMARY_STYLE` transmis, champ négatif non écrasé, style présent une seule fois ; hors Krea 2, consigne générique conservée et négatif bien réécrit.
- **Campagne et storyboard (8)** — les 3 visuels Krea 2 et le teaser LTX portent le style, ordre sujet > format > style respecté ; `storyboard_v2` ne déclenche plus l'enrichissement générique.

Captures headless clair et sombre à 390 / 768 / 1250 / 1440 px : le champ Style s'insère dans la barre de génération sans casser la mise en page, et la note du champ négatif se lit en casse normale (elle a été sortie du `<label>`, qui force `text-transform: uppercase`).

**Non vérifié** : aucun rendu GPU réel n'a été fait (ni ComfyUI ni Ollama dans l'environnement de travail). La qualité visuelle effective des nouveaux prompts reste à confirmer par un rendu sur le GB10.

## 2026-09-10 (suite 6) — Guide de dépannage en anglais + réponse sur l'ordre de création du dossier de destination

**Version anglaise.** `docs/TROUBLESHOOTING.md` est désormais en anglais (la langue par défaut du dépôt pour tout ce qui est opérationnel, comme les scripts et `README.md`), et la version française devient `docs/TROUBLESHOOTING.fr.md` — même convention que `README.md` / `README.fr.md`. Les liens sont ajustés partout : `README.md` pointe sur la version anglaise, `README.fr.md` sur la française, chaque arborescence liste les deux, et `AGENTS.md` mentionne les deux. Contrôle d'ancres sur les quatre fichiers : aucun renvoi cassé ; les 21 (GB10) et 23 (x86) blocs de commandes passent `bash -n`.

**Question posée : que se passe-t-il si le dossier de destination n'existe pas encore, ComfyUI n'ayant pas été créé par le script ?** Vérifié par simulation, avec un dossier de modèles hérité et le port 8188 rendu occupé pour que ComfyUI soit `skipped` — donc jamais créé. Le déplacement a lieu quand même et correctement, parce que la destination est garantie par trois niveaux :

1. `create_comfy_stack` fait `mkdir -p "$COMFY_DIR/basedir/models"` quand elle s'exécute ;
2. sinon, `mkdir -p "$COMFY_MODELS_DIR"` est fait juste avant l'appel à `migrate_legacy_models` ;
3. et pour chaque fichier déplacé, `mkdir -p` recrée son sous-dossier de destination.

Sortie du test : `moved: 1   left behind: 0`, puis `SKIP (already present, size matches)` sur le modèle déplacé et `- ComfyUI : skipped (port 8188 busy)` au récapitulatif. Les modèles atterrissent dans `~/comfyui-spark/basedir/models`, c'est-à-dire exactement là où la stack ComfyUI ira les lire quand elle sera créée au passage suivant. Rien n'est perdu, rien n'est retéléchargé.

Corrigé au passage : l'intro de la section « réinstaller » disait encore « **ce qu'il ne fait pas** : déplacer les modèles » — faux depuis le correctif précédent.

## 2026-09-10 (suite 5) — Les modèles de l'ancienne mise en page sont déplacés automatiquement

Question de l'utilisateur : que fait le script des modèles déjà téléchargés mais rangés dans l'ancien dossier (`~/ai-content-studio/comfyui/basedir/models`) ? Réponse d'alors : **rien**. Il affichait deux lignes invitant à faire le `mv` à la main — et seulement dans la branche de migration, donc uniquement si le conteneur hérité était encore présent avec le label compose du dépôt. Conteneur déjà supprimé, ou migration faite lors d'un passage précédent : plus aucun message, et ~150 Go retéléchargés à côté de modèles parfaitement valides.

Nouvelle fonction `migrate_legacy_models`, appelée juste avant l'étape de téléchargement, quand le dossier de destination est définitivement résolu (il peut être celui d'une stack voisine, pas forcément celui qu'on vient de créer) :

- déplacement **fichier par fichier** — `mv dossier/*` échouerait sur un sous-dossier présent des deux côtés, `loras/` typiquement ;
- `mv -n` : jamais d'écrasement d'un fichier déjà à destination ;
- déplacement, pas copie : même système de fichiers, donc instantané, et l'ancien dossier ne reste pas à occuper 150 Go ;
- détection indépendante de l'état du conteneur : le dossier hérité est cherché à chaque exécution ;
- si le dossier hérité appartient à root (le cadenas), le `mv` échoue proprement, le nombre de fichiers laissés est affiché et la commande `chown` exacte est donnée — le script ne fait jamais de `sudo` à votre place.

### Vérification

Simulation d'installation complète avec un faux dossier hérité peuplé de fichiers creux (`truncate`) aux tailles exactes de `scripts/models.txt` : `moved: 3   left behind: 0`, puis `SKIP (already present, size matches)` sur les modèles déplacés et téléchargement du seul fichier dont la taille ne correspondait pas. Récapitulatif final : 3 présents / 17 téléchargés. Test identique sur le fork x86 (1 fichier). Les fichiers hors `.safetensors` et les sous-dossiers imbriqués (`loras/H3/`) sont déplacés correctement.

`docs/TROUBLESHOOTING.md` : l'étape 3 de la procédure de réinstallation ne demande plus de déplacer quoi que ce soit — elle montre la sortie attendue et ne garde d'action manuelle que pour le cas `left behind` non nul.

## 2026-09-10 (suite 4) — Plus aucun français dans les scripts + dépannage mis en avant sur la page d'accueil

Deux manques signalés par l'utilisateur, tous deux exacts.

**1. Le guide de dépannage était invisible.** Il n'était référencé que dans l'arborescence en bas des README — pas sur la page d'accueil du dépôt. Un encadré le pointe désormais juste sous la commande d'installation, dans les deux README : « Quelque chose ne marche pas, ou poste sur lequel une installation a déjà été tentée ? → docs/TROUBLESHOOTING.md ».

**2. Il restait du français dans les scripts.** Le passage précédent n'avait traité que les commentaires des fichiers de déploiement. Restaient :

- `install.sh` : les variables de la boucle de téléchargement (`$dossier`, `$fichier`, `$taille`) — du français dans le code lui-même, pas dans un commentaire ;
- `tools/validate.py` et `tools/onboard.py` : ~95 lignes de docstrings, d'aide argparse et de messages d'erreur, entièrement en français. Ce sont les outils d'onboarding et de qualification des workflows, exécutés à la main : leur sortie compte autant que celle de l'installeur.

Tout est traduit. Vérification : `bash -n`, `python3 -m py_compile`, `--help` des deux outils relu en anglais, et exécution réelle d'`install.sh` (20 modèles reconnus — la boucle de téléchargement fonctionne toujours après le renommage des variables, health-checks 200).

Un balayage systématique sur tous les fichiers `*.sh`, `*.py`, `*.ps1`, `*.yml`, `*.conf` et `Dockerfile` suivis par git ne remonte plus que trois faux positifs : l'opérateur `-le` (« inférieur ou égal ») de test shell.

## 2026-09-10 (suite 3) — `docs/TROUBLESHOOTING.md` : procédure de réinstallation détaillée

La section « réparer une installation existante » se contentait de trois puces et d'un renvoi vers `install.sh` — insuffisant pour le cas le plus fréquent, un poste où une version antérieure du script a déjà tourné. Elle devient une procédure numérotée en 7 étapes : récupération de la bonne version du script (≥ 1.0.8, sinon on relance la version fautive), état des lieux en une commande (ancien dossier de modèles, nouveau, contenu du volume `ollama-data`, espace libre), décision sur l'ancien dossier, lancement avec `tee` vers un journal (la commande dure des heures), **tableau des durées attendues par étape**, les lignes de sortie exactes qui prouvent que la migration a eu lieu, relecture du journal, vérification, et quoi faire à chaque endroit où le script peut s'interrompre.

Explicité aussi : ce que le script fait tout seul (suppression des conteneurs hérités, recréation des stacks, recopie des poids Ollama) et ce qu'il ne fait pas (déplacer les modèles de l'ancien dossier — il ne supprime rien d'autre que les deux conteneurs). Et le cas où aucune ligne de migration n'apparaît : le conteneur ne porte pas le label compose du dépôt, il a été créé à la main, le script n'y touchera jamais.

Vérification : les 21 blocs passent `bash -n`, les étapes non destructives ont été exécutées sur cette machine, et un contrôle d'ancres confirme que les renvois internes pointent tous sur une section existante.

## 2026-09-10 (suite 2) — Attente d'Ollama après création de sa stack

Défaut trouvé en relisant le chemin Ollama : `docker compose up -d` rend la main dès que le conteneur est **démarré**, pas quand le serveur **écoute**. Sur une installation où tous les modèles ComfyUI sont déjà présents (relance, ou modèles pré-copiés), l'étape « modèle Ollama requis » pouvait donc s'exécuter deux ou trois secondes après la création du conteneur et conclure `Ollama unavailable` sur un service qui finissait simplement de démarrer — sans que rien ne soit cassé.

Correctif : `create_ollama_stack` attend désormais `/api/version` (15 essais, 2 s) avant de rendre la main, et avertit si le service reste muet au bout de 30 s. Une ligne, sur le même modèle que l'attente déjà en place pour ComfyUI.

Vérifié au passage sur cette machine : `systemctl cat ollama.service` renvoie bien 1 quand aucune unité n'existe (et 0 sur une unité présente, contrôlé avec `docker.service`) — la détection d'un Ollama natif ne produit donc pas de faux positif sur un poste où Ollama tourne uniquement en conteneur.

## 2026-09-10 (suite) — Commentaires des scripts de déploiement en anglais

Suite du passage de la sortie terminal en anglais (v1.0.7) : les commentaires du code de déploiement le sont aussi désormais, la machine cible pouvant être administrée par quelqu'un qui ne lit pas le français. Traduits : `install.sh` (81 lignes de commentaire), `docker/stacks/comfyui.yml`, `docker/stacks/ollama.yml`, `docker-compose.yml`, `nginx.conf`, et le bloc `CXXFLAGS=-std=c++20` de `docker/userscripts/15-comfy_kitchen-DGX_Spark.sh` (le seul commentaire francophone de ce userscript, celui qui explique pourquoi le standard C++ doit être forcé).

Le fond est conservé mot pour mot : ces commentaires portent les raisons des choix (pourquoi `BASE_DIRECTORY` n'est pas cosmétique, pourquoi les dossiers sont créés avant les conteneurs, pourquoi `sudo -n` et jamais `sudo` tout court, pourquoi `/api/pull` est revérifié). Aucune ligne de code touchée.

Le reste du dépôt — `AGENTS.md`, `docs/`, README, changelog, commentaires de `index.html`/`canvas.html`/`js/` — reste en français : c'est de la documentation de projet, pas de l'outillage de déploiement. Les mentions « commentaires en français » des README sont corrigées en conséquence.

Vérification : `bash -n` sur les scripts, `docker compose config -q` sur les trois fichiers compose, `nginx -t` dans le conteneur en service (le fichier y est monté en lecture seule, c'est donc la config réellement servie qui est validée), et exécution réelle d'`install.sh` — tout réutilisé, health-checks 200.

## 2026-09-10 — documentation — `docs/TROUBLESHOOTING.md`

Guide de dépannage installation/déploiement, issu du diagnostic de la machine neuve : table symptôme → cause (les deux erreurs navigateur `JSON.parse` / `NetworkError` et ce qu'elles signifient réellement, modèles invisibles, dossier cadenassé, Ollama natif, port occupé), diagnostic en trois commandes **à travers le proxy nginx** (c'est ce que fait le navigateur, tester `:8188` en direct masque le vrai problème), réparation d'une installation en ancienne mise en page, et remise à zéro à deux niveaux.

Toutes les commandes non destructives du guide ont été exécutées telles quelles sur ce GB10 avant d'être écrites, et les 17 blocs passent `bash -n`. Deux corrections issues de ces essais :

- Le contrôle d'intégrité des modèles utilise la **même tolérance de 1 %** qu'`install.sh`, et non l'égalité stricte : sur cette machine, deux fichiers en service depuis des semaines (`gemma4-12b-with-proj-ltx-2.5`, `minimax_h3_fl2va_pruned`) diffèrent de quelques kilo-octets des tailles de `scripts/models.txt` — révisions Hugging Face republiées. En strict, le guide aurait fait retélécharger 28 Go de modèles parfaitement valides. La limite est écrite noir sur blanc dans le guide : un fichier tronqué à moins de 1 % reste indétectable par la taille, seul un rendu réel inspecté fait foi.
- La remise à zéro ciblée ne supprime plus une liste de noms de conteneurs en dur mais **filtre sur le label compose** du dépôt : sur une machine où ComfyUI appartient à une stack voisine (cas de la machine de référence, `comfyui-nvidia` géré par `~/comfyui-spark/compose.yaml`), la version en dur aurait détruit un service qui n'a rien à voir avec l'installation ratée.

Guide référencé depuis les deux README et `AGENTS.md`.

## 2026-09-09 (suite) — v1.0.8 — Service installé mais arrêté : redémarré, pas doublé

`install.sh` ne testait que « le service répond-il ? ». Répondre non ne veut pas dire absent : le conteneur peut exister à l'arrêt, ou Ollama être installé nativement et son service systemd stoppé. Dans les deux cas la version précédente créait une stack — conflit de nom de conteneur dans le premier cas (les noms sont uniques), deux Ollama qui se disputent le port 11434 au prochain boot dans le second.

Ordre de traitement quand un service ne répond pas, pour ComfyUI comme pour Ollama :

1. **Conteneur arrêté** (`exited`/`created`/`paused`) portant l'image du rôle → `docker start`, puis attente de la santé HTTP (`restart_stopped_service`). Un conteneur qui démarre sans répondre est signalé comme tel et **rien d'autre n'est créé** — c'est un problème à regarder dans `docker logs`, pas à contourner par un doublon.
2. **Ollama natif arrêté** (`command -v ollama`, ou unité `ollama.service` connue de systemd) → `systemctl start ollama` en root, sinon `sudo -n systemctl start ollama`. Le `-n` est essentiel : il échoue immédiatement au lieu d'attendre un mot de passe qui ne viendra jamais dans un script non interactif. En cas d'échec, la commande à lancer est affichée et aucun conteneur n'est créé.
3. **Port occupé** par autre chose → rien créé, message explicite.
4. **Rien de tout ça** → création de la stack, comme avant.

Ajouté au passage : `wait_for_http` (attente factorisée) et `resolve_comfy_paths` (les bind-mounts du conteneur font autorité sur les chemins par défaut) — cette dernière est maintenant appelée aussi sur le chemin « conteneur redémarré », sans quoi les modèles auraient pu être téléchargés à côté du dossier réellement lu par ce ComfyUI-là.

### Vérification

Détection des conteneurs arrêtés testée sur le vrai Docker de la machine (conteneur `ollama/ollama` créé puis détecté, le conteneur en marche étant bien ignoré, sonde supprimée). Les trois branches testées bout en bout en simulation (`docker`/`curl`/`sudo`/`systemctl` stubés) : conteneur Ollama arrêté → `restarted (ollama-old)` + modèle tiré ; Ollama natif arrêté sans sudo autorisé → `skipped`, marche à suivre affichée, récapitulatif `Ollama unavailable` ; Ollama natif arrêté avec démarrage réussi → `started (native service)` + modèle tiré. Non-régression : exécution réelle d'`install.sh` sur ce GB10, tout réutilisé, chemins résolus, health-checks 200.

## 2026-09-09 — v1.0.7 — Une stack Docker par service à la racine du home (déploiement GB10 corrigé)

Déclencheur : installation sur une machine neuve. Génération impossible, `Error: JSON.parse: unexpected character at line 1 column 1` (le `await res.json()` de `submitGraph` sur une page d'erreur HTML de nginx) et `Enhancement failed: NetworkError`. Cause réelle trouvée en remontant depuis un détail signalé par l'utilisateur — un cadenas sur le dossier `comfyui/` du repo :

1. **`docker-compose.yml` et `install.sh` n'étaient pas d'accord sur l'emplacement des modèles.** Le service `comfyui` du compose de l'app n'avait aucun bloc `environment` — donc pas de `BASE_DIRECTORY: /basedir`, alors que l'image `mmartial` ne relocalise ses modèles que sur cette variable. ComfyUI lisait `/comfy/mnt/ComfyUI/models` pendant qu'`install.sh` téléchargeait dans `/basedir/models`. Manquaient aussi les flags GB10 de la stack de référence (`--disable-pinned-memory --reserve-vram 8`) et `WANTED_UID/GID`.
2. **Dossiers créés par dockerd en `root`.** Les bind-mounts (`./comfyui/basedir`, `./run`, `./userscripts_dir`) étaient créés par Docker au premier `up -d`, donc en root:root : d'où le cadenas, et surtout l'échec en « permission denied » de tous les `mkdir`/`curl` de l'étape 5. Seul `loras/` existait (créé par le bind-mount de l'updater) — d'où un dossier de modèles vide.
3. **Ordonnancement.** Les userscripts (installation de comfy_kitchen) étaient copiés en étape 4, soit APRÈS la création du conteneur en étape 2 — ils ne sont joués qu'au démarrage, donc jamais sur une installation fraîche. Et le script se terminait « OK » sans jamais attendre que ComfyUI réponde sur :8188, alors que son premier boot dure plusieurs minutes.

### Structure retenue (demandée par l'utilisateur, identique au poste de référence)

Une stack par service, chacune à la racine du home : `~/ai-content-studio` (app + updater), `~/comfyui-spark` (ComfyUI), `~/ollama` (Ollama). Le compose du repo ne déclare plus que `ai-content-studio` et `updater` ; les deux voisines sont créées par `install.sh` depuis les gabarits `docker/stacks/comfyui.yml` et `docker/stacks/ollama.yml`. Le gabarit ComfyUI est le décalque de `~/comfyui-spark/compose.yaml` de la machine de référence, **sans le `HF_TOKEN` en dur** (`${HF_TOKEN:-}`) et sans son réseau externe `ai-studio-net`.

### Fichiers touchés

- `docker-compose.yml` — services `comfyui` et `ollama` retirés ; défaut du montage LoRA sur la stack voisine (`../comfyui-spark/basedir/models/loras`)
- `docker/stacks/comfyui.yml`, `docker/stacks/ollama.yml` — nouveaux gabarits
- `install.sh` — `COMFY_DIR`/`OLLAMA_DIR` sous `$HOME`, fonctions `create_comfy_stack`/`create_ollama_stack`/`copy_userscripts`, dossiers créés côté utilisateur AVANT les conteneurs, userscripts déposés avant le premier `up -d`, garde d'écriture sur le dossier de modèles (échec explicite au lieu de 19 téléchargements en erreur), attente de ComfyUI sur :8188 après création, migration depuis l'ancienne mise en page, récapitulatif avec les emplacements réels
- `README.md`, `README.fr.md`, `AGENTS.md` — trois stacks au lieu de trois services, chemins de modèles en `~/comfyui-spark/basedir/models/`
- `VERSION` — 1.0.7

### Sortie terminal en anglais + Ollama détecté au niveau service

Tous les messages d'`install.sh` sont en anglais (commentaires du code laissés en français, comme le reste du dépôt). Deux corrections de robustesse remontées par un test sur poste Ubuntu où Ollama était **installé nativement** (systemd, donc pas un conteneur) : `find_container_by_port` ne trouvait rien, le script tombait sur `OLLAMA_CONTAINER="(inconnu)"` et abandonnait silencieusement le pull du modèle.

- **Pull par l'API HTTP** (`POST /api/pull`, résultat revérifié par `/api/tags` car l'API répond 200 même quand le tirage échoue en cours de flux) au lieu de `docker exec` : identique que Ollama tourne dans notre conteneur, dans celui d'un autre projet, ou nativement. La branche « conteneur non identifié » disparaît.
- **Garde de port** avant toute création de stack : si `:8188`/`:11434` est occupé par un service qui ne répond pas au health-check, rien n'est créé et le script dit quoi libérer — au lieu de laisser Docker échouer sur « port is already allocated ».

Corrigé au passage : `find_container_by_port` pouvait désigner l'updater plutôt que nginx pour le port 8090 (les deux montent la racine du repo en network host) — la destination `/usr/share/nginx/html` les distingue.

### Aucun chemin ni uid en dur

Le poste cible n'a pas le même utilisateur que la machine de référence. `install.sh` ne connaît que `$HOME` et `$REPO_ROOT` (déduit de `BASH_SOURCE`). Le gabarit ComfyUI passe par `WANTED_UID: "${WANTED_UID:-1000}"` / `WANTED_GID` et `install.sh` écrit les valeurs réelles (`id -u`/`id -g`) dans `~/comfyui-spark/.env`, lu par compose y compris lors d'un `docker compose up -d` lancé à la main plus tard. `tools/validate.py` et `tools/onboard.py`, qui pointaient en dur sur `/home/sparks/comfyui-spark/basedir`, dérivent désormais de `COMFY_BASEDIR` avec repli sur `~/comfyui-spark/basedir` ; `docs/TESTING.md` idem. Les chemins `/home/sparks` restants ne sont plus que des relevés historiques (LESSONS, ARCHITECTURE, NOUVEAUX-MODELES, ce changelog).

### Migration d'une machine déjà installée en ancienne mise en page

`install.sh` détecte un conteneur ComfyUI ou Ollama dont le label compose pointe sur le `docker-compose.yml` du repo, le supprime et recrée la stack voisine. Les poids Ollama sont repris du volume nommé `ollama-data` (copie vers `~/ollama/data`, évite 9,6 Go de retéléchargement) ; les modèles ComfyUI de l'ancien `~/ai-content-studio/comfyui/basedir/models` ne sont PAS déplacés automatiquement — le script affiche le chemin et laisse l'utilisateur faire le `mv`.

### Vérification

1. **Chemin réutilisation** : `install.sh` exécuté en vrai sur la machine de référence — les trois services préexistants réutilisés sans être touchés, chemins résolus sur `/home/sparks/comfyui-spark/basedir/models`, 20 modèles reconnus, aucun dossier créé à tort.
2. **Chemin création (poste vierge)** : `install.sh` rejoué avec `docker` et `curl` remplacés par des stubs (aucun conteneur, santé HTTP en échec) et un `$HOME` temporaire — les deux stacks sont créées, tous les dossiers appartiennent à l'utilisateur (aucun dossier root, le bug d'origine), les userscripts sont déposés AVANT le `up -d`, `.env` pointe sur la stack, la boucle d'attente sur `:8188` sort dès que le service répond.
3. **Stack Ollama réellement démarrée** (copie isolée, port 21434, conteneur `ollama-selftest`) : `/api/version` répond, l'entrypoint enchaîne sur `ollama pull gemma4:e4b`, le bind-mount `./data` se remplit. Détruit après coup. C'était la seule pièce nouvelle — l'ancien compose utilisait un volume nommé.
4. **Stack ComfyUI** : `docker compose config` depuis un dossier neuf — `BASE_DIRECTORY`, flags GB10 et les trois montages résolus en absolu sous le dossier de la stack ; `WANTED_UID/GID` prennent bien la valeur du `.env` (testé avec 4242/4343, valeurs arbitraires ≠ 1000).
5. **Outils** : `HOME=/home/alice` → `validate.MODELS_DIR = /home/alice/comfyui-spark/basedir/models` ; `COMFY_BASEDIR=/srv/comfy` → `/srv/comfy/models`.

Non prouvé ici, et qui ne peut l'être que sur la machine cible : le premier boot réel de ComfyUI (build comfy_kitchen) et les téléchargements de modèles.

## 2026-09-08 (suite 2) — v1.0.6 — Mode Réalisateur par défaut sur `reference2video` (revue des fiches avant lancement vidéo) + bypass "Ignorer les fiches" (références utilisateur seules, jusqu'à 9)

Deux lots liés autour du pipeline `reference2video` (Minimax H3, cohérence personnage+décor en un seul job vidéo), demandés par l'utilisateur après constat que le flux Auto seul (aucun arrêt de revue avant un rendu vidéo coûteux) ne convenait pas à cet usage. Les deux vérifiés par un vrai rendu ComfyUI inspecté (jamais le seul statut de job).

### Mode Réalisateur porté sur `reference2video`, DÉFAUT ON (Auto reste le défaut de `storyboard_v2`, inchangé)

Jusqu'ici seul `storyboard_v2` avait un mode Auto/Réalisateur — une coquille studio plein écran (`enterStudio()`, `#studioNav`, `STUDIO_SECTIONS`) à 4 étapes (Personnage → Décor → Storyboard → Montage). `reference2video` n'avait qu'un flux Auto un clic (fiches + vidéo, aucun arrêt de revue). L'utilisateur a demandé un mode Réalisateur pour `reference2video` aussi, mais **allégé** : revoir/régénérer les 2 fiches (personnage, décor) avant de lancer le job vidéo, SANS étape Storyboard/keyframes/Montage (ce pipeline est un seul job vidéo, pas un montage plan par plan) — et **par défaut** pour ce pipeline précisément.

Implémentation : réutilisation du cœur de revue de planches déjà générique côté `storyboard_v2` (`director.charFields/locFields/charVariants/locVariants/charActive/locActive/validated`, `renderSheetMenu`/`regenerateSheet`/`importSheetImage`/`anchorsReady`/`updateValidateButtonState` — aucune de ces fonctions n'était storyboard-spécifique, elles opéraient déjà sur des `kind` génériques `"char"`/`"loc"`), pas une reconstruction. Nouvelles pièces :
- **`director.pipeline`** (`"storyboard_v2"` ou `"reference2video"`) ajouté partout où un `director` est construit : `directorStep1`, le nouveau `directorStepR2V1`, et le chemin de reprise de `restoreProject`.
- **3ᵉ étape minimale dédiée** : `STUDIO_SECTIONS.video` → nouvelle section `#studioVideoR2V` (ligne de statut `#studioVideoR2VStatus` + bouton unique `#directorR2VLaunchBtn` "Lancer la vidéo"), à la place des étapes Storyboard/Montage de `storyboard_v2`.
- **`updateStudioNavForPipeline()`** : montre/masque les onglets `#studioNav` selon `director?.pipeline` — `storyboard`+`montage` pour `storyboard_v2`, `video` pour `reference2video`. `director` absent (juste après un reset) retombe sur la forme `storyboard_v2` par défaut — comportement identique à avant pour toute session non-r2v.
- **`updateGateState()`** branche désormais sur `director?.pipeline === "reference2video"` : pour r2v, active/désactive directement `#directorR2VLaunchBtn` + l'onglet Vidéo sur la même condition (`anchorsReady() && director.validated`) que `storyboard_v2` utilisait déjà pour débloquer son onglet Storyboard — même sémantique, cible différente. **Le choix de tester `=== "reference2video"` plutôt que `=== "storyboard_v2"` n'est pas cosmétique** : `resetDirectorZone()` met `director = null` AVANT d'appeler `updateGateState()`, et avec le test retenu `director` null retombe sur la branche `storyboard_v2` (comportement historique) — un test symétrique inversé aurait laissé les onglets dans le mauvais état à chaque reset. Détail : `docs/LESSONS.md` piège n°18.
- **`directorStepR2V1(seed, width, height)`** (nouveau) : soumet uniquement les 2 jobs de fiches (personnage+décor), construit un `director` allégé — sans `shots`/`keyframes`/`cutPlan` — plus le contexte du job final (`seed, width, height, wf, negText, duration, turboOn, loraName`) **figé à cet instant précis** pour que le lancement, plus tard, ne relise pas un formulaire que l'utilisateur aurait modifié entre-temps (même principe déjà appliqué par `directorStep1` pour son propre champ `style`).
- **`generateReference2VideoFromDirector()`** (nouveau, câblée sur le bouton `#directorR2VLaunchBtn`) : lit `charName`/`locName`/`charDesc`/`locDesc` de la session `director` validée (getters déjà existants — variante active / champs édités) au lieu de régénérer quoi que ce soit, puis exécute exactement la seconde moitié de ce que le chemin Auto faisait déjà. Cette queue commune (collecte des références supplémentaires → construction du graphe → greffe refs/turbo/style-LoRA → soumission) a été extraite dans un nouveau helper **`submitReference2VideoGraph({...})`**, appelé à la fois par le chemin Auto et par ce nouveau chemin de lancement Réalisateur (seule différence entre les deux appelants : d'où viennent `prompt`/`image`/`image2`).
- **`BUILDERS.reference2video`** dispatche désormais vers `directorStepR2V1` quand le mode Réalisateur est actif (miroir de ce que `storyboard_v2` fait déjà vers `directorStep1`), au lieu d'appeler systématiquement le chemin Auto.
- **`updateModelOptions()`** appelle `setDirectorMode(true)` spécifiquement quand le pipeline nouvellement sélectionné est `reference2video` (sans toucher au défaut existant de `storyboard_v2`, qui reste ce que l'utilisateur a réglé en dernier, Auto/`false` par défaut au chargement de la page).
- `"mode"` ajouté aux `controls` de `reference2video` (`PIPELINES_FALLBACK` dans `index.html` **et** `workflows/manifest.json`) pour que les boutons Auto/Réalisateur existants deviennent visibles sur ce pipeline.

**Correctif induit, non explicitement demandé mais nécessaire à la correction** : `saveProject()` (persistance de session LOT C, clé localStorage `studioProject`) est désormais gardée par `director.pipeline === "storyboard_v2"` uniquement (`if (!director || director.pipeline !== "storyboard_v2") return;`). Une session Réalisateur `reference2video` n'a rien d'analogue à "reprendre" (2 fiches puis un seul job vidéo, pas de `shots`/`keyframes`/`cutPlan`) ; sans cette garde, `saveProject()` aurait écrit un blob de projet malformé/incomplet que `restoreProject()` ne sait reconstruire que sous la forme `storyboard_v2` (elle force `pipeline: "storyboard_v2"` sur tout ce qu'elle restaure) — cassant silencieusement ou corrompant la reprise pour de vraies sessions `storyboard_v2` partageant la même clé `localStorage`.

**Vérifié en rendu réel (jamais sur le seul statut de job) :**
- **`storyboard_v2` re-testé de bout en bout** pour confirmer zéro régression : les 4 onglets restent intacts, revue/gate des planches inchangée, Storyboard/Montage toujours atteignables exactement comme avant.
- **`reference2video` Réalisateur** : défaut ON confirmé, le studio n'affiche que Personnage/Décor/Vidéo, revue de planches fonctionnelle, lancement correctement gaté, un vrai rendu soumis depuis une session VALIDÉE — graphe ComfyUI en file inspecté avant soumission : `ref_image_0`/`ref_image_1` pointaient bien vers les images des planches validées (pas des planches fraîchement régénérées). Sortie réelle `minimax_h3_r2v_00007_.mp4` — 1376×768, h264+aac, 2,33 s — confirmée par `ffprobe` et une frame médiane décodée montrant le bon personnage/décor (pas de contenu corrompu/générique).
- **Mode Auto re-confirmé fonctionnel** : basculé explicitement en arrière, fiches fraîches régénérées comme avant.

### "Ignorer les fiches" — bypass complet, références utilisateur seules, cap porté de 7 à 9

Nouvelle case à cocher `#skipSheetsToggle` (contrôle manifest `"skipSheets"` → wrap `skipSheetsWrap`, `reference2video` seul, dans `PIPELINES_FALLBACK` **et** `workflows/manifest.json`). Cochée, saute entièrement `submitCharsheetJob`/`submitLocsheetJob` — fonctionne identiquement en mode Auto ou Réalisateur (`BUILDERS.reference2video` vérifie le bypass **avant** de tester le mode Réalisateur, puisqu'il n'y a rien à revoir quand rien n'est auto-généré : bypass coché route toujours vers le chemin Auto, quel que soit l'état du toggle mode).

Mécanique : les 2 **premiers** fichiers de l'input multi-fichiers déjà existant "images de référence supplémentaires" (`#refImagesInput`, jusqu'ici réservé au mécanisme d'extras d'un chantier antérieur) sont uploadés via `uploadRefFile()` (déjà existant) et deviennent directement `ref_image_0`/`ref_image_1` (arguments `image`/`image2` de `buildGraph`) — confirmé contre le vrai template `workflows/api/minimax_h3_r2v.json` : nœuds `137`/`139`, des `LoadImage` câblés sur `{{IMAGE}}`/`{{IMAGE2}}`, alimentant `MiniMaxH3ReferenceToVideo.inputs["ref_images.ref_image_0"]`/`["ref_images.ref_image_1"]`. Les fichiers **restants** (3ᵉ et suivants) passent par le mécanisme d'extras existant `collectRefExtras()`/`addMinimaxRefs()`, **totalement inchangé** — `collectRefExtras` a seulement gagné un paramètre optionnel `imageFiles` pour que le chemin bypass lui passe "les fichiers à partir du 3ᵉ" au lieu de le laisser relire `#refImagesInput.files` brut ; les caps/index propres au mécanisme d'extras (7 pour les images, indexation `ref_image_{i+2}`) n'ont pas été touchés. Net : 2 fichiers (bypass, en `image`/`image2`) + jusqu'à 7 (extras inchangés) = **jusqu'à 9 références au total**, toutes fournies par l'utilisateur — obtenu sans toucher aux caps/index du mécanisme d'extras, seulement en changeant où vont les 2 premiers fichiers. Le prompt vidéo retombe sur le seul texte brut du brief (`brief.value.trim()`) quand le bypass est actif, faute de `charDesc`/`locDesc` disponibles. Validation : erreur explicite levée avant toute soumission si moins de 2 fichiers sont attachés au moment où le bypass est coché (`ref_image_0`/`ref_image_1` sont structurellement requis par le template, un job ne peut pas être soumis sans eux).

**Vérifié en rendu réel** : 3 fichiers image réels attachés, bypass coché (testé avec le mode Réalisateur également activé, pour confirmer qu'il court-circuite bien toute l'UI de revue et route directement vers la génération, zéro entrée en studio) — graphe en file confirmé avec `ref_image_0`/`ref_image_1`/`ref_image_2` exactement les 3 fichiers uploadés (le 3ᵉ via le chemin d'extras `addMinimaxRefs` inchangé, pas un cas spécial), sortie vidéo réelle confirmée par `ffprobe` + une frame décodée montrant un contenu cohérent. Les cas 0 fichier et 1 fichier confirmés lever l'erreur de validation avant toute soumission de job.

### Fichiers touchés
`index.html` (JS uniquement : `director.pipeline`, `STUDIO_SECTIONS.video`, `#studioVideoR2V`/`#directorR2VLaunchBtn`, `updateStudioNavForPipeline`, `updateGateState`, `directorStepR2V1`, `generateReference2VideoFromDirector`, `submitReference2VideoGraph`, `BUILDERS.reference2video`, `updateModelOptions`, `saveProject`, `#skipSheetsToggle`, `collectRefExtras`), `workflows/manifest.json` (`controls` de `reference2video` : `+mode`, `+skipSheets`).

## 2026-09-08 (suite) — v1.0.5 — Logo Dell réel, parité rail Canvas/Studio, LoRA en accès libre (découverte live + upload), sélecteur de style porté sur Studio, références r2v étendues

Six lots indépendants, tous vérifiés en conditions réelles (plusieurs avec un vrai rendu ComfyUI), livrés dans la même session.

### Logo Dell Technologies réel (`assets/dell-technologies-logo.png`)
L'utilisateur a fourni un vrai logo Dell Technologies (PNG 658×85, fond transparent, gris uni `rgb(169,169,169)`). Remplace deux approximations : côté Studio (`index.html`), le `.brand-mark` CSS-dessiné (bordures biseautées imitant un "D") + le texte littéral "Dell Technologies" cèdent la place à un `<img>` (`height:28px`, échelle du header) ; côté Canvas (`canvas.html`), l'ancien SVG deux tons (`#007db8`/`#808080`, illisible sur fond sombre sans un fond blanc forcé en CSS) est remplacé par le nouveau PNG neutre, ce qui permet de retirer le hack `.brand-logo { background:#fff; padding; border-radius }` — le nouvel asset se lit tel quel dans les deux thèmes. `assets/dell-technologies-logo.svg` supprimé après vérification qu'aucune autre référence ne subsistait.

### Séparateur de rail + parité du switcher Canvas/Studio
`index.html` : `.rail-top` (le duo de pilules Studio/Canvas en tête du rail d'icônes gauche) gagne `border-bottom`/`padding-bottom`/`margin-bottom` — un vrai séparateur visuel entre ce bloc d'identité et les boutons icône-seule en dessous (Node Monitor/Model Management/Local LLM/Advanced), qui n'avaient jusqu'ici aucune respiration. `canvas.html` : le lien de sortie vers `index.html` se limitait à un unique emoji `⌂` noyé dans la rangée d'icônes utilitaires (thème/fit/clear). Remplacé par une vraie paire de pilules `.rail-switch` sous le logo — "Canvas" (active, dégradé plein) + "Studio" (outline, lien vers `index.html`) — mêmes SVG que le rail de Studio, traduits dans les tokens déjà existants de `canvas.html` (`.rail-pill-active` reprend la recette dégradé de `.btn-primary`, `.rail-pill-outline` celle de `.btn-outline`) plutôt que copiés tels quels. L'ancien `⌂` et son entrée i18n ("App formulaire") retirés.

### Découverte live des LoRA (Canvas) — fin de la liste curée à la main
`js/engine.js` limitait `KREA2_LORAS` à 3 fichiers choisis à la main (en excluant volontairement des fichiers à contenu explicite présents dans le même dossier disque) et `H3_STYLE_LORAS` à un unique placeholder `["", "Aucun"]`. **Demande explicite de l'utilisateur : retirer cette curation** — tout `.safetensors` réellement présent sous `loras/Krea2/`/`loras/H3/` doit apparaître, contenu explicite inclus. Nouvelle fonction `fetchLoraOptions()` : scan de `GET /object_info/LoraLoaderModelOnly` (endpoint ComfyUI existant, déjà re-scanné en direct par ComfyUI à chaque appel — vérifié empiriquement qu'un fichier tout juste déposé apparaît sans redémarrage) — zéro nouveau backend pour cette partie. `KREA2_LORAS`/`H3_STYLE_LORAS` deviennent des tableaux mutables, peuplés en `push` (pas réassignés) par un fetch fire-and-forget au chargement du module, filtrés par préfixe de dossier (`Krea2/…`, `H3/…`) et par un nouvel ensemble `H3_TURBO_LORAS` (les 2 LoRA turbo déjà pilotées par le toggle turbo/steps dédié — seules exclusions, aucun autre filtre). Piège découvert au passage : `js/nodes-simple.js`/`js/nodes-advanced.js` passaient un tableau **déjà résolu** (`E.KREA2_LORAS.map(l => l[0])`) aux combos litegraph — comme le fetch réseau se termine après la construction du nœud, le combo restait figé sur la liste vide initiale. Corrigé en passant une **fonction** (`values: () => E.KREA2_LORAS.map(...)` / référence `loraIds`/`h3LoraIds`) — litegraph relit `options.values()` à chaque ouverture du menu (confirmé en lisant `litegraph.js`), donc le menu reflète toujours l'état courant du tableau.

### Téléversement de LoRA depuis le navigateur (Studio) — nouvelle capacité backend
Deux options envisagées (upload navigateur vs téléchargement serveur par URL) ; la seconde écartée après un passage sécurité qui a signalé le profil de risque type SSRF d'un serveur qui irait chercher une URL fournie par l'utilisateur — **seul l'upload a été construit**. `docker/updater/server.py` (le petit serveur HTTP stdlib qui exposait déjà `GET /status`/`POST /apply` pour la mise à jour git depuis l'UI, cf. suite 3 du 2026-09-07) étendu : `HTTPServer`→`ThreadingHTTPServer` (un gros upload ne doit pas bloquer le polling de `/status`), nouvel env `LORAS_DIR`, nouvelle route `POST /loras/upload?folder=<Krea2|H3>&filename=<nom>.safetensors` — corps de requête = octets bruts du fichier (pas de parseur multipart : `python:3-alpine` en 3.12 n'a plus le module `cgi`, et le frontend XHR le `File` brut en query string + body). `folder` validé contre une liste blanche stricte à 2 valeurs, `filename` assaini (nom nu, extension `.safetensors` uniquement, aucune traversée de chemin), écriture en streaming par blocs de 1 Mo dans un fichier `.part`, puis `os.rename()` atomique vers le nom final seulement après vérification du compte d'octets — nécessaire car `/object_info`/`/models/loras` re-scannent le dossier à chaque appel ComfyUI : un fichier partiellement écrit visible en cours d'upload pourrait être sélectionné et utilisé cassé. `docker-compose.yml` : service `updater` gagne `LORAS_DIR=/loras` + le volume `${COMFY_LORAS_DIR:-./comfyui/basedir/models/loras}:/loras:rw`. `install.sh` : après sa détection déjà existante du vrai chemin hôte d'un ComfyUI externe réutilisé (ce poste ne démarre pas son ComfyUI via ce `docker-compose.yml`, il réutilise un conteneur du projet voisin `comfyui-spark`), écrit désormais un `.env` (`COMFY_LORAS_DIR=$COMFY_MODELS_DIR/loras`) et force `docker compose up -d --build --force-recreate updater` pour que le nouveau mount prenne effet. `nginx.conf` : `location /update/` gagne `client_max_body_size 10g;` (des LoRA de plusieurs Go dépasseraient sans ça la limite par défaut de 1 Mo). `.gitignore` : ajout de `.env` (généré par `install.sh`, spécifique à la machine). `index.html` : nouvelle carte "LoRAs" dans le panneau Model Management — inventaire live (`GET /comfy/models/loras`, même schéma que `diffusion_models`/`checkpoints` déjà affichés là) + formulaire d'ajout (dossier Krea2/H3, fichier `.safetensors`, bouton Téléverser) câblé en `XMLHttpRequest` (nécessaire pour la progression réelle via `xhr.upload.onprogress`, pas disponible avec `fetch`). **Vérifié en conditions réelles** : un fichier de 5 Mo téléversé depuis l'UI live, confirmé identique octet pour octet sur disque, confirmé apparu immédiatement dans le listing live de ComfyUI, fichier de test supprimé après coup.

### Sélecteur de LoRA de style porté sur Studio (jusqu'ici Canvas seul l'avait)
Studio (`index.html`) n'avait aucune UI de LoRA de style, même après le lot #3 ci-dessus. Port : `index.html` étant un fichier autonome (n'importe pas `js/engine.js`, même convention "dupliquer, pas partager" déjà utilisée pour les mégapixels/steps turbo portés lors d'une session antérieure), duplication verbatim de `H3_TURBO_LORAS`/`KREA2_LORAS`/`H3_STYLE_LORAS`/`loraLabel()`/`fetchLoraOptions()`, plus une nouvelle `renderLoraSelect()` qui repeuple le `<select id="loraStyleSelect">` — contrairement aux combos litegraph de Canvas, un `<select>` DOM a besoin d'un rendu explicite (rappelé au changement de pipeline/modèle via `updateModelLabel()` et une fois le fetch résolu). Nouvelle fonction générique `applyStyleLora(graph, loraName, anchorClassType)` — greffe une `LoraLoaderModelOnly` en amont du nœud dont le `class_type` est `anchorClassType`, en reciblant tout ce qui pointait vers la même sortie `model`. Anchor généralisé car les templates diffèrent : `KSampler` pour `krea2_t2i`, `BasicScheduler` pour les 3 templates Minimax H3 (les deux confirmés en lisant les JSON réels, pas supposés). Câblé dans `CONTROL_WRAPS` (`lora`→`loraStyleWrap`) et les `controls` de `text2image`/`text2video`/`image2video`/`reference2video` (`PIPELINES_FALLBACK` + `workflows/manifest.json`) — pas sur `image2image` ni sur les fiches personnage/décor internes de `storyboard_v2`/`campaign_full` (Canvas a bien un style LoRA sur ses `CharsheetNode`/`LocsheetNode`, mais le câblage dans l'orchestration multi-jobs de Studio était hors périmètre de ce lot — écart réel, noté pour un futur lot). Appelée **après** `applyMinimaxTurbo` dans tous les sites d'appel — jamais avant, car `applyMinimaxTurbo` retrouve sa propre LoRA par `class_type` et une LoRA de style insérée en premier serait retrouvée à sa place. **Vérifié en rendu réel** : Krea 2 + une LoRA de style sélectionnée → graphe ComfyUI mis en file inspecté (nouveau nœud `LoraLoaderModelOnly` correctement greffé avec le bon `lora_name`, `KSampler.inputs.model` reciblé dessus) → image de sortie récupérée et confirmée visuellement conforme au style choisi (ni vide ni corrompue).

### Références supplémentaires pour `reference2video` (Studio) — Canvas les avait déjà
Canvas (`Ref2VideoNode`/`js/engine.js`) supportait déjà jusqu'à 7 images de référence en plus des 2 planches auto-générées (9 au total), 3 vidéos, 3 audios, via `addMinimaxRefs(graph, refs)` — un greffon générique qui retrouve le nœud `MiniMaxH3ReferenceToVideo` et câble des `LoadImage`/`LoadVideo`+`GetVideoComponents`/`LoadAudio` sur ses familles d'entrées `ref_images.ref_image_N`/`ref_videos.ref_video_N`/`ref_video_audios.ref_video_audio_N`/`ref_audios.ref_audio_N` (une vidéo de référence fournit son audio automatiquement via les 2 sorties de `GetVideoComponents`, aucune UI séparée nécessaire pour cet appariement). `generateReference2Video` côté Studio était figée à exactement `ref_image_0`/`ref_image_1` (charsheet/locsheet), sans moyen d'en ajouter. `addMinimaxRefs` porté verbatim dans `index.html`. Nouvelle UI : 3 champs `<input type=file multiple>` natifs (images/vidéos/audios), visibles uniquement pour `reference2video`, même idiome "multi-fichier natif, cap + avertissement à la soumission" que la séquence FLF2V déjà présente dans ce fichier (`seqFiles`) — en plus simple, sans UI de réordonnancement (ces références n'ont pas de contrainte d'ordre contrairement à une séquence FLF2V). Nouvelle `collectRefExtras()` : cap à 7/3/3, avertit et tronque au-delà, upload en parallèle via `/upload/image` (endpoint ComfyUI non restreint par content-type malgré son nom, déjà utilisé ainsi pour vidéo/audio ailleurs dans ce fichier). Câblé dans `CONTROL_WRAPS` (`refs`→`refExtrasWrap`) et les `controls` de `reference2video` seul. **Vérifié en rendu réel** : une vraie image attachée comme référence supplémentaire → graphe mis en file inspecté, `MiniMaxH3ReferenceToVideo.inputs["ref_images.ref_image_2"]` pointant vers un nouveau nœud `LoadImage` greffé avec le fichier uploadé → vidéo de sortie téléchargée et confirmée cohérente (non corrompue), durée/résolution/piste audio toutes correctes.

## 2026-09-08 — v1.0.4 — Studio : mégapixels + steps turbo H3, portés depuis Canvas

Canvas (`canvas.html`+`js/engine.js`) avait déjà, depuis une session de dev antérieure, un
sélecteur de mégapixels et un choix de steps pour la LoRA turbo Minimax H3 ; Studio
(`index.html`) était resté sur l'ancienne table `RATIOS` fixe et un turbo figé à 8 steps
implicites. Portage **verbatim** de la logique Canvas déjà validée côté rendu réel, plutôt
qu'une re-dérivation — mêmes formules, mêmes constantes.

### Mégapixels/résolution (`#mpSelect`, 14 valeurs de 0.2 à 2.0)
Nouvelle fonction `computeMPResolution(mp, ratioStr, unit)` (formule identique à
`js/engine.js` : `largeur = round(sqrt(1.045 · mp · 1e6 · ar) / unit) · unit`, `ar` inversé
pour la hauteur). Remplace la table `RATIOS` pour les 3 pipelines vidéo `text2video`,
`image2video` et `reference2video` uniquement (`text2image`/`image2image` gardent `RATIOS`
inchangée). Unité d'arrondi dépendante du moteur (`mpUnitForEngine`) : **64 pour LTX 2.5**
(architecture 2 passes base+upsample, corruption silencieuse de la résolution sans cet
arrondi), **32 pour Minimax H3** (inchangé). Moteur déduit du préfixe d'id du workflow
(`ltx25_*` vs `minimax_h3_*`), pas d'un champ UI séparé.

### Steps LoRA turbo H3 (`#turboSteps`, 4/6/8, défaut 8 — t2v/i2v seulement)
`applyMinimaxTurbo(graph, turboOn, steps)` passe à 3 arguments (`steps` optionnel,
rétrocompatible : omis, le comportement est strictement celui d'avant). Turbo ON + `steps`
fourni : 6 ou 8 conservent la LoRA turbo du template et fixent `BasicScheduler.steps` ; **4
bascule sur un LoRA différent**, `H3/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors`
(nouvelle constante `MINIMAX_FL2V_LORA_4STEP`), parce que la LoRA turbo d'origine casse la
colorimétrie à 4 steps (constat toujours valide, LESSONS piège n°12) alors que cette
nouvelle LoRA a été spécifiquement entraînée pour 4 steps et validée sans ce défaut (rendu
réel, session Canvas antérieure). **Contrainte préservée depuis Canvas** : cette LoRA
`fl2v` n'est compatible qu'avec le checkpoint `*_fl2va_*` de t2v/i2v — `reference2video`
utilise un checkpoint `*_ref2va_*` différent et non interchangeable, donc pas de sélecteur
de steps pour r2v : `applyMinimaxTurbo(graph, turboOn)` y reste appelée à 2 arguments,
comportement turbo-ON-8-steps/turbo-OFF-20-steps inchangé.

### Suivi UI (même session)
`#turboToggle` est désormais grisé/désactivé quand le workflow sélectionné est LTX 2.5 (la
LoRA n'existe pas dans ses templates, le contrôle était cliquable mais sans effet).
`#turboSteps` est grisé dès que LTX 2.5 est sélectionné, ou que `#turboToggle` est décoché.
Nouvelle fonction `updateTurboControls()`, appelée depuis `updateModelLabel()` et sur
l'événement `change` de `#turboToggle`. CSS : `textarea:disabled, input:disabled,
select:disabled { opacity: .45; cursor: not-allowed; }`.

`workflows/manifest.json` : `controls` de `text2video`/`image2video` gagnent `mp` et
`turboSteps` ; `reference2video` gagne `mp` seul.

**Vérifié en rendu réel** (mp=0.3, ratio 1:1, Minimax H3, steps=4) : graphe soumis avec
`w0=544 h0=544`, `.mp4` rendu confirmé par `ffprobe` à 544×544, 39 frames @ 24 fps ; graphe
ComfyUI mis en file confirmé avec `BasicScheduler.steps=4` **et** `lora_name` pointant vers
le nouveau LoRA `fl2v_turbo_4step`, pas l'ancien.

## 2026-09-07 (suite 5) — v1.0.3 — Correctif : install.sh ne démarrait jamais le service updater

Bug trouvé lors d'une relecture d'`install.sh` : sur une installation fraîche, le script
démarrait bien ComfyUI, Ollama et l'app web, mais oubliait le 4e service du
`docker-compose.yml`, `updater` (backend du module de mise à jour depuis l'UI, voir suite 3
ci-dessous). Résultat silencieux — aucune erreur à l'installation, le popup de mise à jour ne
fonctionnait simplement jamais côté Studio/Canvas.

Correctif : ajout d'un bloc `docker compose up -d updater` inconditionnel en section 2/7,
d'une ligne dédiée dans le récapitulatif final (section 7/7), et d'un health-check réel sur
`/update/status` (et non une simple vérification que le conteneur est "up"). Vérifié en
conditions réelles : HTTP 200 sur `/update/status`, comportement idempotent sur 2 exécutions
successives d'`install.sh`.

## 2026-09-07 (suite 4) — v1.0.2 — Galerie Canvas (onglets + glisser-déposer), logo Dell, renommage et reclassification des cartes

### Galerie Canvas (`js/canvas-gallery.js`, nouveau, chargé par `canvas.html`)
Tiroir fixé en bas de l'écran (poignée "Galerie"), qui s'ouvre à ~22 % de la hauteur d'écran
au clic. Reprend le principe de la galerie de `index.html` (vignettes cliquables sur
l'historique ComfyUI) mais en version simplifiée : deux onglets séparés Images/Vidéos (même
logique que `.gallery-tabs`/`switchGalleryTab` côté Studio), alimentés par `GET
/history?max_items=24` sur ComfyUI. Persistance via une clé `localStorage` dédiée, distincte
de celle du Studio — la galerie survit donc aux rechargements de la page Canvas. Chaque
vignette est `draggable` et peut être glissée-déposée sur une carte "Import média" posée sur
le canvas, qui reçoit alors directement la référence du fichier déjà présent côté serveur
ComfyUI (aucun ré-upload déclenché).

### Portage depuis un repo voisin (dev)
Les 4 éléments suivants ont été portés depuis un repo de développement voisin, jamais
mentionné publiquement dans le README :
- Logo Dell Technologies réel (`assets/dell-technologies-logo.svg`) affiché dans le panneau
  flottant gauche du Canvas, sur fond clair fixe (le SVG source utilise des couleurs fixes
  `#007db8`/`#808080`, illisibles telles quelles sur fond sombre).
- Renommage de cartes pour plus de clarté fonctionnelle : Krea 2 → "Création d'image",
  Qwen-Edit → "Édition d'image", Personnage → "Fiche de personnage", Décor → "Fiche de
  décor".
- Reclassification du mode avancé : Fiche de personnage, Fiche de décor et Storyboard sont
  désormais classées dans la catégorie "Image" (et non plus "Vidéo"), ces cartes produisant
  des images et non des vidéos.
- Boutons "+" ajoutés sur les entrées charsheet/locsheet de la carte Reference2Video.

Le repo voisin a sa propre galerie plein écran ; elle n'a **délibérément pas** été portée,
le tiroir déjà en place dans ce repo (voir ci-dessus) la remplace fonctionnellement.

## 2026-09-07 (suite 3) — v1.0.1 — Mise à jour depuis l'UI (popup Studio/Canvas)

Cadré via `/architect` (deux points tranchés avec l'utilisateur : check au chargement de page
uniquement, pas de poll en tâche de fond ; aucune authentification sur les nouveaux
endpoints, cohérent avec `/comfy/`/`/ollama/`) puis exécuté par tour-de-controle en 2 lots
parallèles (backend/frontend, fichiers disjoints, contrat JSON figé au plan) + vérification
d'intégration par l'orchestrateur.

### Nouveau service `updater` (`docker/updater/Dockerfile`, `docker/updater/server.py`)
Serveur HTTP Python stdlib (zéro dépendance), `network_mode: host`, écoute
`127.0.0.1:8093` — le port 8091 initialement prévu au plan était déjà occupé par un
conteneur de prod sans rapport (`ai-content-studio-cockpit-web`), vérifié avant bascule.
Monte le repo en lecture-écriture (`./:/repo:rw`, contrairement au mount `:ro` de nginx) via
`REPO_DIR` (défaut `/repo`). Deux routes : `GET /status` (compare `git rev-parse HEAD` local
à `git ls-remote origin main` distant) et `POST /apply` (`git fetch` + `git pull --ff-only`,
refuse proprement si le working tree n'est pas clean — jamais de force/stash). Ajouté à
`docker-compose.yml`, reverse-proxifié par `nginx.conf` sous `location /update/` (même
modèle que le bloc `/ollama/` existant).

### `js/update-check.js` (nouveau, partagé Studio + Canvas)
Au chargement de `index.html` et `canvas.html` : `fetch("update/status")` (silencieux si le
service est down) → si mise à jour dispo, `confirm()` natif ("l'installer ?") → sur oui,
`POST update/apply` → sur succès, `confirm()` natif ("rafraîchir maintenant ?") →
`location.reload()`. Décision prise après lecture du code réel : aucun système de modale
custom n'existait dans ces deux pages (juste une lightbox média inadaptée dans `index.html`
et un `confirm()` déjà utilisé une fois pour la suppression) — `confirm()`/`alert()` natifs
retenus plutôt que d'en inventer un.

### Vérification (orchestrateur, pas seulement les rapports de lots)
Re-lu chaque diff (`docker-compose.yml`, `nginx.conf`, `index.html`/`canvas.html` : +1 ligne
chacun, 0 suppression). Cycle complet `/status`→`/apply`→`/status` rejoué sur un **clone
jetable** du repo (jamais sur la prod réelle) désynchronisé d'un commit : `updateAvailable`
passe bien de `true` à `false` après un apply réussi, avec les bons SHA à chaque étape.
Sur le vrai repo de prod (dirty pendant ce chantier) : `/apply` refuse bien
(`{"success": false, "error": "working tree not clean"}`) sans toucher à git. Processus de
test et clone jetable nettoyés après coup.

### Réserve assumée (signalée, pas corrigée dans ce lot)
Les deux endpoints sont exposés sans authentification sur le port 8090 déjà public — décision
explicitement validée par l'utilisateur au cadrage (cohérence avec `/comfy/`/`/ollama/`,
usage perso/LAN), pas un oubli. Limite du MVP également assumée : un futur commit qui
toucherait `nginx.conf`/`docker-compose.yml` ne serait pas pleinement appliqué par un simple
`git pull` (pas de restart de conteneur automatique).

## 2026-09-07 (suite 2) — Installation automatique (`install.sh`), URLs de modèles vérifiées, comfy_kitchen embarqué

Chantier de fiabilisation du déploiement : jusqu'ici la procédure était manuelle (`docker
compose up -d` + téléchargement des modèles un par un, avec plusieurs URLs jamais vérifiées)
et `comfy_kitchen` (accélération d'attention ARM64/DGX Spark) devait être installé et câblé
à la main.

### `install.sh` (nouveau, racine)
Script bash unique, idempotent (testé sur deux exécutions consécutives : réutilisation
confirmée, aucun retéléchargement). Détecte les 3 services (app web `:8090`, ComfyUI
`:8188`, Ollama `:11434`) **par rôle réel** (santé HTTP), pas par nom de conteneur —
réutilise tout ce qui tourne déjà et ne recrée/ne détruit jamais un conteneur qu'il ne
possède pas (vérification par les labels docker-compose). Met à jour ComfyUI par
`pull`+`recreate` uniquement s'il est géré par CE `docker-compose.yml`. Copie
`docker/userscripts/*.sh` vers le dossier `userscripts_dir` réel du conteneur ComfyUI
utilisé. Télécharge les modèles manquants depuis `scripts/models.txt` (skip si déjà présent
avec la bonne taille). Gère un `HF_TOKEN` optionnel en variable d'environnement pour les
dépôts Hugging Face gated (`HF_TOKEN=xxx ./install.sh`). Tire `gemma4:e4b` sur Ollama si
absent.

### `scripts/models.txt` (nouveau) — 19 fichiers, URLs vérifiées par requête HTTP réelle
Deux réserves honnêtes, documentées dans le README, pas escamotées :
- Les 4 fichiers LTX 2.5 viennent d'un dépôt Hugging Face **gated** — téléchargement anonyme
  en 401 tant que les conditions n'ont pas été acceptées sur `huggingface.co/Lightricks/LTX-2.5`
  avec un compte, et qu'un jeton d'accès n'a pas été fourni (`HF_TOKEN`).
- Les 3 fichiers Minimax H3 (2 checkpoints quantifiés `w4a8_mixed` + LoRA turbo) viennent de
  **reuploads communautaires** (`AX1Y2JP/MiniMax-H3-W4A8-ConvRot`,
  `koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned`), pas d'un dépôt officiel Comfy-Org/Minimax
  — nom de fichier et taille conformes et vérifiés, mais l'intégrité du contenu ne repose que
  sur la réputation/traction du dépôt, pas sur un éditeur officiel.

### `docker/userscripts/` (nouveau) — `comfy_kitchen` embarqué et câblé
2 scripts (copies strictes de scripts déjà validés ailleurs) installent `comfy_kitchen`
(accélération d'attention ARM64/DGX Spark) au démarrage du conteneur ComfyUI, de façon
idempotente. `install.sh` les déploie automatiquement, rien à faire manuellement. Le nœud
`ModelAttentionBackend` (`comfy kitchen attention`) a été câblé juste après le chargeur de
modèle dans les 9 templates `workflows/api/*.json` — **vérifié par rendu réel** (frames +
audio inspectés) sur au moins un représentant de chaque famille (Krea 2, LTX 2.5, Minimax
H3, Qwen-Edit) sans dégradation constatée ; les autres templates de la même famille ont été
câblés **par analogie de topologie** (même schéma de nœuds), pas individuellement testés par
rendu.

### Documentation
`README.md` : section Déploiement réécrite (installation automatique en une commande en
premier, procédure manuelle/dépannage conservée en repli explicite), `HF_TOKEN` documenté,
tableau des 19 modèles aligné sur `scripts/models.txt` (URLs directes `resolve/main`, 3
tailles jusqu'ici `<à compléter>` renseignées), les deux réserves ci-dessus rendues visibles,
mention de `canvas.html` (mode additionnel) et de `comfy_kitchen` (automatique, ARM64
uniquement).

### Reste ouvert
Rien n'est encore poussé vers GitHub à ce stade — le push est géré séparément par
l'orchestrateur après validation finale.

## 2026-09-07 (suite) — Point d'entrée visible vers le canvas dans le rail

Suite immédiate de la promotion ci-dessous : l'utilisateur a fourni une capture d'écran du
header et demandé un bouton "Canvas" à côté de "Studio", avec le logo Dell décalé pour
éviter le chevauchement qu'un second bouton créerait.

- Nouveau lien `.rail-canvas` → `canvas.html`, dans un conteneur `.rail-top` (flex row) qui
  place Studio+Canvas côte à côte en tête du rail vertical — le reste du rail (Monitor/
  Models/LLM/Advanced) reste empilé verticalement, inchangé. Style volontairement distinct
  du panneau actif (contour au lieu de rempli) : Canvas est une sortie vers une autre page,
  pas un panneau du studio.
- `.brand` (logo Dell) gagne un `margin-left: 150px` : le rail est en `overflow:visible` et
  déborde par-dessus le header plutôt que de le repousser (ce sont deux frères flex
  indépendants, pas liés par une grille commune) — élargir `grid-template-columns` du
  header n'aurait rien changé, d'où ce choix après mesure réelle du rendu.

Vérifié en direct sur le port 8090 : positionnement sans chevauchement (clair/sombre),
navigation Canvas fonctionnelle, non-régression du système de panneaux existant.

## 2026-09-07 — Promotion du canvas créatif (Piste 3) comme mode additionnel, sans toucher à index.html

Développé et qualifié dans le projet sœur `../ai-content-studio-canvas` (voir son propre
`TOUR-DE-CONTROLE-CHANGELOG.md` pour tout l'historique des lots : import média local,
cartes use-case câblées, LoRA/résolution vidéo, enrichissement de prompt LLM, filtre
Image/Vidéo, barre de progression). Décision explicite de l'utilisateur : le canvas
devient un **mode additionnel** accessible en plus du formulaire existant — pas un
remplacement. `index.html` et l'expérience formulaire ne sont **pas touchés**.

### Fichiers ajoutés (copie strictement identique à `ai-content-studio-canvas`, diff vide)
- `canvas.html` (nouveau, racine).
- `js/engine.js`, `js/nodes-simple.js`, `js/nodes-advanced.js` (nouveau dossier `js/`).

### Pourquoi aucun changement de nginx/docker-compose n'était nécessaire
`nginx.conf` de ce repo a déjà un `location / { try_files $uri $uri/ =404; }` qui sert
n'importe quel fichier statique du dossier monté — `canvas.html` et `js/*.js` sont donc
immédiatement accessibles sur `http://<host>:8090/canvas.html` sans redémarrage ni
modification de configuration (bind-mount `./:/usr/share/nginx/html:ro`, déjà en place).
Les 9 templates `workflows/api/*.json` déjà présents ici sont byte-identiques à ceux du
canvas (vérifié) — aucun template à copier.

### Lien retour
`canvas.html` a déjà un lien "⌂ App formulaire" vers `index.html` (construit dès l'origine
pour coexister à la même origine) — fonctionne immédiatement une fois les fichiers en
place, sans modification. Aucun lien ajouté dans l'autre sens (`index.html` → canvas) :
non demandé, `index.html` reste intact à l'octet près.

### Vérification
Testé en direct sur le port 8090 (pas seulement 8092) : chargement de `canvas.html` sans
erreur console, un vrai job Krea 2 soumis et abouti (fichier généré, `outFile` posé), et
`index.html` rechargé après coup pour confirmer l'absence de régression sur l'app
formulaire existante. `git status` du dépôt canvas vérifié propre avant la copie ; diff
byte-à-byte des 4 fichiers copiés confirmé vide.

### Reste ouvert
Aucun lien visible depuis l'interface `index.html` vers le canvas — accès uniquement par
URL directe (`/canvas.html`) pour l'instant, décision explicite de ne pas toucher au
formulaire existant. À reconsidérer si l'utilisateur souhaite un jour un point d'entrée
visible.

## 2026-09-02 — Promotion du rapprochement visuel avec la maquette (suite du Cockpit affiné)

Développé et qualifié dans le projet cockpit (`../ai-content-studio-cockpit`, voir son propre
changelog pour le détail lot par lot), promu ici après validation utilisateur sur plusieurs
itérations successives.

### Fichiers touchés
- `index.html` seul.

### Changements
- Police DM Sans (Google Fonts) + palette bleue + cartes "glass" (fond translucide, flou,
  ombre douce) alignées sur la maquette de refonte, en clair et en sombre.
- Rail de navigation vertical à gauche : icônes SVG sobres monochromes (Studio, Node Monitor,
  Model Management, Local LLM, Advanced), agrandissement au survol révélant le nom complet
  (réutilise le mécanisme déjà existant sur les profils métiers). Un panneau ouvert reste
  affiché tant que son icône (ou son nom) n'est pas re-cliquée — cliquer ailleurs dans
  l'interface ne le referme plus.
- Contenu associé à chaque icône (gauges GPU/RAM/queue, gestion des modèles, LLM local,
  console ComfyUI + plateformes cloud) affiché **dans la colonne de gauche elle-même**, qui
  s'élargit sous l'icône sélectionnée — le studio principal (formulaire Generate, galerie)
  ne bouge pas.
- Onglets de scénario (Campaign Generator / Storyboard + Animatic / Localized Assets) en
  pilules horizontales compactes, au lieu de 3 grandes cartes descriptives.
- Header restauré avec titre/sous-titre/"Powered by Dell Pro Max GB10" + sélecteurs de
  langue et de thème directement visibles (plus besoin d'un panneau "Réglages" séparé,
  supprimé du rail).
- Badge d'identité "Ancrage actif" repositionné en haut à droite.
- Galerie à cartes agrandies.

### Vérification
Chaque étape vérifiée par rendu réel headless (clair/sombre, plusieurs largeurs), tests
d'interaction DOM réels (clics, survols, mesures de position/taille), et re-test systématique
de la sélection `storyboard_v2` + bascule Auto/Réalisateur à chaque itération — voir le
changelog du projet cockpit pour le détail complet, lot par lot.

### Retour arrière
`git revert` du commit de promotion restaure l'état précédent (rail moins abouti, header
réduit).

## 2026-09-02 — Promotion "Cockpit affiné" (Piste 1 de la refonte visuelle)

Refonte ergonomique développée et qualifiée dans un projet distinct
(`../ai-content-studio-cockpit`, cf. son propre `TOUR-DE-CONTROLE-CHANGELOG.md` pour le détail
des lots et de la vérification par rendu réel), promue ici après validation utilisateur pour
remplacer la version courante. `index.html` de ce projet était resté strictement identique au
commit de départ du cockpit (`2b1243f`) entre-temps — promotion par simple copie de fichier,
aucun conflit à résoudre.

### Fichiers touchés
- `index.html` — rail de profils métiers en icônes (au lieu de pleine largeur), formulaire
  Generate condensé en barre horizontale, cartes de galerie agrandies, pastille d'identité
  "Soul ID" persistante (charsheet/locsheet ancrée visible sans rouvrir l'étape 0 du mode
  Réalisateur de `storyboard_v2`). Aucune logique de génération/graphe ComfyUI modifiée.
- `docs/REFONTE-COCKPIT.md` — NOUVEAU, brief de la refonte (copié depuis le projet cockpit).

### Vérification (déjà faite dans le projet cockpit avant promotion, non refaite ici)
Cycle réel du mode Réalisateur avec ComfyUI/Ollama (charsheet+locsheet générées, pastille
vérifiée par hash SHA-256 contre les fichiers PNG réels), i18n EN/DE vérifié sur DOM rendu,
`git diff` limité à `index.html` — voir le changelog du projet cockpit pour le détail complet.

### Suite prévue
Un rapprochement visuel avec la maquette de refonte (typographie, palette, effet "glass", style
des pastilles de nav — actuellement l'identité visuelle Dell d'origine a été conservée, la
maquette n'a pas été suivie sur ce plan) est en cours dans le projet cockpit, à promouvoir ici
de la même façon une fois qualifié.

### Retour arrière
`git diff HEAD~1 -- index.html docs/REFONTE-COCKPIT.md | git apply -R` restaure l'état
précédent (ou `git revert` du commit).

## 2026-09-01 — Lot 5+6 : correctif de la dérive de noms de modèles (piège n°14)

Découvert par la vérification du Lot 3 : 3 pipelines historiques + le nouveau
`reference2video` étaient cassés par des noms de fichiers modèles obsolètes sur disque,
indépendamment de tout travail de ce chantier. Correction en 2 temps (Lot 5 délégué sonnet
pour 3 des 4 références, Lot 6 fait directement par l'orchestrateur pour la 4ᵉ une fois le
remplacement non-ambigu) — les 4 corrigées et validées par rendu réel + inspection :

| Référence cassée | Fichier(s) | Remplacement | Preuve |
|---|---|---|---|
| LoRA Qwen-Edit déplacée | `workflows/api/qwen_edit_i2i.json`, `qwen_edit_dual.json` | `"Qwen/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"` | `output/studio/edit_00006_.png` |
| `flux-2-klein-9b-fp8` absent | `index.html` (`addFluxShot`) | `flux-2-klein-9b-kv-fp8.safetensors` (1er candidat `base-9b-fp8` rejeté après inspection — image cassée malgré `success`) | job `campaign_full` réel, `output/studio/campaign/{poster,thumbnail,social,teaser}_0000{6,7}_*` |
| `gemma_3_12B_it_fp4_mixed` absent | `index.html` (`addLtxShared`), `ltx_t2v.json`, `ltx_i2v.json` | `gemma_3_12B_it_fp8_scaled.safetensors` | rendu réduit + teaser `campaign_full` réel |
| `ernie-image.safetensors` absent | `index.html` (`addErnieShared`/`addErnieShot`) | `ernie-image-turbo.safetensors` + steps 20→8, cfg 4→1 (alignement sur `ernie_turbo_t2i.json` déjà validé) | `output/studio/lot6_erniefix_test_00001_.png` |

**Conséquence** : le pipeline `reference2video` (livrable clé du Lot 2, cohérence personnage+décor)
est maintenant fonctionnel de bout en bout, charsheet → locsheet → `minimax_h3_r2v` inclus.
Détail complet dans `docs/LESSONS.md` (piège n°14 + sous-entrées de correctif).

## 2026-09-01 — Lot 3 : navigation par profils métiers Media & Entertainment

Couche de présentation par profil ajoutée AU-DESSUS des 3 onglets scénario existants
(`const PROFILES`, `index.html:2047`), sans toucher au routing sous-jacent
(`activeScenario`/`SCENARIOS`/`refreshPipelineOptions`). 4 profils : Réalisateur/Storyboard
artist (storyboard_v2 + reference2video), DA/Motion designer (text2image Krea 2), Social
media/Marketing (campaign_full), Monteur/Post-production (galerie + localization).

### Fichiers touchés
- `index.html` seul (+ `docs/LESSONS.md`, entrées ajoutées, aucune modifiée/supprimée)

### Vérification (Phase 3, rejouée indépendamment du rapport d'agent)
- Captures headless clair/sombre × 390/768/1250/1440px inspectées visuellement — nav propre,
  4 colonnes ≥1181px repliant à 1/2 colonnes en dessous, aucune rupture.
- `node --check` sur le JS extrait : OK.
- `git diff --stat docs/LESSONS.md` : 38 insertions, 0 suppression.

### Découverte majeure (hors périmètre de ce lot, documentée piège n°14 dans LESSONS.md)
La qualification en conditions réelles a révélé que **3 pipelines étaient déjà cassés avant
ce chantier**, par dérive de noms de fichiers modèles sur disque (indépendant de la nav —
reproduit à l'identique via le chemin de navigation historique) : `campaign_full`
(`flux-2-klein-9b-fp8.safetensors` absent), Localized Assets / image2image (LoRA Qwen
déplacée dans `loras/Qwen/` sans préfixe dans le template), et `addErnieShot`
(`ernie-image.safetensors` absent) — ce dernier casse aussi **`reference2video`**, livrable
clé du Lot 2, dès l'étape charsheet. Correctif ciblé lancé en Lot 5 (voir plus bas).

## 2026-09-01 — Lot 1 : validation des 3 nouveaux modèles (Krea 2, LTX 2.5, Minimax H3)

Orchestration tour-de-controle (plan cadré via /architect). Objectif : remplacer Flux2/Ernie/
Z-Image (Krea 2), LTX 2.3 (LTX 2.5) et ajouter Minimax H3 (t2v/i2v/r2v + toggle LoRA turbo),
avec exigence critique client sur r2v : cohérence de scène (personnage + décor) garantie par
génération de reference sheets (charsheet + locsheet) injectées nativement dans
`MiniMaxH3ReferenceToVideo` (jusqu'à 9 `ref_images`, tags `<Picture i>`).

### Fichiers touchés (nouveaux, aucun fichier existant modifié)
- `workflows/api/krea2_t2i.json`, `ltx25_t2v.json`, `ltx25_i2v.json`, `ltx25_flf2v.json`,
  `minimax_h3_t2v.json`, `minimax_h3_i2v.json`, `minimax_h3_r2v.json` — 7 templates API validés
  par rendu réel réduit + inspection (frames + audio).
- `docs/NOUVEAUX-MODELES-LOT1.md` — NOUVEAU, synthèse des fichiers modèles/LoRA exacts utilisés
  par pipeline, écarts vs templates officiels ComfyUI, décisions steps/turbo, verdict cohérence r2v.
- `docs/LESSONS.md` — 4 entrées ajoutées (aucune modifiée/supprimée) : grille de longueur H3
  en 17n+5, LoRA turbo H3 instable sous 6 steps, coupe franche FLF2V en rendu réduit 25 frames,
  ref2va/fl2va — bien distinguer les deux rôles de checkpoint Minimax H3.

### Décisions clés (vérifiées par inspection réelle, pas seulement rapport d'agent)
- **Krea 2** : `krea2_turbo_fp8_scaled.safetensors` + `qwen3vl_4b_fp8_scaled.safetensors` +
  `qwen_image_vae.safetensors` — correspond exactement au template officiel ComfyUI, aucune
  substitution nécessaire.
- **LTX 2.5** : `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` (variante
  choisie par l'utilisateur) + VAE/text-encoders/upscaler dédiés — correspond exactement au
  template officiel.
- **Minimax H3** : checkpoints réels (`*_pruned_w4a8_mixed.safetensors`) divergent des noms du
  template officiel (`*_pruned_int8_convrot.safetensors`) — substitution documentée et validée.
  LoRA turbo (`minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors`) validée **ON à 8
  steps** (qualité ≈ identique à OFF/20 steps, 2,5× plus rapide) ; 4 steps rejeté (colorimétrie
  effondrée, artefacts de bande sur r2v) ; 6 steps = plancher acceptable.
- **Cohérence r2v (exigence client)** : CONFIRMÉE par comparaison visuelle directe — personnage
  (cheveux blanc-argenté pixie, ciré jaune à boucles, écharpe rouge, traits du visage) ET décor
  (pierre blanche, fenêtres cintrées, escalier en colimaçon) de `charsheet_00001_.png`/
  `locsheet_00001_.png` retrouvés à l'identique dans les frames de `h3_r2v_face8` et
  `h3_r2v_turbo6/8`. Preuves : `/home/sparks/comfyui-spark/basedir/output/validate/lot1/`
  (64 fichiers : 36 frames PNG, 12 planches comparatives, 12 pistes audio extraites).

### Incident de session (résolu sans perte)
Le premier agent du lot a vu sa session interrompue (process Claude Code arrêté) après avoir
terminé tous les rendus GPU mais avant d'écrire la synthèse — transcript perdu (non résumable).
Tout le travail était néanmoins intact sur disque (templates + rendus + reference sheets) ;
un second agent (frais, sans contexte de session) a inventorié l'existant, inspecté réellement
chaque preuve (extraction de frames, lecture visuelle, ffprobe audio) sans aucun re-rendu GPU,
et écrit la synthèse manquante. Confirme la leçon déjà connue de ce projet : écrire les
livrables durables sur disque au fil de l'eau permet une reprise à coût quasi nul même après
perte totale du transcript.

### Retour arrière
Tout en fichiers nouveaux, non commités. Aucun fichier existant du projet modifié par ce lot.

## 2026-07-17/18 — Ancrage double : character sheet enrichie + location sheet

Orchestration en 4 lots séquentiels (plan Fable 5). Motif : visage ré-inventé en gros plan
(planche 3 vues sans portrait), décor porté par le seul texte → variations entre cases.

### Fichiers touchés
- `workflows/api/qwen_edit_dual.json` — NOUVEAU template Qwen-Edit à 2 images de référence
  (image1 = planche personnage → conditioning + latent ; image2 = planche décor → conditioning
  SEUL via LoadImage `79` + FluxKontextImageScale `433:118` sur les deux TextEncodeQwenImageEditPlus).
  L'ancien `qwen_edit_i2i.json` reste intact : bascule arrière = 1 ligne `anchor` du manifest.
- `index.html` — fiches gemma structurées (`characterSheetFromBrief` {face,hair,outfit,accessories,
  palette}, NOUVELLE `locationSheetFromBrief` {place,architecture,materials,lighting,palette}) ;
  planches Ernie 1920×1088 sans texte (`buildCharsheetGraph` turnaround+portrait+expressions+palette,
  NOUVELLE `buildLocsheetGraph` décor multi-angles) ; `{{IMAGE2}}` dans `buildGraph` ; `keyframePrompt`
  gabarit dual ; `submitKeyframeJob` +locName (3 call sites), `submitCutJob` +locDesc (2 call sites
  + tenue) ; ÉTAPE 0 du mode Réalisateur (cartes des 2 planches, `regenerateAnchor` seed+1,
  bouton "Valider les planches" + gating avec ré-invalidation).
- `workflows/manifest.json` — `anchor: "api/qwen_edit_dual.json"`.
- `docs/ARCHITECTURE.md`, `docs/LESSONS.md` (leçons dual + verdict qualification), `CLAUDE.md`,
  `workflows/README.md` (timings) — documentation alignée.

### Qualification (run dual N=4 + tenue, 2026-07-17 22:47→23:03, ~17 min bout-en-bout)
- Visage : portrait de la charsheet retrouvé à l'identique sur les 4 cases dont le plan rapproché — avant, casque/combinaison variaient entre cases.
- Décor : les 4 keyframes montrent LE site de la locsheet — avant, 4 lieux sans rapport.
- Cuts : 0/5 dérives (frames médianes contrôlées) contre 4/9 au run N=8 initial.
- Animatic : 245 frames exactes (5×49), audio continu.
- Timings : planche ~2 min chacune, keyframe ~27-32 s, cut 2 s ~2 min, gemma ~50 s.

### Retour arrière
Tout en non-commité. Bascule keyframes mono-ancre : `anchor` → `api/qwen_edit_i2i.json`.

## 2026-07-17 — Refonte du scénario Storyboard + Animatic (`storyboard_v2`)

Orchestration en 4 lots (plan Fable 5, exécution déléguée, vérification adversariale).
Motif : perte de cohérence des sujets entre cases, animatic FLF2V décevant, UI sans point de contrôle.

### Fichiers touchés
- `index.html` — cœur de la refonte (JS + formulaire + CSS, ~640 lignes nettes ajoutées)
- `workflows/manifest.json` — pipeline `storyboard_v2` (champ `anchor`, contrôle `mode`), suppression `storyboard_full`/`storyboard_full_ernie`
- `docs/ARCHITECTURE.md`, `docs/LESSONS.md` (pièges n°8/n°9), `docs/TESTING.md`, `CLAUDE.md`, `workflows/README.md` — documentation alignée sur le code

### Changements
1. **Mécanique** (Lot 1, opus) : chaîne multi-jobs character sheet Ernie → N keyframes ancrées Qwen-Image-Edit 2509 (1 job/case, template désigné par le champ manifest `anchor` — bascule de modèle = 1 ligne) → grille contact-sheet adaptative (`cols=ceil(sqrt(n))`, N∈[4,16]) → 1 cut i2v LTX 2.3 deux-passes par keyframe → assemblage cuts francs + audio (`studio/story/animatic`). Anciennes fonctions `buildStoryboardFullGraph`/`generateStoryboardFull`/`shotPromptsFromBrief` supprimées ; `sequence2video` (FLF2V manuel) et `campaign_full` conservés intacts. Reprise 1 : `keyframePrompt` durci (photoréalisme, plein cadre, instance unique, remise en scène — tout en positif, cfg 1 = negative ignoré).
2. **UI double mode** (Lot 2, sonnet) : sélecteur Auto/Réalisateur (contrôle manifest `mode`) ; mode Réalisateur en 3 étapes (plans éditables scene/angle/motion → cartes keyframes régénérables seed+1 / verrouillables → animatic lancé après validation) ; i18n FR/EN/ES/DE, thème via variables CSS. Refactor en sous-fonctions partagées `submitCharsheetJob`/`submitKeyframeJob`/`submitGridJob`/`submitCutJob`/`submitAnimaticJob` sans changement des graphes.
3. **Qualification** (Lot 3, sonnet) : run Auto N=8 réel chronométré (~19 min ; keyframe ~17 s, cut 2 s ~88 s en régime), projection 16 cases ≈ 34 min ; verdict ancrage GO (identité 8/8, adhérence aux angles extrêmes partielle — piège n°8) ; découverte du piège n°9 (dérive des cuts).
4. **Correctif piège n°9** (lot ciblé, opus) : `submitCutJob` ancre désormais l'enhancer LTX sur le contenu réel de la keyframe (prompt `scene + charDesc + camera motion` au lieu du mouvement seul) — validé par re-rendu des 3 cuts qui déviaient (fontaine/costume/blé → personnage et décor conservés en frame médiane).

### Incidents notables
- Le lot baseline a exécuté un `git checkout workflows/manifest.json` interdit (~10:15), écrasant des éditions en cours du Lot 1 — détecté, le Lot 1 a ré-appliqué et re-vérifié l'intégralité du manifest.
- Le run animatic N=8 archivé (`animatic_00014_.mp4` et antérieurs) est ANTÉRIEUR au correctif des cuts : un nouveau run reflétera la qualité corrigée.

### Retour arrière
Tout est en non-commité par-dessus le refactor layout préexistant (lui aussi non commité). `git diff` pour l'ensemble ; pas de commit effectué par les agents.
