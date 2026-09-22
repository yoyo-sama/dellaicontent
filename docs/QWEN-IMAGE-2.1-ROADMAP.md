# Roadmap — Qwen Image 2.1 en coexistence avec Qwen-Edit 2509

Document de cadrage (`/architect`, 2026-09-22). **Rien n'est implémenté** : ceci fixe le
périmètre et les tâches pour une planification (`tour-de-controle`) ultérieure, pas encore
lancée.

## Motivation

Qwen Image 2.1 est déjà présent sur le disque ComfyUI (`diffusion_models/qwen_image_2.1_int8_convrot.safetensors`
+ deux text-encoders dédiés `qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors` /
`..._pe_t2i...`) et a été testé manuellement en dehors de l'app (sorties `Qwen_image_2.1_*.png`
dans `comfyui-spark/basedir/output/`). Constats motivant le remplacement, à confirmer par
qualification réelle avant intégration :

- Qualité générale supérieure à Qwen-Edit 2509 (constatée en test manuel)
- Meilleur rendu de texte incrusté dans l'image
- Meilleure fidélité quand plusieurs images de référence sont fournies
- **Jusqu'à 10 images de référence en entrée en mode i2i classique**, contre 2-3 aujourd'hui
  (plafond imposé par `TextEncodeQwenImageEditPlus`, 3 entrées image max — voir `AGENTS.md`,
  piège « plusieurs sujets par plan »)

## État actuel (2509)

Deux usages dans le repo, chacun avec son gabarit ComfyUI :

- `workflows/api/qwen_edit_i2i.json` — édition mono-référence, carte « Édition d'image »
  (Canvas, `js/nodes-simple.js` `QwenEditNode`)
- `workflows/api/qwen_edit_dual.json` — édition à 2 références (charsheet + locsheet),
  ancrage des keyframes de `storyboard_v2`/`reference2video` (`js/nodes-advanced.js`,
  `index.html` — mécanisme documenté dans `AGENTS.md`/`docs/LESSONS.md` pièges n°10, n°17,
  n°28, n°32)

## Cible : coexistence, pas de remplacement

Même pattern que le choix de moteur vidéo (LTX 2.5 / Minimax H3) : chaque moteur a sa propre
entrée `workflows/manifest.json` + son propre `api/<moteur>.json`, sélecteur côté UI. 2509
reste disponible tant que 2.1 n'a pas fait ses preuves en usage réel — pas de retrait.

## Périmètre validé (asymétrique selon l'usage)

- **Édition mono-référence (Canvas, `simple/qwen_edit`)** : devient un i2i classique qui
  **exploite toute la capacité du modèle** — jusqu'à 10 images de référence en entrée, pas
  seulement 1. Nouveau plafond propre à ce moteur, pas hérité d'un autre pipeline.
- **Ancrage double storyboard (`storyboard_v2`/`reference2video`)** : le plafond de références
  reste **aligné sur celui déjà en place pour Minimax H3 r2v dans ce même pipeline**, soit
  **7 images de référence supplémentaires** (`index.html:1973`, `collectRefExtras`/
  `addMinimaxRefs`) — pas d'exploitation du plafond de 10 de Qwen 2.1 ici, pour garder un
  comportement cohérent entre les moteurs proposés sur ce pipeline (l'utilisateur ne doit pas
  voir un plafond différent selon le moteur choisi au même endroit).

## Risque technique majeur — non résolu, à qualifier

Le mécanisme d'ancrage double actuel (`TextEncodeQwenImageEditPlus` à 2 images, image1 = latent
de départ + conditioning, image2 = conditioning seul — piège n°10) est spécifique à
l'architecture Qwen-Edit 2509. **On ne sait pas si Qwen Image 2.1 fait l'équivalent nativement
en une passe.** Aucune règle fixée à l'avance :

- Si le dual/multi-ref natif fonctionne en une passe → on l'utilise, plafonné à 7 comme ci-dessus.
- Si non → repli possible sur 2 passes séquentielles (éditer avec la charsheet, puis ré-éditer
  le résultat avec la locsheet, ou l'inverse) — **à valider par rendu réel**, pas supposé.
- Si ni l'un ni l'autre ne tient la qualité de fidélité déjà qualifiée pour 2509 (voir
  `docs/NOUVEAUX-MODELES-LOT1.md` et les pièges n°10/17/28/32) → 2.1 reste limité à l'usage
  mono-référence (Canvas), 2509 reste seul sur l'ancrage storyboard. Décision à prendre sur
  preuve (frames extraites, comparaison directe), selon la méthode déjà en usage dans ce projet
  (jamais conclure d'un statut de job « success », toujours inspecter le rendu — piège n°14).

## Tâches (roadmap, à planifier — non exécutées)

1. **Qualification isolée** (avant tout code d'intégration), rendus réels + inspection frame
   par frame, méthode `docs/TESTING.md` :
   - t2i baseline Qwen Image 2.1
   - i2i mono-référence (jusqu'à plusieurs images, à tester progressivement 1 → 10)
   - i2i dual-référence charsheet+locsheet (reprendre les mêmes images de référence que
     `docs/NOUVEAUX-MODELES-LOT1.md` pour comparaison directe avec 2509/H3 r2v)
   - Comparaison qualité texte incrusté vs 2509
   - Décision documentée sur le risque ci-dessus (natif 1 passe / 2 passes / hors scope storyboard)
2. **Nouveaux gabarits API** : `workflows/api/qwen21_i2i.json` (+ variante dual/multi si
   qualifiée), même structure que les `.json` API existants (`tools/onboard.py`/
   `tools/convert.py`)
3. **`workflows/manifest.json`** : nouvelles entrées moteur, pattern `ltx25_i2v`/
   `minimax_h3_i2v`
4. **UI** :
   - Carte « Édition d'image » (Canvas) : sélecteur de moteur 2509/2.1 + slots de référence
     étendus jusqu'à 10 pour 2.1
   - `storyboard_v2`/`reference2video` : sélecteur de moteur pour l'ancrage, plafond 7 references
     supplémentaires identique quel que soit le moteur choisi
5. **`scripts/models.txt`** : ajouter le diffusion model + les 2 text-encoders `pe_i2i`/`pe_t2i`
   (absents aujourd'hui — `install.sh` ne les récupère pas sur une install neuve)
6. **Documentation** : `docs/ARCHITECTURE.md`, `AGENTS.md` (pièges concernés si le plafond de
   2 sujets/plan évolue avec le dual-ref 2.1), `workflows/README.md`, `CHANGELOG`

## Prochaine étape

Cadrage `/architect` terminé et validé par l'utilisateur. Planification (`tour-de-controle`) et
intégration **volontairement non lancées** — à faire dans une session ultérieure, brief à
reprendre depuis ce document.
