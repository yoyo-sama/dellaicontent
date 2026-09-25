# Galerie — Chantier 1.4.0

## Pourquoi

La galerie ne montre que les 200 dernières entrées mémorisées dans le navigateur (localStorage `galleryAssets`, coupé par `slice(0,200)` dans `persistAsset` ; prompts dans `assetPrompts`). Or `~/comfyui-spark/basedir/output` contient environ 1 766 images et vidéos (1 396 PNG d'environ 1,5 Mo, 370 mp4 d'environ 1 Mo). Chaque vignette charge l'image d'origine. Les douleurs : retrouver une image précise (mot du prompt, pipeline, modèle), parcourir par période ou par session, historique perdu.

## Décisions

- **Voie A puis B.** Pas de SmartGallery ni de galerie tierce (option refusée).
- **A = front seul** (`index.html`) : un composant à deux sources de données derrière une interface unique, grille dense avec curseur de taille, chargement par paquets de 60, recherche dans les prompts connus, filtres pipeline et favoris, favoris locaux, sélection multiple. On conserve tout : « → Utiliser en entrée », glisser-déposer, « ➕ Séquence », lightbox, 🗑 avec « Annuler », onglets Images/Vidéos et compteurs, groupes par dossier. Les nouvelles entrées sont horodatées (`ts`) sans casser l'ancien format.
- **B = service Docker** `gallery`. Python stdlib + SQLite/FTS5 + Pillow + ffmpeg, non root, sur `127.0.0.1:8094`, joignable seulement par nginx `/gallery/`. `output/` est monté en rw ; un volume dédié garde l'index et les miniatures. Il indexe tout l'output (scan puis rescan incrémental), avec prompt, modèle, LoRA, seed, taille, pipeline et date. Tags et favoris vivent en SQLite, jamais dans les fichiers. Supprimer = déplacer vers `output/.trash/` (récupérable, purge manuelle), avec restauration. Les collections sont des tags. Le service ne soumet JAMAIS de job ComfyUI. Si le service est injoignable, le front retombe sur la source navigateur.

## Hors périmètre

Galerie du Canvas branchée sur le service, notes/commentaires/rôles, exposition client, remix, OmniQuery, transcodage, gestion de dossiers (seul le renommage dans le même dossier est prévu), virtual scrolling complet, SmartGallery.

## Lots

- **L0** : ce document
- **A** : front, source navigateur
- **B1** : service, Docker + lecture
- **B2** : écriture + sécurité
- **B3a** : source service, filtres, dates
- **B3b** : lightbox métadonnées, tags, sélection, corbeille
- **D** : docs finales, VERSION 1.4.0

A est en parallèle de B1 puis B2 ; le reste est séquentiel.

## Contrat

> Source unique. Le lot L0 le copie **tel quel** dans `docs/GALERIE.md § Contrat`. B1, B2, B3a et B3b s'y conforment. A implémente le §2 (source navigateur).

### C1. Objet « asset » commun (JSON côté service, objet JS côté navigateur)

```jsonc
{
  "key": "studio/story/key_01_00062_.png", // chemin relatif POSIX sous output/, JAMAIS de "/" initial ; racine : "ai_studio_x.png"
                                           // corbeille : ".trash/<ms>-<hex6>/<clé d'origine>" ; image cloud de session : "cloud:<nom>"
  "filename": "key_01_00062_.png",
  "subfolder": "studio/story",             // "" à la racine
  "type": "image",                         // "image" | "video"
  "url": "/comfy/view?filename=key_01_00062_.png&subfolder=studio%2Fstory&type=output&v=1758791234567",
                                           // pleine résolution : lightbox, « Utiliser en entrée », glisser-déposer.
                                           // Navigateur : URL /view historique sans &v ; cloud : blob:
  "thumb": "/gallery/thumb?key=studio%2Fstory%2Fkey_01_00062_.png&v=1758791234567",
                                           // navigateur : = url pour une image, null pour une vidéo
  "ts": 1758791234567,                     // ms epoch ; service = mtime ; navigateur = horodatage à l'ajout, null si entrée d'avant 1.4.0
  "prompt": "…",                           // /assets : 400 caractères max ; /asset : complet ; null si inconnu
  "pipeline": "storyboard_v2",             // clé de PIPELINE_LABELS, ou "canvas", ou null (= « Autre »)
  "model": "qwen_image_edit_2509_fp8_e4m3fn", // nom de fichier sans extension ; null si inconnu
  "loras": ["Qwen/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16"], // sans extension
  "seed": 653521632,                       // entier littéral, sinon null
  "w": 1280, "h": 720,                     // pixels réels du fichier (null côté navigateur)
  "duration": null,                        // s (vidéo), sinon null
  "size": 1534221,                         // octets (null côté navigateur)
  "fav": false,
  "tags": [],                              // noms ; toujours [] côté navigateur
  "label": null,                           // navigateur seulement : libellé du job ; service : null
  "trash": null                            // service, périmètre "trash" : {"origKey": "...", "at": ms}
}
```

Clés du navigateur. Les clés historiques en localStorage (`galleryAssets`, `deletedAssets`, `assetPrompts`) **gardent** leur format `${subfolder}/${filename}` (donc `/x.png` à la racine) : pas de migration. La source navigateur expose `key = subfolder ? subfolder + "/" + filename : filename`. Les nouvelles clés localStorage (favoris) prennent le format du contrat.

### C2. Interface JS de source (index.html)

```js
// Une source = un objet littéral. Deux implémentations : browserSource (lot A), serviceSource (lot B3a).
// Variable courante : gallerySource ; rechargement : galleryReload().
const source = {
  id: "browser" | "service",
  caps: { scope, models, tags, dates, rename, trash },   // booléens ; l'UI n'affiche que ce que la source sait faire
  // f = { type: "image"|"video", q: "", pipeline: "" | id | "none", fav: false,
  //       model: "", tag: "", from: null|ms, to: null|ms, sort: "new"|"old", scope: "app"|"all"|"trash" }
  // Champs non gérés par la source (d'après caps) : ignorés. cursor null = 1re page. Page = 60.
  list(f, cursor),       // → Promise<{ items: Asset[], next: string|null, counts: { image: n, video: n } }>
                         //   counts = nombre d'éléments qui passent TOUS les filtres sauf `type`
  setFav(keys, on),      // → Promise<void>
  remove(assets),        // → Promise<undo>, undo = () => Promise<void> (passé à undoToast)
  // service seulement :
  detail(key),           // → Promise<Asset> (prompt complet ; indexe à la demande un fichier récent)
  dates(unit, f),        // → Promise<{ start, end, count }[]>, unit = "day"|"week"|"month"
  facets(f),             // → Promise<{ pipelines, models, tags }>
  tag(keys, add, remove),// → Promise<void>
  rename(key, name),     // → Promise<Asset>
  restore(trashKeys)     // → Promise<void>
};
```

- `browserSource.caps` = tout à `false`. `serviceSource.caps` = tout à `true`.
- **Les éléments de session** (`cloud:*`) sont toujours affichés en tête, quelle que soit la source.
- **Un asset reçu en direct** (WebSocket ou historique) est toujours persisté dans la source navigateur (`persistAsset`, avec `ts`), même quand la source active est le service, pour que le repli reste utile.

### C3. API HTTP du service `gallery`

- nginx `location ^~ /gallery/ { proxy_pass http://127.0.0.1:8094/; proxy_set_header Host $http_host; proxy_set_header X-Real-IP $remote_addr; client_max_body_size 1m; proxy_read_timeout 60s; }`. **Il faut `$http_host` et non `$host`** : `$http_host` garde le port, ce qu'exige la comparaison avec Origin.
- Toutes les réponses JSON portent `Cache-Control: no-store`. Erreur = `{"error": "<code>", "detail": "<texte FR>"}`.
- Codes d'erreur :

| HTTP | `error` | Cas |
|---|---|---|
| 400 | `bad_request` | paramètre, clé, nom ou curseur invalide |
| 403 | `cross_origin` | contrôle de même origine échoué |
| 404 | `not_found` | clé ou fichier inconnu, route inconnue |
| 405 | `method` | méthode non autorisée sur la route |
| 409 | `exists` ou `locked` | destination déjà prise, ou dossier verrouillé |
| 413 | `too_large` | plus de 100 clés, ou corps de plus de 64 Ko |
| 415 | `json_required` | POST sans `Content-Type: application/json` |
| 500 | `internal` | erreur interne |

**Lecture (lot B1)**

| Route | Paramètres | Réponse |
|---|---|---|
| `GET /health` | aucun | `{"ok":true,"root":"/output","indexed":n,"app":n,"trashed":n,"scanning":bool,"lastScanMs":ms\|null,"scanSeconds":x,"warning":null\|"texte","schema":1}`. L'UI lit `ok`, `indexed`, `scanning` et `warning` ; les autres champs servent au diagnostic par curl. |
| `GET /assets` | `type=image\|video` (défaut image), `q`, `pipeline=<id>\|none`, `model`, `tag`, `fav=1`, `from`/`to` (ms epoch, from inclus, to exclu), `scope=app\|all\|trash` (défaut app), `sort=new\|old` (défaut new), `limit` 1-200 (défaut 60), `cursor` | `{"items":[Asset…],"next":"<curseur>"\|null,"counts":{"image":n,"video":n}}` |
| `GET /asset?key=` | clé (y compris `.trash/…` si à la corbeille) | Asset avec `prompt` complet. Clé valide et fichier présent mais pas encore indexé : il est indexé tout de suite. Sinon 404. |
| `GET /thumb?key=&v=` | clé, version | `image/webp`, côté long 320 px au plus, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /dates` | mêmes filtres que /assets (sans cursor, limit, sort) + `unit=day\|week\|month` + `tzOffset` (minutes, = `new Date().getTimezoneOffset()`) | `{"unit":"day","periods":[{"start":ms,"end":ms,"count":n}…]}`, du plus récent au plus ancien. Semaine = du lundi au lundi. |
| `GET /facets` | `scope` | `{"pipelines":[{"id":"text2image"\|null,"count":n}],"models":[{"name":"…","count":n}],"tags":[{"name":"…","count":n}]}`. Les tags à 0 sont inclus ; la corbeille est exclue sauf si `scope=trash`. |

- **Curseur** : `base64url(JSON [sort, mtime, key])`, opaque pour le client. Pagination par clé (`mtime DESC, key DESC` pour `new`, ordre inverse pour `old`). Un curseur d'un autre `sort` est refusé en 400.
- **`q`** : `re.findall(r"\w+", q)[:8]`. Chaque mot devient `"mot"*` (guillemets doublés), reliés par `AND`, dans `MATCH` sur `assets_fts` (prompt, texts, key, model). Aucun mot : filtre ignoré.

**Écriture (lot B2).** Toutes les routes sont en POST, corps JSON de 64 Ko au plus, même origine obligatoire (§C6).

| Route | Corps | Réponse |
|---|---|---|
| `/fav` | `{"keys":[≤100],"fav":bool}` | `{"ok":true,"changed":n}` |
| `/tags` | `{"name":"…"}` (1-40 caractères après trim, sans caractère de contrôle, unique sans casse) | `{"ok":true,"tag":{"name","count"}}`, idempotent |
| `/tag` | `{"keys":[≤100],"add":[noms],"remove":[noms]}` | `{"ok":true,"assets":[{"key","tags":[…]}]}`. Un tag ajouté qui n'existe pas est créé. |
| `/rename` | `{"key":"…","name":"nouveau.png"}` | `{"ok":true,"asset":Asset}`. Même dossier, même extension (sans casse), 150 caractères au plus, ni `/`, ni `\`, ni NUL, ni caractère de contrôle, pas de `.` initial. 409 `exists` si la destination existe, 409 `locked` si la clé correspond à `^studio/(story\|relay)/` (fichiers référencés par les sessions storyboard). |
| `/trash` | `{"keys":[≤100]}` | `{"ok":true,"trashed":[{"key":"<origine>","trashKey":".trash/<ms>-<hex6>/<origine>"}]}`. Toutes les clés sont validées avant tout déplacement. Si un déplacement échoue, réponse 500 avec la liste de ce qui est déjà déplacé. |
| `/restore` | `{"keys":[trashKeys ≤100]}` | `{"ok":true,"restored":[{"trashKey","key"}]}`. Si l'origine est prise, le fichier revient sous `<stem>_restored<ext>`, puis `_restored2`… |

Il n'existe **aucune** route de suppression définitive. La purge de la corbeille est manuelle : `rm -r output/.trash`.

### C4. Schéma SQLite (`/data/gallery.db`, créé en entier par B1)

```sql
PRAGMA journal_mode = WAL;   -- à l'ouverture
PRAGMA foreign_keys = ON;    -- à chaque connexion
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS assets (
  id         INTEGER PRIMARY KEY,
  key        TEXT    NOT NULL UNIQUE,        -- chemin relatif POSIX ; à la corbeille : ".trash/<id>/<orig_key>"
  type       TEXT    NOT NULL CHECK (type IN ('image','video')),
  mtime      INTEGER NOT NULL,               -- ms epoch = date de l'asset
  mtime_ns   INTEGER NOT NULL,               -- détection de changement au rescan
  size       INTEGER NOT NULL,
  w INTEGER, h INTEGER, duration REAL,
  prompt     TEXT,                           -- prompt positif retenu (complet)
  texts      TEXT,                           -- repli de recherche : tous les textes ≥ 20 car. du graphe, joints par '\n'
  prefix     TEXT,                           -- key sans compteur ni extension ("studio/story/key_01")
  pipeline   TEXT,                           -- table C5 ; NULL = « Autre »
  model      TEXT,
  loras      TEXT    NOT NULL DEFAULT '[]',  -- JSON
  seed       INTEGER,
  app        INTEGER NOT NULL DEFAULT 0,     -- 1 = périmètre « app »
  meta_ok    INTEGER NOT NULL DEFAULT 1,     -- 0 = extraction en échec, réessayée seulement si mtime_ns/size changent
  fav        INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,                        -- ms ; NULL = hors corbeille
  orig_key   TEXT                            -- clé d'origine si à la corbeille
);
CREATE INDEX IF NOT EXISTS assets_list  ON assets (trashed_at, type, mtime DESC, key DESC);
CREATE INDEX IF NOT EXISTS assets_pipe  ON assets (pipeline);
CREATE INDEX IF NOT EXISTS assets_model ON assets (model);
CREATE INDEX IF NOT EXISTS assets_fav   ON assets (fav) WHERE fav = 1;

CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS asset_tags_tag ON asset_tags (tag_id);

-- rowid = assets.id ; tenue à jour dans la MÊME transaction que assets (insert, update, delete, rename, trash)
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
  prompt, texts, key, model, tokenize = 'unicode61 remove_diacritics 2'
);
```

Tags et favoris sont rattachés à `assets.id`. Renommer ou envoyer à la corbeille ne modifie donc **qu'une ligne** (`key`, et la colonne `key` de `assets_fts`), dans la même transaction que le déplacement du fichier. Les PNG ne sont jamais réécrits. Tags et favoris ne vont jamais dans les fichiers.

### C5. Règles d'indexation

- **Fichiers indexés** : `.png .jpg .jpeg .webp` → `image` ; `.mp4 .webm .mov` → `video`. Tout le reste est ignoré (mp3, fichiers témoins).
- **Parcours** : `os.scandir` récursif, `follow_symlinks=False`. On **saute** tout lien symbolique et tout nom qui commence par « . » (d'où `.trash`). On saute aussi tout fichier dont `mtime` a moins de 5 s : il est peut-être en cours d'écriture, le prochain passage le prendra.
- **Passages** : un scan initial au démarrage (dans un thread), puis toutes les `SCAN_INTERVAL` s (défaut 60).
- **Mise à jour incrémentale** : un fichier nouveau, ou dont `(mtime_ns, size)` a changé, est extrait hors verrou puis upserté sous verrou, après un nouveau `stat`.
- **Fichier disparu** : sa ligne est supprimée sous verrou, après une nouvelle vérification `os.path.lexists`. **Garde anti-vidage** : si la racine est absente, ou si le parcours ne trouve 0 fichier alors que la base a plus de 0 ligne hors corbeille, **aucune suppression** et `health.warning` est renseigné.
- **Lignes à la corbeille** : supprimées seulement si leur fichier `.trash/…` a disparu (purge manuelle).
- **Date** = `mtime`.
- **Taille** : IHDR (PNG) ou Pillow pour les images, ffprobe pour les vidéos.
- **Métadonnées** :
  - graphe = chunk PNG `tEXt` `prompt`, lu avant IDAT ; pour une vidéo, `ffprobe -v error -print_format json -show_format -show_streams` puis `format.tags.prompt`.
  - Nœuds de départ = nœuds dont `inputs.filename_prefix` == `prefix` du fichier. S'il n'y en a aucun, tous les nœuds qui ont un `filename_prefix`.
  - On remonte les liens vers l'amont, comme `promptForNode` d'index.html.
  - **prompt** = la plus longue chaîne parmi `CLIPTextEncode.text`, `PrimitiveStringMultiline.value`, `PrimitiveString.value`, `TextGenerateLTX2Prompt.prompt`, `TextEncodeQwenImage21.prompt`, `TextEncodeQwenImageEditPlus.prompt`, en suivant un saut de lien vers `value`/`text`/`prompt`. **Jamais** `negative_prompt`.
  - **model** = premier `UNETLoader.unet_name`, sinon `CheckpointLoaderSimple.ckpt_name`, trouvé en amont.
  - **loras** = `lora_name` de `LoraLoader*` en amont. Limite connue : une LoRA court-circuitée par un switch est quand même listée.
  - **seed** = premier `seed` ou `noise_seed` entier littéral, ou atteint par un saut vers un `Primitive*`.
  - **texts** = toutes les valeurs chaîne de 20 caractères ou plus du graphe, sauf les clés `filename_prefix`, `attention`, `sigmas`, `image`, `video`, `audio`, `*_name`, et sauf les valeurs qui finissent par `.safetensors .gguf .pt .png .jpg .mp4 .webp`.
- **prefix** = `key` privée de `_\d{5}_?\.\w+$`, sinon de son extension.
- **Périmètre « app »** : `app = 1` si la clé correspond à `^(studio|canvas|campaign|storyboard|localized|video)/|^ai_studio_` **et** pas à `^studio/(lot1|lotA|q21|inspect)/|^studio/lot\d`. La seconde regex est une proposition du plan, à confirmer par l'utilisateur ; la retirer coûte une ligne.
- **Pipeline** (première correspondance) :

```
^studio/(story|relay)/                          → storyboard_v2
^(studio/)?campaign/                            → campaign_full
^studio/sequence_                               → sequence2video
^studio/minimax_h3_r2v_                         → reference2video
^studio/((ltx25|minimax_h3)_i2v|ltx25_flf2v)_   → image2video
^studio/(ltx25|minimax_h3)_t2v_                 → text2video
^studio/(edit|qwen21_i2i|market_[a-z]+)_        → image2image
^studio/(krea2|qwen21_t2i|flux2|ernie|zimage)_  → text2image
^canvas/                                        → canvas
sinon                                           → null
```

### C6. Sécurité (frontière)

- **Clé** : chaîne de 1 à 1 024 caractères, sans NUL ni `\`, sans `/` initial. Aucun segment vide, `.` ou `..`. Aucun segment qui commence par « . », sauf le premier segment `.trash` pour une clé de corbeille (routes `/restore`, `/thumb`, `/asset`, seulement si la ligne est à la corbeille). Extension autorisée.
- **Contrôle anti-lien** : `os.path.realpath(join(ROOT, key)) == os.path.normpath(join(realpath(ROOT), key))`. L'égalité garantit qu'aucun lien symbolique n'apparaît sur le chemin.
- **Existence** : les routes qui agissent sur un asset exigent aussi une **ligne en base**.
- **Écriture** : POST seulement, sinon 405.
  - `Content-Type` qui commence par `application/json`, sinon 415.
  - `Sec-Fetch-Site`, s'il est présent, doit valoir `same-origin`, sinon 403.
  - `Origin`, s'il est présent, doit avoir un `netloc` égal à l'en-tête `Host`. Sinon il faut un `Referer` présent dont le `netloc` est égal à `Host`. Sinon 403.
- **Plafonds** : 100 clés par requête, 64 Ko de corps.
- **Déplacements** (renommage, corbeille, restauration) : `os.makedirs(dest_dir)`, puis `os.link(src, dst)` (qui échoue si `dst` existe, donc jamais d'écrasement), puis `os.unlink(src)`. Tout se fait sous le verrou global, dans la transaction SQLite, avec rollback si `link` échoue.
- **Aucune** autre suppression de fichier. Aucun client réseau dans le service : il ne contacte **jamais** ComfyUI.
- **Conteneur non root** : `user: ${APP_UID:-1000}:${APP_GID:-1000}`.

