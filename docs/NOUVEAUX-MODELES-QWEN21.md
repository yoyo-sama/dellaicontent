# LOT Qwen21 — Qualification de Qwen Image 2.1 (édition d'image, coexistence avec 2509)

Compte-rendu de qualification, au format de `docs/NOUVEAUX-MODELES-LOT1.md`. Cadrage :
`docs/QWEN-IMAGE-2.1-ROADMAP.md`. **Écrit au fil de l'eau** : chaque section est remplie au
moment où son test est fait. Aucun verdict n'est fondé sur un statut de job — chaque PNG cité a
été ouvert et regardé.

- Rendus : `/home/sparks/comfyui-spark/basedir/output/studio/q21/`
- Entrées copiées : `/home/sparks/comfyui-spark/basedir/input/q21_*.png`
- Graphes soumis (copies de travail, hors repo) : scratchpad de session, reproduits ici quand ils
  comptent.
- ComfyUI 0.37.0, commit `73c9bad4` (2026-09-20), conteneur `comfyui-nvidia`.

## Récapitulatif

| Test | Preuve regardée | Verdict |
|---|---|---|
| Encodeur de texte | `q21/t2i_vl8b` vs `q21/t2i_pe_t2i`, `q21/i2i1_pe_i2i` | `qwen3vl_8b_int8_convrot` ; les `pe_*` rendent du bruit (§2) |
| t2i baseline | `q21/t2i_vl8b_00001_.png` + 10 `q21/ref_*` | OK (§2, §4) |
| i2i 1 réf | `q21/i2i1_{nodelat,empty1280,empty1024sq}` | OK (§3) |
| i2i multi-réf 2/4/7/10 | `q21/multi_{02,04,07,10}` | OK jusqu'à **10** (§4) |
| Dual charsheet+locsheet, 2.1 vs 2509 | `q21/dual21*_s42..47`, `q21/dual2509_s42..47` | 2.1 ≥ 2509 sur tous les critères (§5) |
| 2 sujets + décor | `q21/duo21_s42..44`, `q21/duo2509_s42..44` | Aucun moteur fiable (§6) |
| 2 planches + 7 réf. | `q21/nine21_s42/43`, `q21/helper9_s44` | OK (§7, §9) |
| Texte incrusté, 2.1 vs 2509 | `q21/text21_s42/43`, `q21/text2509_s42/43` | 2.1 exact, 2509 fautif (§8) |
| **Dual-ref** | — | **VERDICT DUAL-REF : (a) natif une passe** |

(Chemins relatifs à `/home/sparks/comfyui-spark/basedir/output/studio/`.)

## 0. Inventaire disque (reconfirmé le 2026-09-22)

`ls -la` + `stat -c %s` sur `/home/sparks/comfyui-spark/basedir/models/` :

| Fichier | Dossier | Taille (octets) |
|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | `diffusion_models/` | 7 256 783 064 |
| `qwen3vl_8b_int8_convrot.safetensors` | `text_encoders/` | 9 350 798 360 |
| `qwen_image_2.1_vae_bf16.safetensors` | `vae/` | 675 509 688 |
| `qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors` | `text_encoders/` | 9 471 072 252 |
| `qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors` | `text_encoders/` | 9 471 072 252 |

Les deux `pe_*` ont la même taille mais des contenus différents (md5 `3d3f3a0b…` pour t2i,
`2ee4cf11…` pour i2i).

## 1. Point de départ : ce qui a réellement tourné chez l'utilisateur

Les 30 `output/Qwen_image_2.1_000{01..30}.png` portent leur graphe API dans le chunk PNG
`prompt`. Trois structures distinctes (regroupées par signature de `class_type`) :

- **t2i** (21 PNG) : `UNETLoader` → `KSampler` ; `TextEncodeQwenImage21` sans image ;
  `EmptyLatentImage` alimenté par `ResolutionSelector` ; `SaveImageAdvanced`.
- **i2i 1 réf** (8 PNG) et **i2i 2 réfs** (1 PNG) : `UNETLoader` → `QwenImage21Cache` → `KSampler` ;
  `TextEncodeQwenImage21` avec `images.image_1` (+ `images.image_2`) et `vae` ;
  `latent_image` = `ComfySwitchNode(switch=false)` → **3ᵉ sortie `latent` du nœud d'encodage** ;
  `ImageCompare` (rgthree) en sortie parasite.
- Partout : `CLIPLoader(qwen3vl_8b_int8_convrot.safetensors, type qwen_image)`,
  `VAELoader(qwen_image_2.1_vae_bf16.safetensors)`, `KSampler` 25 steps, cfg 1, euler/simple.

Ce sont exactement les deux gabarits officiels ComfyUI (`comfyui_workflow_templates_json` :
`image_qwen_image_2_1_t2i.json`, `image_qwen_image_2_1_image_edit.json`) dépliés. Leur note
officielle dit : jusqu'à 10 références (`image_1`…`image_10`), à citer dans le prompt comme
`<image1>`, `<image2>`… ; `image_1` est la cible d'édition ; cfg 1 → négatif inutilisé ; le
pipeline officiel Qwen fait 40-50 steps, le gabarit en fait 25.

**Lecture du code du nœud** (`comfy_extras/nodes_qwen.py`, `TextEncodeQwenImage21.execute`) —
c'est ce qui change tout par rapport à 2509 :

- chaque image est redimensionnée à ~`resolution²` pixels (multiple de 32, ratio conservé), vue
  par l'encodeur de vision **et** encodée par le VAE ; tous les latents partent dans
  `reference_latents` du conditioning, **dans l'ordre `image_1`, `image_2`, …, de façon
  symétrique** ;
- la 3ᵉ sortie `latent` est un **latent VIDE (zéros)** à la taille de `image_1` redimensionnée —
  aucun `VAEEncode` de l'image 1 dans le latent de départ. Le « piège n°10 » de 2509 (image1 =
  géométrie de départ, image2 = conditioning seul) **n'a pas d'équivalent** : aucune référence
  n'est privilégiée au niveau du latent, comme pour Minimax H3 r2v.

Remplacements imposés par les règles du projet (core nodes uniquement) : `ResolutionSelector`
(plaguekind-nodes) → `{{WIDTH}}`/`{{HEIGHT}}` sur un `EmptyLatentImage` ; `ImageCompare`
(rgthree) supprimé ; `SaveImageAdvanced` → `SaveImage`. `ComfySwitchNode` retiré (inutile une
fois le latent fixé, cf. §3). `QwenImage21Cache` (core, expérimental) conservé comme dans le
gabarit officiel.

Les images d'entrée et prompts de ces 30 rendus manuels ne sont **pas** réutilisés (photos de
personnes réelles) : seule la structure des graphes l'est.

Graphe de travail utilisé pour tous les tests 2.1 ci-dessous (générateur Python en scratchpad) :
`UNETLoader(qwen_image_2.1_int8_convrot)` → `QwenImage21Cache(auto, default)` → `KSampler(seed 42,
25 steps, cfg 1, euler, simple, denoise 1)` ; `CLIPLoader(<encodeur testé>, qwen_image)` +
`VAELoader(qwen_image_2.1_vae_bf16)` → `TextEncodeQwenImage21(resolution 1024, négatif "")` ;
`LoadImage` × N → `images.image_1..N` ; `latent_image` = `EmptyLatentImage(W, H)` ou sortie
`latent` du nœud ; `VAEDecode` → `SaveImage(studio/q21/…)`.

## 2. Encodeur de texte : `qwen3vl_8b_int8_convrot` — les `pe_*` NE SONT PAS des encodeurs

**Verdict : les gabarits livrés référencent `qwen3vl_8b_int8_convrot.safetensors`. Les deux
`qwen3.5_9b_qwen_image_2.1_pe_{t2i,i2i}` ne sont référencés nulle part.**

Preuves :

1. **Code ComfyUI** (`comfy/sd.py`) : `CLIPLoader type qwen_image` ne construit l'encodeur Qwen
   Image 2.1 (`comfy.text_encoders.qwen_image21`, dernière couche cachée, fentes d'images
   remplacées par les latents de référence) **que si le fichier est détecté `QWEN3VL_8B`**. Un
   fichier Qwen3.5-9B tombe dans la branche générique `qwen35.te` — un LLM Qwen3.5 brut. Les en-têtes
   safetensors confirment : les `pe_*` contiennent un `lm_head` et une tour de vision Qwen3.5
   (1 380 tenseurs) — ce sont des **LLM générateurs « prompt enhancer »** (réécriture de prompt,
   à brancher sur `TextGenerate`), pas des encodeurs de conditioning. Les gabarits officiels
   ComfyUI ne les citent d'ailleurs pas (leur liste de modèles : diffusion + `qwen3vl_8b` + VAE).
2. **Log ComfyUI** : avec `qwen3vl_8b` → `Requested to load QwenImage21TEModel_` ; avec
   `pe_t2i` → `Requested to load Qwen35TEModel_`.
3. **Rendus — deux jobs « success », deux images détruites** :
   - t2i, même prompt, même seed (vieux pêcheur ravaudant un filet orange sur un ponton à l'aube),
     1280×720 :
     - `output/studio/q21/t2i_vl8b_00001_.png` (**qwen3vl_8b**) — regardé : pêcheur barbu au
       bonnet marine, filet orange au premier plan, barques bleues amarrées, brume et lumière
       froide de l'aube. Photoréaliste, conforme au prompt mot pour mot.
     - `output/studio/q21/t2i_pe_t2i_00001_.png` (**pe_t2i** comme encodeur) — regardé : **bruit
       pur**, texture granuleuse beige/gris uniforme sur toute l'image, aucun sujet. Job en
       statut `success`.
   - i2i 1 réf (§3), même prompt, même seed :
     `output/studio/q21/i2i1_pe_i2i_00001_.png` (**pe_i2i** comme encodeur) — regardé :
     silhouette fantôme floue de la femme et du phare noyée dans du bruit gris-vert. Inutilisable.
     Même job avec `qwen3vl_8b` : impeccable (§3).

C'est un cas d'école du piège n°14 : un nom de fichier plausible, un job `success`, une image
détruite.

**Liste finale des fichiers modèles référencés par les gabarits livrés** (pour le lot
`scripts/models.txt`) — voir aussi la section finale :

| Chemin (sous `models/`) | Octets |
|---|---|
| `diffusion_models/qwen_image_2.1_int8_convrot.safetensors` | 7 256 783 064 |
| `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 9 350 798 360 |
| `vae/qwen_image_2.1_vae_bf16.safetensors` | 675 509 688 |

La roadmap (§ Tâches, point 5) prévoyait d'ajouter les deux `pe_i2i`/`pe_t2i` à
`scripts/models.txt` : **c'est à corriger** — il faut `qwen3vl_8b_int8_convrot` à la place, et
les `pe_*` (2 × 9,5 Go) n'ont pas à être téléchargés par `install.sh`.

## 3. i2i mono-référence (édition)

Entrée : `input/lot1_scene_a.png` (832×480, femme aux cheveux blancs courts, ciré jaune, écharpe
rouge, jetée de pierre, phare, mer démontée). Prompt : « Change the yellow raincoat of the woman
in `<image1>` into a bright red raincoat. Keep her face, her short white hair, her red scarf, her
pose, the stone pier, the lighthouse, the stormy sea and the lighting exactly unchanged. »
Modèles : `qwen_image_2.1_int8_convrot` + `qwen3vl_8b_int8_convrot` + `qwen_image_2.1_vae_bf16`,
`resolution 1024`, 25 steps, ≈ 30-40 s par image sur le GB10.

- `output/studio/q21/i2i1_nodelat_00001_.png` (latent = sortie `latent` du nœud → 1344×768) —
  regardé : ciré devenu **rouge vif**, tout le reste identique à l'entrée (même visage trait pour
  trait, taches de rousseur, même écharpe tricotée, même phare à porte rouge et lanterne allumée,
  même houle, même lumière de fin de jour). Édition propre, locale, fidèle.
- `output/studio/q21/i2i1_empty1280_00001_.png` (latent = `EmptyLatentImage` 1280×720, même
  ratio que l'entrée) — regardé : résultat quasi identique au précédent, cadrage à peine
  resserré. Aucune dérive.
- `output/studio/q21/i2i1_empty1024sq_00001_.png` (`EmptyLatentImage` **1024×1024**, ratio
  différent de l'entrée) — regardé : le modèle **recompose** le plan au carré (personnage plus
  grand dans le cadre, phare décalé à droite) en gardant identité, ciré rouge, écharpe, phare et
  mer. Pas de déformation ni d'étirement : le canevas de sortie est libre.

**Verdict i2i 1 réf : OK.** Conséquence gabarit : on peut fixer le latent par
`EmptyLatentImage({{WIDTH}}, {{HEIGHT}}, {{BATCH}})` sans passer par la sortie `latent` du nœud.
Pour une **retouche au pixel près** l'UI doit passer `WIDTH`/`HEIGHT` au ratio de `image_1`
(la note officielle : « keep it close to the resized image_1 size, or the edit can shift ») ;
pour une **composition** (keyframe), le ratio est libre.

## 4. i2i multi-référence progressive : 2 → 4 → 7 → 10

Références : 10 objets/sujets **distincts et reconnaissables** générés en t2i 2.1 (768×768,
fond studio gris uni — ce qui qualifie au passage le t2i sur 10 rendus supplémentaires, tous
propres), copiés en `input/q21_ref{01..10}_*.png` : 1 téléphone à cadran rouge, 2 théière bleu
cobalt à pois blancs, 3 canard en caoutchouc au chapeau de pirate, 4 bouteille verte avec
trois-mâts miniature, 5 haut-de-forme en velours violet à ruban doré, 6 chat roux tigré à
plastron blanc et collier bleu à grelot, 7 montre à gousset en laiton couvercle ouvert chiffres
romains, 8 lampe flamant rose à abat-jour blanc, 9 chouette en porcelaine blanche aux yeux dorés,
10 pile de trois livres rouge/sarcelle/moutarde (sources : `output/studio/q21/ref_{01..10}_*_00001_.png`).

Prompt (N = 2, 4, 7, 10, les N premières références) : bureau ancien en bois dans un bureau
ensoleillé, « Arranged together on the desk, each exactly as it looks in its reference image,
are: the telephone from `<image1>`, the teapot from `<image2>`, … Every one of these N items
appears exactly once, whole and clearly visible. » — le texte ne donne **que le nom commun** de
chaque objet, jamais sa couleur ni ses détails : tout ce qui est fidèle vient de l'image.
1344×768, seed 42, `resolution 1024`.

| N | PNG regardé | Temps GB10 | Ce qui y a été vu |
|---|---|---|---|
| 2 | `output/studio/q21/multi_02_00001_.png` | 40 s | Téléphone rouge (cordon spiralé, cadran argent) et théière à pois : copies conformes. |
| 4 | `output/studio/q21/multi_04_00001_.png` | 70 s | + canard au tricorne tête de mort, + bouteille verte **avec son trois-mâts**. 4/4 fidèles. |
| 7 | `output/studio/q21/multi_07_00001_.png` | 230 s | + haut-de-forme violet ruban doré, + chat roux collier bleu **grelot doré**, + montre à gousset chiffres romains. 7/7 fidèles, zoom vérifié. |
| 10 | `output/studio/q21/multi_10_00001_.png` | 360 s | + lampe flamant, + chouette yeux dorés, + pile de livres **dans le bon ordre** (rouge en bas, sarcelle, moutarde en haut). **10/10 présents et reconnaissables.** Seul écart : la montre est éclatée en deux pièces (boîtier + couvercle posé à part comme une coupelle) et le trois-mâts dans la bouteille est moins net qu'à N=7. |

**Verdict multi-réf : la fidélité ne décroche pas jusqu'à 10.** Premier signe d'usure à N=10 sur
les deux objets à petits détails (couvercle de montre dissocié, maquette de bateau floue), sans
perte d'identité. **Plafond prouvé : N = 10** (au-delà : non rendu, non qualifié — la note
officielle du gabarit ComfyUI s'arrête aussi à 10, le schéma à 16 n'est qu'un nombre de fentes).
Coût : le temps de rendu croît plus vite que N (×9 entre 2 et 10 réf.) — chaque référence ajoute
~4 000 jetons latents à `resolution 1024`.

## 5. Dual charsheet + locsheet — même plan en 2.1 et en 2509 (côte à côte)

Références : **les mêmes que LOT 1**, `output/studio/lot1/charsheet_00001_.png` et
`locsheet_00001_.png` (1920×1088), copiées en `input/q21_charsheet.png` / `input/q21_locsheet.png`
(regardées : femme pixie blanc/argent, taches de rousseur, ciré jaune à brandebourgs noirs,
écharpe rouge tricotée, jean, bottes olive ; intérieur de phare, pierre blanchie, fenêtres
cintrées à petits carreaux, carrelage vert, escalier hélicoïdal en fonte, laitons sur colonnes,
lanternes murales, mer démontée derrière les vitres).

Prompt : **la branche à UN sujet de `compileKeyframePrompt` reproduite au caractère près**
(`index.html`, `KEYFRAME_ANCHOR_SOLO` inclus), avec charDesc = la femme ci-dessus, locDesc =
l'intérieur de phare ci-dessus, action « she stands beside a brass telescope on its pedestal and
looks out of the arched window at the storm », caméra `medium` (« a medium shot of the character
from the waist up »), lumière `overcast`. C'est le texte que l'app enverrait aujourd'hui.

Trois variantes × **6 seeds (42 à 47)**, soit 18 rendus :

- **2.1 verbatim** — graphe 2.1, `images.image_1` = charsheet, `images.image_2` = locsheet,
  `EmptyLatentImage` 1344×768, prompt ci-dessus tel quel. `output/studio/q21/dual21_s{42..47}_00001_.png`.
- **2.1 balises** — idem, « the first/second reference image » remplacés par `<image1>`/`<image2>`
  (idiome officiel 2.1). `output/studio/q21/dual21tag_s{42..47}_00001_.png`.
- **2509** — `workflows/api/qwen_edit_dual.json` **inchangé** (Lightning 4 steps, image1 →
  `VAEEncode` + conditioning, image2 conditioning seul), même prompt, mêmes seeds.
  `output/studio/q21/dual2509_s{42..47}_00001_.png` (sortie 1392×752).

Planche de comparaison regardée (6 lignes × 3 colonnes), puis chaque PNG individuellement et des
recadrages visage/sol :

| Critère (6 seeds) | 2.1 verbatim | 2.1 balises | 2509 |
|---|---|---|---|
| **Un seul exemplaire du personnage** | **5/6** (s42 : deux fois la femme, une de face au fond, une au premier plan) | 5/6 (s42 : idem, l'une de dos) | **3/6** (s42, s43 : deux femmes face à face ; s47 : une femme + une réplique miniature) |
| Identité (visage, coupe pixie, rousseur) | Fidèle : recadrage `dual21_s45` vs portrait de la charsheet — même coupe effilée, même rousseur, même regard gris-bleu | Idem | Tenue fidèle, **visage plus âgé et générique**, cheveux gris plutôt que blanc argent (`dual2509_s44`) |
| Tenue (ciré jaune brandebourgs, écharpe rouge, jean, bottes olive) | 6/6 | 6/6 | 6/6 |
| Décor de la locsheet (fenêtres cintrées vertes, pierre blanchie, carrelage vert, escalier fonte, laitons sur colonnes, lanternes, mer démontée) | 6/6 — tous les éléments, plus le coffre en bois de la locsheet sur s43 | 6/6 | 6/6 — mais c'est **toujours la même composition** (lanterne à gauche, laiton, fenêtre centrale, escalier à droite) calquée sur la 1ʳᵉ vignette de la locsheet |
| Action (longue-vue, regard vers la fenêtre) | 6/6 longue-vue en laiton présente, personnage tourné vers la fenêtre (s44 : deux longues-vues au lieu d'une) | 6/6 | **1/6** : longue-vue seulement sur s43 ; ailleurs les laitons de la planche (habitacles à cardan) sans longue-vue |
| Cadrage demandé (« waist up ») | Plan américain / trois-quarts, varié d'un seed à l'autre, jamais en pied | Idem | **6/6 en pied, centré** — le cadrage n'est jamais suivi (piège n°8 : 2509 garde la pose de la planche de référence) |
| Collage / planche / split-screen | 0/6 | 0/6 | 0/6 |

Lecture : le décor tient **simultanément** avec l'identité en 2.1, dans une scène unique et
recomposée librement (le canevas n'est pas imposé par une référence : latent vide, cf. §1). En
2509 le décor tient aussi, mais le plan est figé sur la géométrie de la planche perso (piège
n°10) et le personnage est dupliqué une fois sur deux — la 1ʳᵉ planche montrant quatre vues en
pied, 2509 en rend souvent deux. **Sur ce plan, 2.1 fait mieux que 2509 sur tous les critères**,
sans aucune modification du prompt compilé par l'app ; les balises `<image1>`/`<image2>` ne
changent rien de mesurable (rendus quasi identiques seed à seed) — le texte actuel peut partir
tel quel.

Réserve : la duplication n'est pas éliminée en 2.1 (1/6), elle est divisée par trois ; le
cadrage « waist up » est approché (trois-quarts) sans être tenu au centimètre.

## 6. Deux sujets + décor (chemin à 2 sujets, pièges n°17/32) — 2.1 vs 2509

Pour savoir si 2.1 déplace le plafond « 2 sujets par plan », même exercice sur la branche à
**deux sujets** de `compileKeyframePrompt` (+ `KEYFRAME_ANCHOR_DUAL`), reproduite au caractère
près avec kinds `human` / `other`. Sujet 2 : `input/charsheet_00102_.png` copiée en
`input/q21_charsheet2.png` (regardée : panda roux en scaphandre blanc/orange/rouge sombre, casque
à dôme cerclé d'or, sac de survie blanc, gants noirs, écussons drapeau). Action : la femme et le
panda astronaute côte à côte à la fenêtre cintrée, plan large. 2.1 : `image_1` charsheet,
`image_2` charsheet2, `image_3` locsheet. 2509 : `qwen_edit_dual.json` + 3ᵉ entrée greffée
exactement comme `addKeyframeThirdRef` (`LoadImage` → `FluxKontextImageScale` → `image3`).
Seeds 42/43/44.

| Seed | 2.1 (`output/studio/q21/duo21_s*_00001_.png`) | 2509 (`output/studio/q21/duo2509_s*_00001_.png`) |
|---|---|---|
| 42 | **Correct** : une femme + un panda astronaute, tous deux entiers, dans le phare (fenêtres, escalier, laitons, lanternes) — mais tous deux vus de dos | 3 femmes + le panda, dans le décor |
| 43 | 2 femmes + le panda, dans le décor | **Planche de référence recopiée** (portraits, 4 vues en pied, nuancier, fond gris) — le collage que l'ancrage interdit |
| 44 | 2 femmes + panda à moitié caché, dans le décor | Femme + panda corrects mais **décor perdu** : fond studio gris uni |

Verdict 2 sujets : **aucun des deux moteurs n'est fiable** (2.1 : 1/3 ; 2509 : 0/3). 2.1 ne
casse jamais le décor ni ne recrache une planche, mais il duplique le personnage humain. Le
plafond de 2 sujets par plan (AGENTS.md) **reste pertinent** quel que soit le moteur ; 2.1 ne
justifie pas de le relever, et ce chemin reste « non qualifié » pour les deux moteurs.

## 7. Plafond storyboard : 2 planches + 7 références supplémentaires (9 images)

La roadmap aligne le storyboard sur le plafond Minimax H3 r2v (7 références en plus des
planches). Rendu : `image_1` charsheet, `image_2` locsheet, `image_3..9` = objets 1 à 7 du §4
(téléphone, théière, canard, bouteille, haut-de-forme, chat, montre). Prompt = branche à un sujet
de `compileKeyframePrompt` au caractère près, action « she sits at a small wooden table by the
arched window; on the table, each exactly as it looks in its own reference image, stand the
telephone from `<image3>`, … the pocket watch from `<image9>` — every one of these seven items
appears exactly once, whole and clearly visible », caméra `medium`, 1344×768.

- `output/studio/q21/nine21_s42_00001_.png` (300 s) — regardé : **une seule** femme, identité et
  tenue conformes, décor complet (fenêtres cintrées sur la tempête, lanternes, escalier fonte,
  laiton sur colonne, carrelage vert). Sur la table : téléphone rouge, théière à pois, canard
  pirate, bouteille verte, haut-de-forme violet, chat roux, montre — **7/7**. Défauts : le chat
  est rendu à l'échelle d'une figurine, et la femme est accroupie au lieu d'assise.
- `output/studio/q21/nine21_s43_00001_.png` (80 s — le cache `QwenImage21Cache` a resservi le
  préfixe des 9 références identiques) — regardé : une seule femme, de face, **visage conforme
  au portrait de la charsheet**, assise à la table ; décor complet. Téléphone, théière, canard,
  haut-de-forme, bouteille (trois-mâts visible), chat (à la bonne échelle, derrière la table) sur
  la table ; la montre à gousset est devenue une horloge montée sur une colonne de laiton à
  gauche — présente mais réinterprétée. **7/7 présents, 6/7 fidèles.**

Verdict : à 9 références, **identité + décor tiennent simultanément** et les 7 extras sont tous
là ; les erreurs portent sur l'échelle ou la mise en scène d'un extra, jamais sur le sujet ou le
lieu. **Plafond storyboard « 2 planches + 7 » prouvé en 2.1.**

## 8. Texte incrusté — 2.1 vs 2509, même prompt

Édition de `input/lot1_scene_a.png` : « Add a large weathered wooden sign standing on the stone
pier to the left of the woman … The sign reads, in bold white painted capital letters on three
lines: "PHARE DE KERBIHAN" / "ACCÈS INTERDIT" / "PAR GROS TEMPS". Keep the woman … unchanged. »
2.1 : graphe 2.1 à 1 réf (`<image1>`), 1344×768. 2509 : `workflows/api/qwen_edit_i2i.json`
inchangé, même prompt (`<image1>` → « the image »). Seeds 42/43.

| PNG regardé | Texte lu sur le panneau | Verdict |
|---|---|---|
| `output/studio/q21/text21_s42_00001_.png` | PHARE DE / KERBIHAN / ACCÈS INTERDIT / PAR GROS TEMPS | **Exact**, accent grave correct (4 lignes au lieu de 3) |
| `output/studio/q21/text21_s43_00001_.png` | PHARE DE KERBIHAN / ACCÈS INTERDIT / PAR GROS TEMPS | **Exact**, 3 lignes comme demandé |
| `output/studio/q21/text2509_s42_00001_.png` | PHARE DE KERBIHAN / **/ ACCÉS** INTERDIT / PAR **GOS TEMPES** | Faux : barre oblique recopiée, È→É, 2 fautes |
| `output/studio/q21/text2509_s43_00001_.png` | PHARE DE KERBIHAN / **/ ACCÉS** INTERDIT / **· PAR GOS TEMPES** | Faux : mêmes fautes, puce parasite |

Dans les quatre rendus le reste de l'image est préservé (visage, ciré, écharpe, phare). 2509
laisse en plus un **liseré clair** sur les bords bas et droit de l'image (1328×800) ; 2.1 non.
**Verdict texte : 2.1 nettement supérieur** (2/2 exacts vs 0/2), ce qui confirme le constat
manuel de la roadmap.

## 9. Gabarits livrés et validation outillée

`workflows/api/qwen21_i2i.json` et `workflows/api/qwen21_dual.json` — même graphe que les tests,
à une `LoadImage` près :

- `1 UNETLoader(qwen_image_2.1_int8_convrot)` → `4 QwenImage21Cache(auto, default)` →
  `7 KSampler(seed {{SEED}}, 25 steps, cfg 1, euler, simple, denoise 1)`
- `2 CLIPLoader(qwen3vl_8b_int8_convrot, qwen_image)` + `3 VAELoader(qwen_image_2.1_vae_bf16)` →
  `5 TextEncodeQwenImage21(prompt {{PROMPT}}, negative_prompt {{NEGATIVE_PROMPT}}, resolution 1024,
  images.image_1 ← 10 LoadImage({{IMAGE}})` [+ `images.image_2 ← 11 LoadImage({{IMAGE2}})` pour le dual]`)`
- `6 EmptyLatentImage({{WIDTH}}, {{HEIGHT}}, {{BATCH}})` → `latent_image`
- `8 VAEDecode` → `9 SaveImage` (`studio/qwen21_i2i` / `studio/qwen21_dual`) — **`SaveImage`**,
  pas `SaveImageAdvanced`.
- Aucun custom node, aucun `ComfySwitchNode` (la 3ᵉ sortie `latent` du nœud n'est pas utilisée :
  §3 montre qu'un `EmptyLatentImage` au même ratio donne le même résultat, et il porte `{{BATCH}}`).

`tools/validate.py` : `"IMAGE2"` ajouté à `STRING_PLACEHOLDERS`, option `--image2`, et refus
explicite si le graphe contient `{{IMAGE2}}` sans `--image2` (vérifié : `[FAIL] placeholder
substitution`). `tools/object_info.json` rafraîchi depuis `:8188` (il connaît maintenant
`TextEncodeQwenImage21`) — **note : ce fichier est dans `.gitignore`, il n'est pas versionné**,
le rafraîchissement est local.

- `python3 tools/validate.py workflows/api/qwen21_i2i.json --image lot1_scene_a.png --frames 0`
  → tout OK ; `output/studio/qwen21_i2i_00001_.png` regardé (prompt de test générique « cinematic
  wide shot, golden hour… ») : la même femme sur la même jetée, recadrée en plan large au
  coucher du soleil, phare à porte rouge conservé. Cohérent.
- `python3 tools/validate.py workflows/api/qwen21_dual.json --image q21_charsheet.png --image2
  q21_locsheet.png --frames 0` → tout OK ; `output/studio/qwen21_dual_00001_.png` regardé :
  **quatre copies de la femme** alignées dans le phare, reproduisant les 4 vues en pied de la
  charsheet. Le gabarit est sain (identité et décor parfaits), mais **sans le bloc d'ancrage
  (`KEYFRAME_ANCHOR_SOLO`) la mise en page de la planche fuit dans la scène** : l'ancrage reste
  obligatoire en 2.1 comme en 2509 (piège n°31), le prompt compilé par l'app le fournit déjà.

Helper `addQwen21Refs` (section finale) **exécuté** sous Node sur `qwen21_dual.json` substitué par
une copie exacte de `buildGraph`, avec 7 noms → clés `images.image_1` … `images.image_9`
contiguës, `names` vide/absent ⇒ graphe inchangé (assertions), puis graphe soumis tel quel :
`output/studio/q21/helper9_s44_00001_.png` regardé — une seule femme conforme, décor complet,
les 7 objets sur la table (chat à nouveau trop petit, montre minuscule). Le helper marche.

Déterminisme : à seed fixe, deux soumissions du même graphe 9 réf. donnent des PNG **identiques
octet pour octet** (`nine21_s42_00001_`/`_00002_` même md5 `702450b5…`) — les `_00002_` de
`nine21_*` sont une double soumission involontaire, sans autre conséquence.

## VERDICT DUAL-REF : (a) natif une passe

**Preuve** :

1. **Mécanisme** (§1) : `TextEncodeQwenImage21` traite toutes les références de façon symétrique
   (conditioning + `reference_latents`), et le latent de départ est vide — il n'existe pas de
   contrainte « image1 → `VAEEncode` » à contourner. Rien n'impose une seconde passe.
2. **Même plan, mêmes planches, même prompt que l'app, 6 seeds** (§5) : identité (visage, coupe,
   rousseur, tenue) **et** décor de la locsheet tiennent simultanément en une seule passe ;
   personnage unique 5/6 contre 3/6 pour 2509, action (longue-vue) 6/6 contre 1/6, cadrage
   suivi alors que 2509 reste en pied, identité du visage meilleure. 2.1 atteint et dépasse le
   niveau qualifié pour 2509 sur son chemin qualifié (un sujet + décor).
3. **Plafond storyboard « 2 planches + 7 références »** (§7, §9) : 3 rendus, identité + décor +
   7/7 extras présents, via le helper livré.
4. Le prompt compilé par `compileKeyframePrompt` (branche à un sujet, `KEYFRAME_ANCHOR_SOLO`)
   part **tel quel** — les balises `<image1>`/`<image2>` n'apportent rien de mesurable (§5).

L'option (b) deux passes n'a pas été rendue : (a) tient, elle n'a pas d'objet.

**Limites qui suivent le moteur** (à reporter dans les lots UI) :

- À deux sujets (§6), 2.1 n'est pas fiable (1/3 : duplication du personnage humain) — mais 2509
  non plus (0/3). Le plafond « 2 sujets par plan » d'AGENTS.md reste valable ; le chemin à
  deux sujets reste non qualifié quel que soit le moteur.
- La duplication du personnage (planche à 4 vues en pied) subsiste à ~1/6 en 2.1.
- Le bloc d'ancrage est indispensable (§9 : sans lui, 4 copies du personnage).
- Échelle des références d'objets parfois fausse (chat en figurine) — cosmétique.

## Contrat pour les lots UI

**Gabarits livrés** (aucune entrée `manifest.json` écrite dans ce lot — c'est au lot suivant) :

| Fichier | Usage | Références câblées | Sortie |
|---|---|---|---|
| `workflows/api/qwen21_i2i.json` | Édition Canvas (moteur 2.1 à côté de `qwen_edit_i2i.json`) | `images.image_1` ← `{{IMAGE}}` (nœud `10`) | `SaveImage` nœud `9`, `studio/qwen21_i2i` |
| `workflows/api/qwen21_dual.json` | Ancrage keyframe `storyboard_v2`/`reference2video` (à côté de `qwen_edit_dual.json`) | `images.image_1` ← `{{IMAGE}}` = planche sujet (nœud `10`), `images.image_2` ← `{{IMAGE2}}` = planche décor (nœud `11`) | `SaveImage` nœud `9`, `studio/qwen21_dual` |

**Placeholders** : `{{PROMPT}} {{NEGATIVE_PROMPT}} {{SEED}} {{WIDTH}} {{HEIGHT}} {{BATCH}} {{IMAGE}}`
(+ `{{IMAGE2}}` pour le dual). Pas de `{{DURATION}}`/`{{FRAMES}}`.

- `{{NEGATIVE_PROMPT}}` : **passer une chaîne** (`""` convient, cfg 1 ⇒ jamais utilisé). `buildGraph`
  fait `JSON.stringify(p.negative)` : avec `negative` absent il injecterait `undefined` nu et
  `JSON.parse` casserait. (Le nœud Canvas `QwenEditNode` passe déjà `negative: ""` : OK.)
- `{{WIDTH}}`/`{{HEIGHT}}` : ~1 MP ; multiples de 32 recommandés par la note officielle, mais
  le 1280×720 des `RATIOS` du projet (720 = multiple de 16 seulement) est rendu proprement (§3,
  §9) ; 1344×768 qualifié pour les keyframes ; natif jusqu'à 2048². Pour une **retouche** (Canvas) : le ratio de l'image d'entrée, sinon le modèle
  recompose le cadre (§3). **Attention : `QwenEditNode` (`js/nodes-simple.js`) passe aujourd'hui
  `width: 1024, height: 1024` en dur** — ignoré par le gabarit 2509 (latent = `VAEEncode` de
  l'image), mais avec 2.1 toute retouche sortirait recadrée au carré (`i2i1_empty1024sq`). Le lot
  Canvas doit calculer `WIDTH`/`HEIGHT` depuis l'image d'entrée (~1 MP, multiples de 32, même
  formule que le nœud : `round(sqrt(1024²·r)/32)·32` × `round(sqrt(1024²/r)/32)·32`). Pour une
  **keyframe** : le ratio du plan, libre.
- **Nœud de sortie : `SaveImage`** (`class_type === "SaveImage"`) : le repatch de
  `filename_prefix` de l'app (`studio/story/key_NN`) fonctionne tel quel.
- Prompt : les références se désignent `<image1>`, `<image2>`, … dans l'ordre des clés
  `images.image_N`. Le prompt de keyframe actuel (« the first/second reference image ») marche à
  l'identique : `compileKeyframePrompt` et `KEYFRAME_ANCHOR_SOLO` sont réutilisables **sans
  modification**, bloc d'ancrage obligatoire (§9). Les références ajoutées par le helper sont
  `<image2>`… en Canvas, `<image3>`… en storyboard.
- Ne **pas** porter `addKeyframeThirdRef` (spécifique `TextEncodeQwenImageEditPlus`) : en 2.1 une
  3ᵉ image passe par `addQwen21Refs`.

**Plafond N prouvé** : **10 références au total** en Canvas (`{{IMAGE}}` + 9 via le helper, §4) ;
**2 planches + 7 références supplémentaires = 9** en storyboard (§7/§9), aligné sur Minimax H3
r2v comme le veut la roadmap. Au-delà de 10 : non rendu, non qualifié — ne pas exposer, même si
le schéma du nœud déclare 16 fentes. Le plafond de **2 sujets par plan reste inchangé** (§6).

**Coût GB10** (premier passage, 25 steps) : 30-50 s à 1-2 réf., ~120 s à 3, 230 s à 7, 300-360 s à
9-10. Le `QwenImage21Cache` réutilise le préfixe des références : régénérer avec les **mêmes**
références et un autre seed est bien plus rapide (9 réf. : 300 s → 80 s).

**Helper à ajouter dans `js/engine.js`** (calqué sur `addMinimaxRefs`, exécuté et rendu au §9) :

```js
  // ── Qwen Image 2.1 : références supplémentaires de TextEncodeQwenImage21 ─────
  // api/qwen21_i2i.json câble `images.image_1` ({{IMAGE}}), api/qwen21_dual.json
  // `images.image_1`/`images.image_2` ({{IMAGE}}/{{IMAGE2}}) ; buildGraph ne substitue
  // rien au-delà. Ce helper greffe une LoadImage par nom, à la suite, sous la clé autogrow
  // "images.image_<N>" (1-indexée, contiguë — le prompt les désigne <imageN>). Toutes les
  // références sont symétriques (conditioning seul, latent de départ vide) : pas de
  // piège n°10 ici. Plafond prouvé en rendu : 10 images au total (Canvas), 2 planches + 7
  // (storyboard) — c'est à l'appelant de borner `names`.
  // Ids "q21ref<N>" non numériques, comme les "ref<N>" d'addMinimaxRefs.
  // `names` vide (ou absent) ⇒ graphe rendu strictement inchangé.
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
```

**Fichiers modèles pour le lot `scripts/models.txt`** (les 3 seuls référencés par les gabarits) :

| Chemin | Octets |
|---|---|
| `/home/sparks/comfyui-spark/basedir/models/diffusion_models/qwen_image_2.1_int8_convrot.safetensors` | 7256783064 |
| `/home/sparks/comfyui-spark/basedir/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 9350798360 |
| `/home/sparks/comfyui-spark/basedir/models/vae/qwen_image_2.1_vae_bf16.safetensors` | 675509688 |

Source officielle (note du gabarit ComfyUI) : dépôt Hugging Face `Comfy-Org/Qwen-Image-2.1`,
sous-dossiers `diffusion_models/`, `text_encoders/`, `vae/`. **Ne pas** ajouter
`qwen3.5_9b_qwen_image_2.1_pe_t2i/pe_i2i` (§2 : ce ne sont pas des encodeurs, 2 × 9 471 072 252
octets inutiles) — la roadmap est à corriger sur ce point.

## Extension aux pipelines Text2Image / Image2Image du Studio

**Lot Q21-STUDIO (2026-09-25).** Jusque-là Qwen Image 2.1 n'était câblé que dans l'ancrage des keyframes
(`storyboard_v2_qwen21`) et la carte Canvas « Édition d'image ». Il est désormais **sélectionnable dans la liste
« Moteur »** des pipelines `text2image` et `image2image` du Studio, **en coexistence** : Krea 2 Turbo (t2i) et
Qwen-Edit 2509 (i2i) restent premiers de la liste et moteurs par défaut.

| Élément | Valeur |
|---|---|
| `workflows/api/qwen21_t2i.json` (nouveau) | `qwen21_i2i.json` sans `LoadImage` (nœud 10) ni entrée `images.image_1` de `TextEncodeQwenImage21` ; `SaveImage` `studio/qwen21_t2i` ; placeholders `{{PROMPT}} {{NEGATIVE_PROMPT}} {{WIDTH}} {{HEIGHT}} {{BATCH}} {{SEED}}` |
| Manifest | `qwen21_t2i` (pipeline `text2image`, « Qwen Image 2.1 — Text2Image ») après `krea2_t2i` ; `qwen21_i2i` (pipeline `image2image`, « Qwen Image 2.1 — Édition / références », `api/qwen21_i2i.json`) après `qwen_edit_i2i` |
| Modèles | les trois de `scripts/models.txt` (transformer, `qwen3vl_8b_int8_convrot`, VAE 2.1) : rien à ajouter |
| Affichage | `WORKFLOW_LABELS` : « Qwen Image 2.1 » pour les deux (nom propre, comme « Krea 2 Turbo » et « Qwen-Edit 2509 » : aucune clé `I18N`, donc aucune orpheline) |

Le graphe t2i est celui du § 9 moins la référence : c'est le graphe de travail qualifié au § 2 (`q21/t2i_vl8b`) et
aux § 4 (10 rendus `q21/ref_*`), avec `QwenImage21Cache`. (Le gabarit officiel ComfyUI de t2i n'a pas ce nœud, sans
objet sans référence ; on garde le graphe réellement rendu.)

**Comportement dans le Studio** (`index.html`, aucun changement de `js/engine.js`) :

- **LoRA** : jamais de LoRA Krea 2 sur ce moteur. `renderLoraSelect` ne liste déjà que « Aucun » hors Krea 2 / H3 ;
  `updateModelLabel` masque en plus le contrôle « Style (LoRA) » pour tout id `qwen21_*` et le rétablit sur Krea 2.
  Le style texte (`currentStyleText()`) reste : il est ajouté en fin de prompt à la soumission, pour tout moteur.
- **Enrichissement** : chemin générique (`enrichBrief` → `ENRICH_SYSTEM`), jamais `KREA2_ENRICH_SYSTEM` (réservé à
  `KREA2_WORKFLOWS`). C'est ce que fait déjà Qwen-Edit 2509 dans ce pipeline ; `QWEN_EDIT_ENRICH_SYSTEM` est propre
  aux keyframes. Aucune nouvelle consigne. Le négatif enrichi est encodé (§ 1) mais inutilisé à cfg 1.
- **Taille** : t2i = table `RATIOS` (~1 MP : 1280×720, 720×1280, 1024², 832×1040, tous dans la plage qualifiée).
  i2i = ~1 MP au **ratio de l'image d'entrée**, multiples de 32, même formule que la carte Canvas (2.1 fixe son
  latent de départ : un ratio faux recomposerait le cadre, § 3) — le contrôle Ratio ne joue donc pas en i2i, comme
  avec 2509 (dont le latent vient de l'image).
- **Variantes / marchés** : t2i, `batch_size` = « Variantes » comme Krea 2. i2i, `batch` reste à 1 : 2509 ignore
  « Variantes » (pas de `{{BATCH}}` dans son gabarit) et un lot avec latents de référence n'a pas été qualifié. Les
  marchés cibles font un job par marché (seed + i), comme pour 2509.
- **Une image de référence** : `TextEncodeQwenImage21` en accepte 10 (§ 4) et `addQwen21Refs` sait les greffer, mais le
  contrôle `image` du pipeline n'en expose qu'une et aucun contrôle de références supplémentaires n'existe pour
  `image2image` (`#refExtrasWrap` est propre à `reference2video` / `storyboard_v2`, avec un texte et un plafond de 7 qui
  ne conviennent pas). **Piste, non construite** : références supplémentaires en i2i (jusqu'à 9, `<image2>`…).
- Rien ne part sans clic : changer de moteur, de pipeline, de langue ou ouvrir la liste ne soumet aucun job.

**Rendus réels de ce lot** (2 jobs GPU exactement, file ComfyUI vide avant chacun, graphes construits par le Studio puis
soumis à `:8188/prompt`, 33 s chacun) :

- t2i, `output/studio/qwen21_t2i_00001_.png` (1280×720, seed 42, « A red apple and a green pear on a rustic wooden table
  beside a window, soft morning light, realistic photograph, sharp focus, shallow depth of field. ») — regardé : pomme
  rouge et poire verte sur une table en bois patiné devant une fenêtre givrée, lumière douce du matin, profondeur de
  champ courte, texture du bois et de la peau des fruits nettes, aucun bruit ni artefact. Fidèle au prompt.
- i2i, `output/studio/qwen21_i2i_00002_.png` (1376×768, ratio de la source 1280×720 ; source : `output/studio/q21/t2i_vl8b_00001_.png`,
  « Change the orange fishing net held by the old fisherman in `<image1>` into a bright green net. Keep the fisherman,
  his navy beanie, his beard, the wooden pier, the blue boats, the mist and the cold dawn light exactly unchanged. ») —
  regardé : le filet est devenu vert vif, le pêcheur (visage, barbe grise, bonnet marine, caban), le ponton, les
  barques bleues, la brume et la lumière froide sont conservés ; seul le cadrage est très légèrement élargi par le
  passage de 1280×720 à 1376×768. Net, sans bruit.

## Canvas : carte Text2Image Qwen Image 2.1

**Lot Q21-CANVAS (2026-09-25).** La carte Canvas « Création d'image » (`simple/krea2`) gagne un champ **« Moteur »** :
Krea 2 Turbo (défaut) ou Qwen Image 2.1 (`qwen21_t2i`, ajouté au Studio par Q21-STUDIO). Krea 2 reste le chemin par
défaut et **n'a pas bougé** : un canvas sauvegardé avant le lot se recharge sur Krea 2 (`engine` absent → défaut du
constructeur) et se soumet octet pour octet comme avant.

| Élément | Valeur |
|---|---|
| Propriété / widget | `engine` ∈ `krea2` (défaut) \| `qwen21`, sérialisée ; widget « moteur » ajouté **après** le bouton Générer (comme « type de sujet » de la fiche personnage : un canvas déjà sauvegardé relit ses widgets par position) ; `syncWidgets` le restaure au rechargement et après Dupliquer |
| Graphe Qwen | `api/qwen21_t2i.json` rempli par `Engine.buildGraph` (comme le Studio) : `negative: ""`, `batch: 1`, seed aléatoire, `SaveImage` `canvas/qwen21_t2i` (le Krea du Canvas écrit `canvas/krea2`) |
| Taille | table `RATIOS` de `js/nodes-simple.js` (celle du Studio) : 16:9 → 1280×720, 9:16 → 720×1280, 1:1 → 1024×1024, 4:5 → 832×1040. **Pas** `computeMPResolution` : le champ « Mégapixels » ne joue qu'en Krea 2 |
| LoRA | aucune : `lora` et `mp` ne sont lus que par la branche Krea 2. Ils restent en propriété après une bascule (revenir sur Krea 2 retrouve la LoRA choisie) mais le graphe Qwen n'en contient jamais trace |
| Panneau Propriétés | Krea 2 : Moteur, Prompt, Ratio, Mégapixels, Style (LoRA). Qwen : Moteur, Prompt, Ratio (Mégapixels et Style (LoRA) masqués par `when`) ; aide sous « Moteur » |
| Pied de carte | `Krea 2 Turbo · W×H[ · LoRA: …]` / `Qwen Image 2.1 · W×H` ; statut « Génération Qwen Image 2.1 en cours… » (4 langues) |
| Largeur | inchangée, 320 : le texte dessiné le plus long (statut ES « Generación Qwen Image 2.1 en curso… ») fait 185 px pour 296 disponibles |
| Enrichissement | `ENHANCE.qwenImagePrompt` : le texte de `ENRICH_SYSTEM` du Studio (consigne générique) avec la clé de sortie `{"prompt"}` que lit la carte et **sans** négatif (la carte passe `""`, inutilisé à cfg 1). Jamais `KREA2_ENRICH_SYSTEM`, ni `stripPromptPadding` (réservé à Krea 2, comme au Studio) |

**Décisions et écarts par rapport au Studio.**

- **`ENRICH_SYSTEM` n'est pas exporté par `Engine`** (il vit dans `index.html`) : `js/engine.js` n'a pas été touché
  (`Object.keys(Engine).length` reste 76). Le texte est repris localement dans `canvas.html`, comme le sont déjà
  `ENHANCE.qwenInstruction` et `ENHANCE.videoPrompt`. Si `ENRICH_SYSTEM` change au Studio, la copie de `canvas.html` est
  à aligner (I13-B, source unique, ne l'a pas encore traité).
- **Pas de « Variantes » ni de seed sur la carte** (elle n'en avait pas en Krea 2 : une carte = une image, seed aléatoire) :
  `batch` reste à 1. Le graphe du Studio à 4 variantes ne diffère de celui de la carte que par `batch_size` (vérifié).
- **Pas de style Krea** sur la carte : le Studio ajoute `currentStyleText()` (style « Cinématique » par défaut) au prompt ;
  la carte, comme en Krea 2, envoie le prompt tel quel. Les graphes sont identiques à style « Aucun » au Studio.
- Le libellé « Mégapixels » (cartes Création d'image, Vidéo, Reference2Video) n'avait pas de clé `I18N` : il restait en
  français en EN/ES/DE ; la clé est ajoutée (« Megapixels » / « Megapíxeles » / « Megapixel »).

**Preuves** (bancs hors dépôt, `~/.cache/ai-content-studio/q21canvas/`, profil Chrome vierge, tout bouchonné) : 5 cartes
Krea 2 (ratios, mégapixels, LoRA) neuves **et** un graphe sauvegardé par HEAD rechargé avec le lot → 5 corps `/prompt`
identiques à HEAD (5 492 o) ; graphes Qwen 16:9 / 9:16 / 1:1 / 4:5 = graphes du Studio octet pour octet (préfixe repatché) ;
bascule Krea → Qwen → Krea par le panneau sans fuite de LoRA ; rechargement de page en Qwen (moteur, widget, pied, panneau,
Dupliquer) ; enrichissement (consigne générique en Qwen, Krea 2 inchangée) ; zéro job sur chaque valeur de chaque liste ;
un clic volontaire sur Générer (Qwen) = exactement 1 soumission.

**Rendu réel** (1 job GPU, file vide avant, graphe construit par la carte Canvas headless en moteur Qwen Image 2.1, 16:9,
seed 500000000000000, soumis à `:8188/prompt`, 30 s) : `output/canvas/qwen21_t2i_00001_.png` (1280×720) — « a lighthouse
keeper on a rocky coast at dusk, storm clouds, warm lantern light, photorealistic » — regardé : ciel d'orage dense, mer
agitée aux embruns nets, côte rocheuse, phare trapu dont la lanterne rayonne d'une lumière chaude, rendu photographique net
et sans bruit. Réserves : le gardien est une petite silhouette sur la coursive, peu lisible, avec un objet indistinct à ses
pieds, et la lueur de la lanterne se superpose à sa tête au lieu de se trouver dans la lanterne ; l'architecture du phare
est un peu fantaisiste. Pas d'artefact de bruit ni de tuile.

## Problèmes relevés lors de l'inspection

1. **`pe_t2i` / `pe_i2i` chargés comme encodeur = bruit pur, job `success`** (§2). Piège n°14
   typique ; la roadmap se trompait de fichiers.
2. **Sans bloc d'ancrage, la planche perso fuit en plusieurs exemplaires** (§9 : 4 copies).
3. **Duplication résiduelle du personnage** en dual 2.1 (1/6) et fréquente en 2509 (3/6) sur une
   planche à 4 vues en pied.
4. **Deux sujets + décor : aucun moteur fiable** (2.1 1/3, 2509 0/3 — dont une planche recopiée
   et un décor perdu côté 2509).
5. **2509 fait des fautes de texte** (« GOS TEMPES », « / ACCÉS ») et laisse un liseré clair en
   bordure ; 2.1 écrit juste.
6. `tools/object_info.json` est ignoré par git : le rafraîchir ne laisse aucune trace versionnée.
