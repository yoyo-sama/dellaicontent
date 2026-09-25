# Audit ergonomie / UX — Studio et Canvas (2026-09-23)

Audit d'usage, pas revue de code : **chaque trouvaille ci-dessous vient d'une manipulation réelle
de l'app servie sur `http://localhost:8090`**, dans le Browser pane et dans un Chromium headless
piloté en CDP, avec une capture à l'appui. Quand le code est cité, c'est seulement pour
localiser la cause d'un comportement déjà observé. La revue technique est faite séparément.

- Captures (60 PNG) : `/tmp/claude-1000/-home-sparks/cdc72ea9-e51c-43a0-8b9b-b859f2013fb2/scratchpad/ux/`
  — noté `ux/` dans la suite. Nommage : `<app>_<largeur>_<thème>[_<langue>]_<état>.png`.
  **Perdues** : le scratchpad de session a été vidé le 2026-09-24, avant qu'on ait pu les copier
  ailleurs. Les références `ux/…png` ci-dessous ne pointent donc plus sur rien ; les constats
  restent décrits en texte et les captures « avant » seront refaites avant la Vague 3.
- Largeurs : 390 / 768 / 1280 / 1440 px (convention `docs/TESTING.md`), clair et sombre, FR/EN/ES/DE.
- Parcours suivis jusqu'au bout : premier contact sur les deux apps ; `storyboard_v2` jusqu'à la
  revue des plans (puis Montage et Relay) ; carte « Édition d'image » du Canvas en 2509 puis en
  Qwen Image 2.1 ; bascules thème et langue ; 390 px sur les deux apps.

**Limites de l'audit.**
- Aucun rendu GPU n'a été lancé. Pour arriver à la revue des plans, j'ai utilisé « Reprendre le
  projet » sur le projet sauvegardé (gardienne de phare, `storyboard_v2_qwen21`, 4 keyframes
  prêtes), copié dans un profil headless jetable. Cette restauration ne soumet aucun job
  (vérifié dans `restoreProject`).
- Le retour visuel **pendant** un rendu (S12) est décrit d'après le balisage et les chaînes de
  statut, pas d'après un rendu observé en direct.
- Les tailles d'écran sont émulées (CDP `setDeviceMetricsOverride`). Un point qui ne tient
  qu'à l'émulation est signalé comme tel.
- Dans le Browser pane (qui contient l'état réel de l'utilisateur), je n'ai fait que des
  actions sans effet de bord : navigation, ouverture de panneaux, « Reprendre », « Quitter le
  studio ».

**Contraintes du projet respectées par toutes les propositions** (AGENTS.md, « Règles du
projet ») :
- rien ne déclenche un rendu sans clic ;
- aucune réintroduction d'un mode Auto ;
- les prompts restent visibles, éditables et partent verbatim ;
- **aucune proposition ne suppose une librairie JS** : tout se fait en CSS ou en JS vanilla
  déjà en place.

## Récapitulatif

| App | Fort | Moyen | Faible | Total |
|---|---|---|---|---|
| Studio (`index.html`) | 5 | 9 | 5 | 19 |
| Canvas (`canvas.html`) | 2 | 7 | 2 | 11 |
| Cohérence Studio ↔ Canvas | 0 | 2 | 2 | 4 |
| **Total** | **7** | **18** | **9** | **34** |

**État au 2026-09-25 (HEAD `703994e`, Vagues 3 et 4).** Chaque trouvaille porte sa ligne « État » : 33 sont traitées, 1 partiellement (C10). Les réserves gardées dans les lignes d'état, pour mémoire : Trailer illisible à 768 px (C7), texte dessiné du canvas à ≈ 2,6:1 (C10), sélection d'entrée non rétablie après « Annuler » d'une suppression de galerie (S11), compteur de jobs par rafale (S12), gestes tactiles non validés sur appareil réel (C1), forme du sélecteur de langue (X1), icônes SVG/émojis (X4). Hors trouvailles de l'audit : « Mégapixels » et « Style H3 (LoRA) » n'ont pas de clé `I18N` au Canvas (affichés en français dans les 4 langues). Commits : Vague 3 = `04e5161` (3A), `057bc1f` (3B), `7764e91` (3C), `f95edd8` (3D) ; Vague 4 = `692f0c0` (4A), `703994e` (4B), `7fb2df2` (4C).

---

## 1. Studio (`index.html`)

### Impact fort

**S1 — Choisir un onglet scénario ou un profil écrase le brief sans prévenir.**
- Constat (headless) : j'ai tapé « MON BRIEF PERSO… » dans le brief, puis cliqué l'onglet
  « Storyboard + Animatic ». Le champ contenait ensuite « A detective enters an abandoned
  broadcast studio… ». Le texte de l'utilisateur est perdu, sans confirmation et sans
  possibilité d'annuler.
- Même effet via les 4 profils, qui cliquent l'onglet. Cause : `index.html:2990`,
  `brief.value = s.prompt`.
- Le parcours naturel d'un débutant y mène tout droit : il tape son idée, puis explore les
  onglets.
- Proposition : ne remplir le brief que s'il est vide ou encore égal au texte d'exemple du
  scénario précédent, sinon ne pas y toucher. Encore mieux, présenter l'exemple comme
  `placeholder` plutôt que comme valeur.

**État (2026-09-25)** : traité (Vague 3, `04e5161`) — choisir une carte ou un pipeline n'écrit plus rien dans le brief, l'exemple est un `placeholder`, un brief vide n'envoie rien.

**S2 — « Générer les keyframes » reste proposé quand les keyframes existent déjà, et un clic efface tout, verrous compris.**
- Constat : après « Reprendre le projet », le bouton pleine largeur « Générer les keyframes »
  s'affiche en bas du Storyboard alors que les 4 plans sont « Prêt »
  (`ux/studio_1440_light_director_keyframes_btn.png`).
- `directorStep2` (`index.html:6725`) recrée toutes les keyframes avec `locked: false`,
  `edited: false` et un prompt recompilé. Il vide aussi cuts, ordre et animatic. Aucune
  confirmation.
- Conséquences :
  - « 🔒 Verrouiller » ne protège de rien ;
  - un prompt de keyframe retouché à la main est remplacé, ce qui heurte la règle « prompt
    verbatim ». Ce point est à confirmer par la revue technique.
- Dans le parcours normal (sans reprise), le bouton est masqué après la 1ʳᵉ génération : le
  problème n'apparaît qu'après une reprise, c'est-à-dire justement quand l'utilisateur tient à
  son travail.
- Proposition, au choix :
  - masquer le bouton dès qu'il existe au moins une keyframe (comme après l'étape 2) ;
  - ou le renommer « Régénérer les plans non verrouillés (n) », respecter `locked`, et
    confirmer avec `confirm(tr(…))` en annonçant la perte du montage. C'est le pattern déjà
    utilisé par « Nouveau projet ».

**État (2026-09-25)** : traité (Vague 2, `f6a13c3`) — « Générer les images des plans » est masqué dès qu'il existe des keyframes (`directorKeyframesBtn`, condition `!director?.keyframes`) ; la régénération se fait plan par plan (🔄).

**S3 — La pastille « Identité ancrée » recouvre le sélecteur de langue et le bouton de thème.**
- Constat : `#soulId` est en `position: fixed; top: 18px; right: 18px; z-index: 90`
  (`index.html:944`). Dès qu'une session Réalisateur existe, elle se pose exactement sur le
  sélecteur de langue et sur ☀/🌙 : `elementFromPoint` au centre de `#langSelect` renvoie
  `IMG` dans `FIGURE.soul-char` dans `ASIDE#soulId`.
- Elle reste en place **même après « Quitter le studio »**. Changer de langue ou de thème
  devient impossible à la souris.
- Captures : `ux/studio_1440_light_director_character.png`,
  `ux/studio_768_light_director_storyboard.png` (768 : elle chevauche le logo),
  `ux/studio_390_light_director_storyboard_scrolled.png` (390 : elle recouvre le contenu
  pendant le défilement).
- Proposition : sortir la pastille du flux fixe. Soit en tête de la colonne « Mode
  Réalisateur », soit dans une barre d'état sous le header (voir axe A2).

**État (2026-09-25)** : traité (Vague 3, `057bc1f`) — la pastille fixe est remplacée par `#sessionBar`, dans le flux, sous l'en-tête.

**S4 — À 390 px, le rail gauche est fixe et masque le contenu en permanence ; le 1ᵉʳ champ arrive après un écran entier.**
- Constats :
  - Au chargement, logo, titre, rail vertical (Studio/Canvas + 4 icônes) et langue occupent
    ~530 px ; le premier champ du formulaire est sous la ligne de flottaison
    (`ux/studio_390_light.png`).
  - En défilant, le rail reste fixé en haut à gauche, par-dessus les libellés, les champs et
    les onglets (`ux/studio_390_light_form_scrolled.png`, `ux/studio_390_light_gallery_scrolled.png`,
    `ux/studio_390_light_director_storyboard_scrolled2.png` : « ÉMOTION » et « DURÉE » sont
    coupés).
  - En `storyboard_v2`, « Generate » tombe à ~2 000 px de haut
    (`ux/studio_390_light_storyboard_form_tall.png`).
- Proposition, sous 768 px :
  - rail en barre horizontale dans le flux (`position: static`) ou en barre d'onglets en bas ;
  - header compacté sur une ligne (logo + titre, sous-titre masqué).

**État (2026-09-25)** : traité (Vague 3, `7764e91`) — rail dans le flux et en-tête compact sous 768 px, cartes d'objectif en deux colonnes, contrôles de génération remontés au-dessus du bouton.

**S5 — Premier contact : on ne comprend pas en 5 secondes par où commencer.**
- Constats, à 1440 px (`ux/studio_1440_light.png`) :
  - La première rangée, « Je démarre en tant que… », n'est faite que de 4 émojis
    (🎬 🎨 📣 🎞). Le métier ne s'affiche qu'au survol, ce qui ne fonctionne pas au tactile.
    Au survol, le bouton s'élargit et décale ses voisins.
  - La deuxième rangée répète le même choix sous un autre angle : « Campaign Generator /
    Storyboard + Animatic / Localized Assets ». Noms en anglais même en FR ; leurs
    descriptions existent dans le HTML (« Brief marketing vers posters… ») mais sont en
    `display: none`.
  - Le brief est pré-rempli par un prompt anglais tronqué.
  - Le bouton d'action, « Generate », est un petit bouton aligné sur les champs Variantes et
    Seed.
- Un visiteur voit six sélecteurs techniques (Pipeline « Text2Image », Modèle, Style, Ratio,
  LoRA) avant de voir quoi que ce soit qui ressemble à « ce que je veux obtenir ».
- Le Canvas fait mieux sur ce point, voir X2.
- Proposition : remplacer les deux rangées par 3–4 cartes d'objectif, avec titre et une ligne
  de description toujours visible (le composant `.usecase` du Canvas). Le profil devient un
  simple préréglage de ces cartes. Voir l'axe A1.

**État (2026-09-25)** : traité (Vague 3, `04e5161`) — quatre cartes d'objectif (titre et phrase toujours visibles, métier en sous-titre) remplacent les profils et les onglets.

### Impact moyen

**S6 — Le bouton principal dit « Generate » quel que soit ce qu'il lance.**
- En `storyboard_v2`, il lance gemma puis **2 jobs de planches** (étape 1/3). En
  `campaign_full`, il lance posters, thumbnails et teaser. En `text2image`, N variantes.
  L'utilisateur ne sait pas ce qui va partir ni combien de temps ça prendra.
- La case « Générer l'audio » est posée **après** le bouton, hors de la carte de paramètres
  (`ux/studio_1440_light_storyboard_form_tall.png`, `ux/studio_390_light_storyboard_form_tall.png`).
- Proposition, qui ne change rien à la règle du clic :
  - libellé dépendant du pipeline : « Générer les planches (étape 1/3) », « Générer
    2 images », « Lancer la campagne (posters + thumbnails + teaser) » ;
  - case audio remontée dans la carte, avant le bouton.

**État (2026-09-25)** : traité (Vague 3, `04e5161` : libellé selon le pipeline, case audio avant le bouton ; `7764e91` : turbo, saut des fiches et marchés au-dessus du bouton).

**S7 — En français, une partie de l'interface reste en anglais.**
- En FR : « Creative Control », « Generate », « Job Queue », « Generated Gallery ». Les
  infobulles et libellés du rail : « Node Monitor », « Model Management », « Local LLM »,
  « Advanced ». Le panneau Node Monitor en entier : « Queue depth », « Last job »,
  « Pipeline flow », « Prompt Enrichment »…
- En DE, les mêmes chaînes sont traduites (« Kreativsteuerung », « Generieren »,
  « Job-Warteschlange »). C'est donc le **français** qui n'a pas sa traduction.
- Comparaison : `ux/studio_1440_light.png` et `ux/studio_1440_light_de.png` ;
  `ux/studio_1280_light_node_monitor.png`.
- Les statuts de job, codés en dur, sont en anglais dans les 4 langues : « Queued »,
  « Running n% », « Done », « Cancelled ».
- Proposition : traduire ces chaînes. Le journal d'événements reste non traduit, c'est un
  choix assumé à ne pas toucher.

**État (2026-09-25)** : traité (Vague 4, `692f0c0`) — `tr()` applique les entrées `fr:`, `translateTree` traduit `title` et `aria-label`, statuts de job traduits dans les 4 langues ; le journal reste non traduit (choix assumé).

**S8 — Le vocabulaire change d'un écran à l'autre, et du jargon interne est exposé.**
- Le même objet est appelé « Nombre de cases » dans le formulaire, « Plan 1/4 » dans la
  revue, « chaque case » dans la consigne des étapes, et « keyframes » sur le bouton.
- Du jargon d'équipe apparaît tel quel dans l'UI :
  - « arrondi 8n+1 au rendu » sous chaque plan ;
  - « Chemin qualifié en rendu réel » dans Montage ;
  - « Relay » dans la navigation ;
  - « charsheet », « FLF2V » et « Minimax H3 reference2video » dans les libellés de pipeline.
- Captures : `ux/studio_1440_light_director_storyboard.png`,
  `ux/studio_1440_light_director_montage.png`.
- Proposition :
  - un seul terme par objet, « plan » partout, les keyframes étant « l'image du plan » ;
  - les notes techniques en infobulle `title` ;
  - « Relay » renommé en « Plan-séquence (Relay) » ;
  - libellés de pipeline commençant par le résultat (« Storyboard + animatic ») et gardant le
    nom technique en second.

**État (2026-09-25)** : traité (Vague 3, `04e5161` : « Nombre de plans » ; Vague 4, `692f0c0` : plus de « keyframe » visible, notes techniques en infobulle, « Plan-séquence (Relay) », `PIPELINE_LABELS`/`WORKFLOW_LABELS` commençant par le résultat). « FLF2V » subsiste en second, entre parenthèses, dans un libellé de pipeline.

**S9 — Deux boutons « ✎ Prompt » par plan, sans que l'on sache lequel édite quoi.**
- Chaque plan a « ✎ Prompt de l'action » sous le champ Action et « ✎ Prompt » sur la carte
  de keyframe (`ux/studio_1440_light_director_storyboard.png`).
- Le premier édite le texte de l'action ; le second, le prompt image complet, ancrage
  compris.
- Proposition : les renommer « ✎ Réécrire l'action » et « ✎ Prompt image complet ». Les deux
  restent visibles et verbatim.

**État (2026-09-25)** : traité (Vague 4, `692f0c0`) — « ✎ Réécrire l'action » et « ✎ Prompt image complet ».

**S10 — Revoir 4 plans demande 4 écrans, et il n'y a pas de vue d'ensemble.**
- Un plan occupe ~430 px de haut. À 1440×900, on en voit un et demi, et la suite défile dans
  un panneau interne (double barre de défilement). À 16 plans, la revue devient un long
  tunnel.
- La consigne « Étape 1… Étape 2… Étape 3… » tient sur une ligne grise, sans indiquer l'étape
  en cours ; l'étape 3 (animatic) est en fait dans une autre section, « Montage ».
- Proposition : une bande horizontale de vignettes en tête de la section, avec le statut de
  chaque plan (prêt / verrouillé / en cours). Un clic amène au plan. La consigne devient un
  petit stepper 1-2-3 qui met en évidence l'étape courante.

**État (2026-09-25)** : traité (Vague 3, `057bc1f` : stepper 1-2-3 ; Vague 4, `703994e` : bande de vignettes `#shotStrip`, clic = défilement et focus, aucun job).

**S11 — Des suppressions sans filet.**
- 🗑 dans la galerie masque l'asset **définitivement** (`deletedAssets`, `index.html:3257`),
  sans confirmation ni moyen de le récupérer depuis l'UI.
- Retirer un sujet (`removeSubject`, `index.html:6327`) supprime aussi toutes ses variantes
  de planche (du travail GPU) et dévalide les planches, sans confirmation.
- À l'inverse, « Nouveau projet » et « Annuler le projet » demandent confirmation : le filet
  est posé de façon inégale.
- Proposition : un bandeau « Supprimé — Annuler » pendant 5 s, en vanilla. Pour des actions
  fréquentes, c'est moins lourd qu'un `confirm`.

**État (2026-09-25)** : traité (Vague 4, `703994e`) — `undoToast` pour la suppression de galerie et `removeSubject`. **Non traité** : annuler une suppression de galerie ne rétablit pas l'asset qui était choisi comme entrée (`clearSelectedAsset` est appelé à la suppression).

**S12 — Pendant un rendu, le retour visuel est pauvre (d'après le balisage, pas observé en direct).**
- La ligne de job affiche « Running n% ». Ce pourcentage est celui du nœud ComfyUI en cours
  (`d.value / d.max`) : il repart de 0 à chaque passe d'échantillonnage. Une vidéo LTX
  2 passes affiche donc 0→100 % deux fois.
- Il n'y a ni temps écoulé ni étape k/n. Les libellés sont en anglais (S7).
- En mode studio, la liste « Job Queue » n'est plus visible. Le seul indicateur est une ligne
  de texte gris dans le pied de la navigation (`#studioJobs`).
- Proposition : afficher, dans le studio, « Job k/n · 00:42 » par action lancée
  (l'orchestrateur connaît le nombre de jobs) et le pourcentage du nœud en second. Rien
  n'est déclenché, on ne fait qu'afficher.

**État (2026-09-25)** : traité (Vague 3, `057bc1f` : « Job k/n · mm:ss · nœud p % » ; Vague 4, `692f0c0` : le pourcentage disparaît en fin de job). Limite : compteur par rafale, une chaîne séquentielle (le relay) repart à 1/1 à chaque segment.

**S13 — Ouvrir un panneau du rail casse le header.**
- En ouvrant Node Monitor, Model Management ou Advanced, le logo Dell passe sous le titre
  « AI Content Studio », à 1280 comme à 1440 px (`ux/studio_1280_light_node_monitor.png`,
  `ux/studio_1440_light_advanced_panel.png`).
- Le bouton « Studio » perd son libellé : on ne sait plus dans quelle vue on est.
- Proposition : header en grille à colonnes fixes (logo | titre | réglages), indépendante de
  la largeur du rail.

**État (2026-09-25)** : traité (Vague 3, `057bc1f`) — en-tête en grille (logo | titre | réglages), libellé « Studio » du rail toujours visible.

**S14 — À 390 px en mode Réalisateur, choisir une section ne fait pas défiler jusqu'à elle.**
- La navigation (Personnage / Décor / Storyboard / Montage / Relay) et les 4 boutons de
  projet remplissent le premier écran (`ux/studio_390_light_director_character.png`). Après
  un clic sur « Storyboard », `scrollY` reste à 0 et rien ne semble se passer.
- « Annuler le projet » et « Nouveau projet » sont en grille 2×2 juste sous les onglets, avec
  le même poids visuel qu'eux : risque d'erreur de doigt.
- Proposition :
  - `scrollIntoView` sur la section choisie en dessous de 768 px ;
  - actions de projet déplacées en bas de la colonne, en style discret.

**État (2026-09-25)** : traité (Vague 3, `7764e91`) — clic sur un onglet du studio = défilement jusqu'à la section sous 768 px, actions de projet en bas de colonne.

### Impact faible

**S15 — « Planches validées ✓ » est un bouton désactivé à 50 % d'opacité.**
- Un état est affiché comme une action impossible. En sombre, il est presque invisible
  (`ux/studio_1440_dark_director_storyboard.png`).
- Proposition : une pastille de statut, qui ne ressemble pas à un bouton.

**État (2026-09-25)** : traité (Vague 3, `057bc1f`) — « Valider les planches » disparaît une fois validé, l'état se lit dans la barre de session.

**S16 — Des cadres vides restent affichés.**
- Le titre « JOB QUEUE » s'affiche sans rien dessous tant qu'aucun job n'a tourné.
- Sous le studio, une barre blanche vide (`footer#studioTimeline`) reste visible tant qu'il
  n'y a pas de montage (`ux/studio_1440_light_director_character.png`, en bas).
- Proposition : les masquer, ou y mettre une phrase d'état vide (« Aucun job en cours »).

**État (2026-09-25)** : traité (Vague 3, `057bc1f`) — « Job Queue » et le pied de timeline vides sont masqués (CSS).

**S17 — Les jauges du Node Monitor n'affichent jamais leur remplissage.**
- « GPU MEM 87 % » s'affiche sous un arc entièrement gris (`ux/studio_1280_light_node_monitor.png`).
- Cause visible en CSS : le pseudo-élément coloré de `.arc` déborde de `inset: -8px` dans un
  parent en `overflow: hidden`, donc il est rogné.
- Pour une démo GB10, cette télémétrie est justement la vitrine, et elle est en plus cachée
  derrière une icône sans libellé. Voir A2.

**État (2026-09-25)** : traité (Vague 3, `057bc1f`) — arcs des jauges non rognés ; la mémoire GPU est en permanence dans la barre de session.

**S18 — Dans la galerie, toutes les cartes portent le titre « Historique ».**
- Chaque carte affiche « Historique » suivi du nom de fichier brut (`dual21_s46_00001_.png`).
  Pour un public de démo, ça ne dit rien (`ux/studio_1440_light_storyboard_form_tall.png`).
- Proposition : utiliser comme titre le libellé du pipeline et un extrait du prompt, déjà
  rangés dans `assetPrompts`.

**État (2026-09-25)** : traité (Vague 4, `703994e`) — titre = libellé du pipeline traduit (« Image » / « Vidéo » sinon) et extrait du prompt ; nom de fichier en infobulle.

**S19 — Cibles tactiles de 28–30 px.**
- À 390 px, les boutons « 🔄 Régénérer », « ✎ Prompt », « 🔒 Verrouiller » et « ✎ Prompt de
  l'action » font 28 px de haut ; les onglets de sujet, 30 px (mesure DOM).
- Proposition : 40–44 px minimum sous 768 px.

**État (2026-09-25)** : traité (Vague 3, `7764e91`, puis `692f0c0`) — aucune cible interactive sous 44 px à 390 px dans les états mesurés.

---

## 2. Canvas (`canvas.html`)

### Impact fort

**C1 — À 390 px, le Canvas est inutilisable.**
- Constats :
  - Le fichier ne contient **aucune** règle `@media`.
  - La palette (230 px) et le panneau Propriétés se chevauchent et couvrent toute la largeur
    utile. Le lien « Studio » est masqué par le panneau Propriétés, et aucun des deux
    panneaux ne se replie.
  - Les cartes ne sont pas visibles, ou apparaissent empilées au même point derrière la
    palette.
- Captures : `ux/canvas_390_light_trailer_cards.png`, `ux/canvas_390_dark_qwen_edit_props.png`,
  `ux/canvas_390_light_trailer_fresh.png`.
- Constat connexe, à confirmer sur un appareil réel car observé en émulation : après un
  changement de taille sans recharger (390 → 1440, comme une rotation de tablette), les
  cartes disparaissent du canvas (`ux/canvas_resize_390_to_1440.png`).
- Proposition, sous 768 px :
  - palette et Propriétés deviennent deux feuilles basculantes en bas d'écran (une seule
    ouverte à la fois) ;
  - le canvas prend toute la largeur ;
  - redimensionner le canvas litegraph sur l'événement `resize`.

**État (2026-09-25)** : traité (Vague 3, `f95edd8`) — feuilles basculantes sous 768 px, canvas plein écran, `resize` corrigé à la racine (cartes disparues après une rotation). **Non validé** : pan et pincement tactiles sur un appareil réel (émulation seulement). Voir C7 pour 768 px.

**C2 — Édition d'image : une entrée « + » inopérante reste affichée en mode 2509, et les deux « + » sont indiscernables.**
- Constat : la carte montre deux boutons « + » identiques et sans libellé, en 2509 comme en
  2.1 (`ux/canvas_1440_light_qwen_edit_2509.png` et `ux/canvas_1440_light_qwen_edit_21.png`).
- Le second est le slot de références supplémentaires. D'après `js/nodes-simple.js:179`, il
  est « sans effet en mode 2509 » : on peut y brancher une image et elle est **ignorée sans
  avertissement**.
- Rien n'indique non plus lequel des deux « + » est l'image à éditer et lequel est une
  référence. C'est la confusion la plus probable sur le nouveau sélecteur de moteur.
- Proposition :
  - masquer le slot de références en 2509, ou le griser avec l'infobulle « Qwen Image 2.1
    uniquement » ;
  - dans le panneau Propriétés, une ligne « Entrées : image à éditer ← Création d'image ·
    réf. 1 ← … » ;
  - des libellés courts sur les slots (« source », « réf. + »).

**État (2026-09-25)** : traité (Vague 4, `7fb2df2`) — plus de « + » sur le slot de références en 2509, indication sous « Moteur », carte plus large.

### Impact moyen

**C3 — Le moteur d'édition se choisit à deux endroits, sous deux noms, avec des résumés qui ne se comparent pas.**
- Le « Mode avancé » l'appelle « Modèle » : c'est le moteur de la **prochaine** carte. Le
  panneau Propriétés l'appelle « Moteur » : c'est celui de la carte sélectionnée.
- Après avoir passé une carte en 2.1, la palette affiche toujours « Qwen-Edit 2509 », ce qui
  donne l'impression d'une contradiction (`ux/canvas_1440_light_qwen_edit_21.png`).
- Le pied de carte décrit une résolution en 2509 (« Qwen-Edit 2509 · 1024×1024 ») et un
  nombre de références en 2.1 (« Qwen Image 2.1 · jusqu'à 10 réf. ») : deux informations
  différentes, impossibles à comparer.
- Le Studio présente le même choix comme un « Modèle / Workflow » au libellé de 70
  caractères (voir X4).
- Proposition :
  - le terme « Moteur » partout ;
  - un pied symétrique : « 2509 · 1 réf. · sortie 1024×1024 » et « 2.1 · jusqu'à 10 réf. ·
    taille de la source ».
- Pour la revue technique, sans évaluation d'impact ici : après rechargement, un sondage
  headless montre `properties.engine = "qwen21"` mais le widget interne `moteur` revenu à
  `qwen_edit_2509`.

**État (2026-09-25)** : traité (Vague 4, `7fb2df2`) — `syncWidgets` après `graph.configure`, duplication et ajout d'un nœud (le widget « moteur » n'est plus restauré à tort), « Moteur » partout, pieds de carte symétriques.

**C4 — Le bouton d'action d'une carte jamais générée s'appelle « Régénérer », et son statut s'affiche « idle ».**
- Toute carte neuve propose « Régénérer » comme action principale. Le statut est « idle »
  (anglais brut, pas traduit en DE non plus : `ux/canvas_1440_light_de_qwen_edit.png`).
- En clair, ce texte a un contraste de 2,41:1.
- Proposition :
  - « Générer » tant que la carte n'a pas de sortie, « Régénérer » ensuite ;
  - statuts traduits : En attente / En cours / Terminé / Erreur.

**État (2026-09-25)** : traité (Vague 4, `7fb2df2`) — « Générer » tant que la carte n'a pas de sortie, « Régénérer » ensuite ; statuts traduits, contrastes par thème.

**C5 — Les listes déroulantes ressemblent à des champs de texte.**
- `.panel select` a `appearance: none` et `background-image: none` (`canvas.html:105-107`) :
  il n'y a aucun chevron.
- « Français », « Qwen Image 2.1 », « Oui », « 1:1 » se présentent comme du texte figé
  (`ux/canvas_1440_light_poster_card.png`).
- Proposition : remettre un chevron via un SVG inline en `background-image`, sans
  dépendance.

**État (2026-09-25)** : traité (Vague 4, `7fb2df2`) — chevron SVG inline sur les listes (7,13:1 clair, 8,47:1 sombre mesurés).

**C6 — Dans l'en-tête des cartes, le titre chevauche l'étiquette technique.**
- On lit « a cinematic photo of a.krea2 », « on the…en_edit » et « lighthouse keeper…
  charsheet » (`ux/canvas_1440_light_trailer_cards.png`).
- Proposition : réserver la largeur de l'étiquette avant de tronquer le titre, ou retirer
  l'étiquette de l'en-tête (elle figure déjà dans le panneau Propriétés).

**État (2026-09-25)** : traité (Vague 4, `7fb2df2`) — l'étiquette technique est retirée de l'en-tête de carte et reste dans le panneau Propriétés (`#propsCardType`).

**C7 — « Trailer narratif » pose 5 cartes sans dire par où commencer.**
- Les cartes arrivent en grille serrée de 2 colonnes, dans un ordre qui ne suit pas le flux.
  Les liens passent derrière les cartes.
- La carte sélectionnée, dont les propriétés s'ouvrent (« Vidéo finale »), est en partie hors
  écran à 1440×900 (`ux/canvas_1440_light_trailer_cards.png`). Or c'est la dernière à
  lancer.
- Proposition :
  - disposer la chaîne de gauche à droite, dans l'ordre du flux ;
  - cadrer la vue sur le groupe ;
  - sélectionner la **première** carte à lancer, et afficher sur les suivantes « À lancer
    après : Fiche personnage, Fiche décor ».

**État (2026-09-25)** : traité (Vague 4, `7fb2df2`) — trailer posé de gauche à droite, « À lancer après : … » sur les cartes suivantes, `fitView` à toutes les largeurs. **Non traité** : à 768 px (palette et Propriétés en colonnes, seuil de bascule à < 768 px) la zone libre entre les deux fait 252 px, le trailer y est réduit à des boîtes illisibles.

**C8 — Le bouton ⤢ « Recadrer la vue » ne recadre pas sur les cartes.**
- Il remet le décalage à 0 et l'échelle à 1 (`btnFit`), sans tenir compte de l'endroit où
  sont les cartes.
- Constaté dans le Browser pane, sur l'état réel : des cartes sont en partie sous la palette
  opaque. Même chose en headless, où tout un graphe est réapparu empilé sous la palette après
  rechargement (`ux/canvas_1440_dark_qwen_edit_21.png`, `ux/canvas_1440_light_es.png`).
- Proposition : cadrer sur la boîte englobante des nœuds, moins la largeur des panneaux.

**État (2026-09-25)** : traité (Vague 3, `f95edd8`) — ⤢ cadre la boîte englobante des cartes, hors panneaux et hors tiroir de galerie.

**C9 — Plusieurs commandes sont inaccessibles au clavier.**
- Thème, ⤢, 🗑 et les bascules « Image / Vidéo » du mode avancé sont des `<div>` sans
  `tabindex` ni `role`. Le clavier ne peut pas les atteindre, et un lecteur d'écran ne les
  annonce pas comme des boutons.
- Le graphe litegraph est par nature inaccessible. C'est acceptable pour l'outil « expert »,
  mais alors le panneau DOM doit l'être.
- Proposition : les remplacer par des `<button type="button">`, avec le même style.

**État (2026-09-25)** : traité (Vague 3, `f95edd8` : thème, ⤢, 🗑 et bascules Image/Vidéo en `<button>` ; Vague 4, `7fb2df2` : libellés reliés aux champs, tiroir au clavier). Le graphe litegraph lui-même reste inaccessible au clavier (assumé par l'audit pour l'outil « expert »).

### Impact faible

**C10 — En thème clair, contraste et taille du texte sont trop faibles.**
- Mesures en clair : étiquettes de champ 4,26:1 à **10,5 px** (sous le seuil AA de 4,5:1) ;
  descriptions des cas d'usage 4,52:1 à 10,5 px ; statut 2,41:1.
- Le thème sombre passe partout (6,3 à 7,8:1).
- Sur un écran de démo vu à 2 m, 10,5 px ne se lit pas. Proposition : 12 px minimum et
  `--text-2` un cran plus sombre en clair.

**État (2026-09-25)** : partiellement traité (Vague 4, `7fb2df2`) — textes des panneaux et du tiroir ≥ 12 px, contrastes DOM ≥ 4,5:1 mesurés dans les deux thèmes (étiquettes 4,88:1 en clair). **Non traité** : le texte dessiné sur le canvas litegraph, par exemple le pied de carte (`footerText` `#94a3b8` sur `#ffffff` en thème clair, ≈ 2,6:1).

**C11 — Registre de langue.**
- Le Canvas tutoie (« Qu'est-ce que tu veux produire ? ») ; le Studio vouvoie (« Décrivez »,
  « Modifiez les champs… »).
- Proposition : choisir un registre pour les deux apps.

**État (2026-09-25)** : traité (Vague 4 : `692f0c0` pour le Studio, `7fb2df2` pour le Canvas) — tutoiement en FR, ES et DE dans les deux apps. Le journal d'événements et les `throw new Error` restent en français, non traduits.

---

## 3. Cohérence Studio ↔ Canvas

**X1 (moyen) — Thème et langue ne suivent pas d'une app à l'autre.**
- Les deux apps stockent ces réglages sous des clés différentes : `theme` / `lang` pour le
  Studio, `canvasTheme` / `canvasLang` pour le Canvas.
- Constaté dans le Browser pane : Studio en clair, Canvas en sombre dans la même session. Un
  visiteur qui passe en anglais sur le Studio retrouve le Canvas en français.
- Le sélecteur n'a pas non plus la même forme :
  - Studio : codes courts « FR / EN-US / ES / DE » dans le header ;
  - Canvas : endonymes « Français / English… » dans le panneau.
- Proposition : mêmes clés pour les deux apps, ou lecture de la clé Studio en repli.

**État (2026-09-25)** : traité (Vague 4, `7fb2df2`) — clés `theme`/`lang` partagées (repli de lecture sur `canvasTheme`/`canvasLang`, jamais réécrites). **Non traité** : la forme du sélecteur diffère encore (codes courts dans le Studio, endonymes dans le Canvas).

**X2 (moyen) — L'app « guidée » guide moins que l'app « technique ».**
- Le Canvas s'ouvre sur « Qu'est-ce que tu veux produire ? » et 3 cartes d'objectif avec une
  phrase d'explication (`ux/canvas_1440_light.png`).
- Le Studio s'ouvre sur 4 émojis muets et 3 onglets anglais aux descriptions masquées (S5).
- Même fonction (choisir ce que l'on produit), deux présentations, sans raison. Voir A1.

**État (2026-09-25)** : traité (Vague 3, `04e5161`) — le Studio s'ouvre sur des cartes d'objectif, comme le Canvas.

**X3 (faible) — L'ordre de la paire Studio / Canvas s'inverse d'une page à l'autre.**
- « Studio | Canvas » sur le Studio, « Canvas | Studio » sur le Canvas : le bouton actif est
  toujours placé en premier, donc la cible du clic « changer d'app » change de place.
- Proposition : ordre fixe « Studio | Canvas » sur les deux pages.

**État (2026-09-25)** : traité (Vague 4, `7fb2df2`) — ordre fixe « Studio | Canvas » sur les deux pages.

**X4 (faible) — Mêmes actions, libellés différents.**
- Générer :
  - Studio : « Generate » (S7) et « Régénérer » ;
  - Relay : « Re-générer » ;
  - Canvas : « Régénérer » dès la première génération (C4).
- Enrichir :
  - Studio : « Enrichir le brief (LLM) » et « Auto-Enrich (gemma4:e4b) : OFF » ;
  - Canvas : « ✨ Enrichir (LLM) ».
- Moteur : « Modèle / Workflow » (Studio), « Modèle » ou « Moteur » (Canvas, voir C3).
- Icônes : SVG pour le rail, émojis (🔄 ✎ 🔒 📥 🎞 ✨ 🗑 ⤢) pour les actions, dans les deux
  apps.
- Proposition : un petit lexique commun, avec les clés `I18N` / `tr()` partagées pour ces
  quelques verbes.

**État (2026-09-25)** : traité (Vague 4 : `692f0c0` pour le Studio, `7fb2df2` pour le Canvas) — lexique commun (« Générer », « Régénérer », « Moteur », « ✨ Enrichir le brief (LLM) », « ✨ Enrichissement auto (gemma4:e4b) : non/oui »). **Non traité** : les icônes restent en SVG pour le rail et en émojis pour les actions.

---

## 4. Résumé chiffré

- **34 trouvailles** : 7 fortes, 18 moyennes, 9 faibles.
  - Studio : 19 (5 / 9 / 5).
  - Canvas : 11 (2 / 7 / 2).
  - Cohérence : 4 (0 / 2 / 2).
- **60 captures** dans `ux/` : 4 largeurs × 2 thèmes × 2 apps, plus les états (revue des plans,
  Montage, Relay, panneaux du rail, cartes du Canvas, moteur 2509 / 2.1, FR / EN / ES / DE,
  défilement mobile).
- Répartition par nature (une trouvaille peut relever de deux natures) :
  - responsive et mobile : 6 (S4, S14, S19, C1, C8, S13) ;
  - perte de travail sans filet : 4 (S1, S2, S11, C2, où l'entrée est ignorée en silence) ;
  - langue et vocabulaire : 7 (S7, S8, S9, C4, C11, X1, X4) ;
  - hiérarchie et orientation : 8 (S5, S6, S10, S12, S15, S16, C7, X2) ;
  - accessibilité (contraste, clavier, cibles) : 4 (C9, C10, S19, S3) ;
  - lisibilité des composants : 5 (C3, C5, C6, S17, S18).
- Ce qui fonctionne bien et ne doit pas régresser :
  - l'allemand du mode Réalisateur est complet et bien mis en page
    (`ux/studio_1440_light_de_director_storyboard.png`) ;
  - le thème sombre est lisible partout, contrastes du Canvas compris ;
  - les confirmations de « Nouveau projet », « Annuler le projet » et « Vider le canvas » ;
  - les cartes d'objectif du Canvas ;
  - le sélecteur visuel de gabarit de planche.

## 5. Axes structurants

**A1 — Un point d'entrée unique « par objectif », commun aux deux apps.**
- Reprendre dans le Studio le composant `.usecase` du Canvas : 3–4 cartes (Affiche / visuel,
  Pub courte, Trailer narratif, Déclinaisons locales), chacune avec titre et une phrase
  toujours visibles.
- Les profils métiers deviennent un préréglage de ces cartes, plutôt qu'une deuxième rangée.
  Choisir une carte n'écrit **jamais** dans le brief : l'exemple devient un `placeholder`.
- Le bouton principal prend un libellé qui dépend de la carte (« Générer les planches — étape
  1/3 »).
- Couvre S1, S5, S6, X2 et une partie de S8. Aucun rendu automatique : c'est toujours le clic
  qui lance.

**A2 — Une barre d'état de session dans le flux, à la place des éléments flottants et épars.**
- Aujourd'hui, l'état de la session est dispersé :
  - la pastille « Identité ancrée » est fixée par-dessus les réglages ;
  - le compteur de jobs est une ligne grise en pied de navigation ;
  - « Planches validées » est un bouton désactivé ;
  - la télémétrie GB10 est cachée derrière une icône, avec des jauges vides ;
  - le footer de timeline reste vide.
- Proposition : une seule barre sous le header qui montre les deux vignettes ancrées, l'étape
  courante 1-2-3, les jobs en cours (« job k/n · temps écoulé ») et la mémoire GPU du GB10
  en permanence. Pour une démo Dell, c'est la preuve matérielle qu'on veut voir à l'écran.
- Couvre S3, S10 (stepper), S12, S13, S15, S16, S17. Affichage seul, aucune action implicite.

**A3 — Une vraie mise en page sous 768 px, dans les deux apps.**
- Studio : rail et header dans le flux, navigation Réalisateur qui défile jusqu'à la section,
  actions de projet en bas, cibles de 44 px.
- Canvas : palette et Propriétés en feuilles basculantes, canvas plein écran, redimensionnement
  géré, recadrage sur le contenu.
- Couvre S4, S14, S19, C1, C8 et une partie de C9. Tout se fait en CSS (`@media`) et en
  quelques lignes de JS vanilla. Aucune librairie UI n'est nécessaire, donc aucun compromis
  « dépendance » à trancher.
