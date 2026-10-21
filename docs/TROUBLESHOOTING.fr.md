# Dépannage — installation et déploiement (GB10)

Ce guide couvre l'installation et l'exécution de la stack, pas la qualité des rendus
(voir `docs/TESTING.md`) ni les pièges de pipeline (voir `docs/LESSONS.md`).

Toutes les commandes ci-dessous ont été exécutées telles quelles sur un GB10 en service.
Aucune n'installe ni ne supprime quoi que ce soit sans que ce soit dit explicitement.

## Symptômes fréquents et leur cause réelle

| Ce que vous voyez | Cause | Section |
|---|---|---|
| `Error: JSON.parse: unexpected character at line 1 column 1` | Le corps de la réponse n'est pas du JSON mais la page d'erreur **HTML** de nginx (502/504) : ComfyUI ou Ollama ne répond pas derrière le reverse-proxy | [1](#1-diagnostic-en-trois-commandes) |
| `Enhancement failed: NetworkError when attempting to fetch resource` | La requête vers `/ollama/api/chat` n'a pas abouti (connexion refusée ou coupée) | [1](#1-diagnostic-en-trois-commandes) |
| ComfyUI tourne mais ne voit aucun modèle | Les modèles ont été téléchargés dans un dossier que ce ComfyUI-là ne lit pas | [2](#2-comfyui-ne-voit-pas-les-modèles) |
| Un cadenas sur `comfyui/` dans le gestionnaire de fichiers | Dossier créé par dockerd en `root:root` (bind-mount dont la source n'existait pas) — tous les téléchargements de modèles échouent ensuite en « permission denied » | [2](#2-comfyui-ne-voit-pas-les-modèles) |
| Reference2video : la description vision des images de référence échoue en silence — la vidéo se rend quand même, le journal montre seulement `Description de « … » indisponible (ollama 413)` | nginx refuse le corps de la requête : avant la v1.4.4, `location ^~ /ollama/` n'avait pas de `client_max_body_size` (1 Mo par défaut) et une image base64 d'environ 750 Ko ou plus recevait un 413 | [3](#3-ollama) |
| `skipped (native Ollama installed but not started)` | Ollama est installé hors Docker et son service est arrêté | [3](#3-ollama) |
| `skipped (port 11434 busy)` / `port is already allocated` | Un autre processus tient le port | [3](#3-ollama) |
| Vous réinstallez sur un poste où une version précédente du script a déjà tourné | Migration de l'ancienne mise en page vers les stacks voisines | [4](#4-réinstaller-sur-un-poste-où-une-version-précédente-du-script-a-déjà-tourné) |
| `git add` ou une mise à jour depuis l'app échoue en « permission denied » sous `.git/objects` | Objets git créés en `root` par un ancien updater ou un conteneur | [8](#8-objets-git-appartenant-à-root) |
| La galerie affiche « Galerie complète indisponible — images de ce navigateur seulement », ou la corbeille/le renommage affiche « Le service de galerie n'a pas abouti : rien n'a été modifié. » | Le service `gallery` ne répond pas, ou ne peut pas écrire dans `output/` | [9](#9-service-galerie) |

**La langue du prompt n'est jamais en cause.** Un `JSON.parse` qui échoue « line 1 column 1 »
signifie que le premier caractère reçu n'est pas du JSON (typiquement le `<` de `<html>`) :
l'erreur précède toute lecture du texte saisi.

## 1. Diagnostic en trois commandes

L'application n'expose qu'un port (8090) et atteint ComfyUI et Ollama par le reverse-proxy
nginx. C'est donc à travers ce proxy qu'il faut tester, exactement comme le navigateur :

```bash
for u in /comfy/system_stats /ollama/api/version /update/status; do printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8090$u"; done
```

Trois `200` = les services répondent. Un `502` ou `504` sur `/comfy/` ou `/ollama/` est
exactement ce qui produit l'erreur `JSON.parse` côté navigateur. Un `504` peut aussi signaler qu'un appel a dépassé le timeout du proxy (`/ollama/` 300 s, `/update/` 600 s ; voir `docs/ARCHITECTURE.md` § Backend `updater`). Ensuite :

```bash
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE 'comfy|ollama|content-studio'
```

Un conteneur `Exited` explique tout : `install.sh` le redémarre (il ne crée jamais de
doublon), il suffit de le relancer. Enfin, les logs du service muet :

```bash
docker logs --tail 50 comfyui-nvidia
```

Le tout premier démarrage de ComfyUI installe `comfy_kitchen` et prend plusieurs minutes —
un `502` pendant ce temps est normal, `install.sh` attend jusqu'à 15 minutes.

## 2. ComfyUI ne voit pas les modèles

Le piège classique : les modèles sont sur le disque, mais pas là où ce ComfyUI-là les lit.
Les montages du conteneur font foi, pas le chemin qu'on croit avoir configuré :

```bash
docker inspect comfyui-nvidia --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Attendu : `<home>/comfyui-spark/basedir -> /basedir`. Puis la vérité côté ComfyUI — ce qu'il
propose réellement dans ses menus :

```bash
curl -s http://localhost:8188/object_info/UNETLoader | grep -o 'minimax_h3[^"]*' | head -3
```

Une réponse vide alors que les fichiers existent signifie presque toujours que
`BASE_DIRECTORY: /basedir` manque dans la stack ComfyUI : sans cette variable, l'image
`mmartial` ignore `/basedir` et cherche ses modèles dans `/comfy/mnt/ComfyUI/models`.
La stack de référence est `docker/stacks/comfyui.yml` — comparez-la à
`~/comfyui-spark/compose.yaml`.

### Contrôler l'intégrité des modèles téléchargés

```bash
M=~/comfyui-spark/basedir/models; while IFS='|' read -r d f s u; do case "$d" in ''|\#*) continue;; esac; case "$s" in ''|*[!0-9]*) continue;; esac; a=$(stat -c%s "$M/$d/$f" 2>/dev/null || echo 0); t=$((s/100)); [ "$t" -lt 1 ] && t=1; if [ "$a" -eq 0 ]; then r=ABSENT; elif [ "$a" -ge $((s-t)) ] && [ "$a" -le $((s+t)) ]; then r=OK; else r=INCOMPLET; fi; printf '%-10s %s\n' "$r" "$d/$f"; done < ~/ai-content-studio/scripts/models.txt
```

`ABSENT` et `INCOMPLET` se corrigent en relançant `install.sh` (`curl -C -` reprend un
téléchargement interrompu).

**Limite assumée de ce contrôle** : la tolérance est de 1 %, la même que celle d'`install.sh`,
et elle est nécessaire — sur la machine de référence, deux fichiers en service depuis des
semaines diffèrent de quelques kilo-octets des tailles de `scripts/models.txt` (révisions
Hugging Face republiées). Un fichier tronqué à moins de 1 % passerait donc pour bon. La seule
preuve qui vaut reste un rendu réel inspecté (`docs/TESTING.md`) — un job ComfyUI « success »
ne prouve rien.

## 3. Ollama

`install.sh` détecte Ollama **par son service** (`:11434`), pas par un conteneur : une
installation native (systemd) est réutilisée telle quelle, et le modèle `gemma4:e4b` est tiré
par l'API HTTP. Vérification et tirage manuel, valables dans les deux cas :

```bash
curl -s http://localhost:11434/api/tags | grep -o '"gemma4:e4b"' || curl -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}'
```

Si le récapitulatif affiche `skipped (native Ollama installed but not started)`, c'est qu'un
Ollama natif existe mais ne répond pas et que le script n'a pas pu le démarrer (pas de sudo
sans mot de passe). Aucun conteneur n'est créé dans ce cas — délibérément, pour ne pas faire
cohabiter deux Ollama sur le port 11434 :

```bash
sudo systemctl enable --now ollama
```

Puis relancez `install.sh`. Si le port est tenu par autre chose, `sudo ss -ltnp 'sport = :11434'`
dit par qui.

### La description vision des références échoue en `ollama 413`

Le pipeline reference2video fait décrire chaque image de référence par gemma (vision) : l'image
voyage en base64 dans le corps de `/ollama/api/chat`. La limite de corps par défaut de nginx est
de 1 Mo : dès ~750 Ko d'image, la requête reçoit un **413** et la description est sautée (la vidéo
se rend quand même, la référence pèse simplement moins). Depuis la v1.4.4, `nginx.conf` pose
`client_max_body_size 100m;` dans `location ^~ /ollama/`. Le fichier est monté en fichier unique :
après la mise à jour, **recréez** le conteneur nginx, sinon le nginx en marche garde l'ancienne
configuration :

```bash
cd ~/ai-content-studio
docker compose up -d --force-recreate -t 0 ai-content-studio
```

## 4. Réinstaller sur un poste où une version précédente du script a déjà tourné

C'est le cas le plus fréquent : une première installation a été tentée avant la v1.0.7, quand
`docker-compose.yml` déclarait aussi `comfyui` et `ollama` avec leurs volumes sous
`~/ai-content-studio/comfyui/`. Ce ComfyUI-là n'avait pas `BASE_DIRECTORY` et ne lisait donc
pas le dossier où le script téléchargeait les modèles.

**Ce que le script fait tout seul** : il reconnaît les conteneurs créés par le
`docker-compose.yml` du dépôt (label compose), les supprime, recrée ComfyUI dans
`~/comfyui-spark` et Ollama dans `~/ollama`, et **recopie** les poids du volume `ollama-data`
vers `~/ollama/data` pour éviter de retélécharger le modèle.

Il déplace aussi les modèles ComfyUI de l'ancien dossier vers le nouveau, avant tout
téléchargement (voir l'étape 3). Il ne supprime rien d'autre que les deux conteneurs hérités :
l'ancien dossier, une fois vidé de ses fichiers, reste sur le disque.

### Étape 1 — Récupérer la version courante du script

```bash
cd ~/ai-content-studio && git pull && cat VERSION
```

La version doit être **≥ 1.0.8**. En dessous, vous relanceriez la version qui a produit le
problème. Si `git pull` refuse à cause de modifications locales, `git stash` : il n'y a
normalement rien à conserver dans ce dépôt sur un poste de déploiement.

### Étape 2 — État des lieux

```bash
du -sh ~/ai-content-studio/comfyui/basedir/models 2>/dev/null; du -sh ~/comfyui-spark/basedir/models 2>/dev/null; docker run --rm -v ollama-data:/v alpine sh -c 'du -sh /v; ls /v/models/manifests/registry.ollama.ai/library' 2>/dev/null; df -h /home | tail -1
```

Quatre informations : ce que contient l'ancien dossier, ce que contient déjà le nouveau, si le
volume Ollama hérité contient bien `gemma4`, et l'espace libre. Il faut **~150 Go** pour la
totalité des modèles ComfyUI.

### Étape 3 — L'ancien dossier de modèles : rien à faire (sauf cadenas)

**Le script s'en charge.** À l'étape 5/7, avant tout téléchargement, il déplace le contenu de
`~/ai-content-studio/comfyui/basedir/models` vers le dossier réellement lu par le ComfyUI en
service. Le déplacement est fichier par fichier (un sous-dossier présent des deux côtés ne
bloque pas) et n'écrase jamais un fichier déjà à destination. Les modèles déplacés dont la
taille correspond sont ensuite reconnus et **non retéléchargés** :

```
3 file(s) found in the legacy model folder (/home/<vous>/ai-content-studio/comfyui/basedir/models).
Moving them to /home/<vous>/comfyui-spark/basedir/models — same filesystem, instant, and avoids downloading them again.
  moved: 3   left behind: 0
SKIP (already present, size matches): /home/<vous>/comfyui-spark/basedir/models/vae/qwen_image_vae.safetensors
```

**Le seul cas où vous devez intervenir** : `left behind` non nul. L'ancien dossier a été créé
par Docker en root (le cadenas), vous n'avez pas le droit d'y déplacer quoi que ce soit. Le
script affiche la commande exacte ; reprenez la propriété puis relancez-le, il finira le
déplacement :

```bash
sudo chown -R "$(id -u):$(id -g)" ~/ai-content-studio/comfyui
```

Une fois `left behind: 0`, l'ancien dossier ne contient plus que des répertoires vides :

```bash
rm -rf ~/ai-content-studio/comfyui
```

### Étape 4 — Lancer l'installation

```bash
cd ~/ai-content-studio && HF_TOKEN=<votre_jeton_hf> ./install.sh 2>&1 | tee ~/install-$(date +%F-%H%M).log
```

`HF_TOKEN` n'est pas facultatif en pratique : les 5 fichiers LTX 2.5 viennent d'un dépôt
Hugging Face *gated* et échouent proprement sans jeton (les 17 autres se téléchargent
normalement). Le `tee` garde une trace : la commande dure plusieurs heures, et l'essentiel des
erreurs éventuelles défile pendant les téléchargements.

Ordre des opérations, avec les durées à attendre :

| Étape du script | Ce qui se passe | Durée |
|---|---|---|
| 2/7 | Suppression des conteneurs hérités, création des deux stacks, dépôt des userscripts | < 1 min |
| 2/7 | Recopie des poids Ollama depuis le volume `ollama-data` | quelques minutes (9,6 Go) |
| 5/7 | Téléchargement des modèles ComfyUI manquants | plusieurs heures |
| 6/7 | Tirage de `gemma4:e4b` si absent | quelques minutes |
| 6/7 | Attente du premier démarrage de ComfyUI (installation de `comfy_kitchen`) | jusqu'à 15 min |

### Étape 5 — Ce que vous devez voir passer

Les lignes qui prouvent que la migration a bien eu lieu :

```
WARNING: ComfyUI inherited from the old layout — migrating to /home/<vous>/comfyui-spark.
Creating the ComfyUI stack in /home/<vous>/comfyui-spark.
Userscripts deployed before first start: 2 file(s)
WARNING: Ollama inherited from the old layout — migrating to /home/<vous>/ollama.
Copying weights from the 'ollama-data' volume into /home/<vous>/ollama/data…
Creating the Ollama stack in /home/<vous>/ollama.
Waiting for ComfyUI on :8188 (first start, userscripts installation)…
```

Si vous voyez à la place `reused (comfyui-nvidia)` sans ligne de migration, c'est que le
conteneur ne porte pas le label compose du dépôt : il a été créé à la main (`docker run`) ou
par une autre stack. Le script ne touche jamais à un conteneur qu'il ne possède pas — dans ce
cas, supprimez-le vous-même après avoir vérifié son origine avec l'inventaire de la
[section 5](#inventaire-dabord--qui-possède-quoi), puis relancez.

### Étape 6 — Relire le journal

```bash
grep -nE "WARNING|failed|skipped|ERROR" ~/install-*.log
```

Sur une installation saine, il ne reste que d'éventuels avertissements sur les fichiers LTX 2.5
si `HF_TOKEN` manquait.

### Étape 7 — Vérifier

Relancez le script : il est idempotent, et c'est le meilleur test.

```bash
cd ~/ai-content-studio && ./install.sh 2>&1 | tail -25
```

Attendu : `reused` sur les trois services, `already present (not re-downloaded) : 22`,
`Ollama model gemma4:e4b: present`, quatre `HTTP 200`. Puis le contrôle qui compte vraiment —
ComfyUI voit-il ses modèles :

```bash
docker inspect comfyui-nvidia --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' && curl -s http://localhost:8188/object_info/UNETLoader | grep -o 'minimax_h3[^"]*' | head -3
```

Enfin, dans l'application (`http://<ip>:8090`) : **✨ Enrichir le brief (LLM)** sur un champ de prompt,
puis une génération d'image simple (Krea 2) avant d'essayer la vidéo.

### Si le script s'interrompt en cours de route

Relancez-le, simplement. Il est idempotent à chaque étape : les téléchargements reprennent où
ils s'étaient arrêtés (`curl -C -`), les stacks déjà créées sont réutilisées, les conteneurs
arrêtés sont redémarrés au lieu d'être doublés. Trois cas particuliers :

- **Coupure pendant la recopie des poids Ollama** : `~/ollama/data` est incomplet, le modèle
  sera simplement retiré par l'API au prochain passage.
- **ComfyUI toujours muet après les 15 minutes d'attente** : `docker logs comfyui-nvidia`. Le
  premier démarrage compile/installe `comfy_kitchen`, une erreur y est visible en clair.
- **Disque plein en cours de téléchargement** : les fichiers partiels sont conservés ; faites
  de la place et relancez, la reprise évite de tout refaire.

## 5. Repartir de zéro

### Inventaire d'abord — qui possède quoi

```bash
for c in $(docker ps -a --format '{{.Names}}'); do printf '%-30s %-48s %s\n' "$c" "$(docker inspect -f '{{.Config.Image}}' "$c")" "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c")"; done
```

La troisième colonne tranche : les conteneurs pointant sur
`<home>/ai-content-studio/docker-compose.yml` viennent de l'installation à refaire. Une
colonne vide = conteneur créé hors compose (`docker run`), il n'appartient à personne d'autre
que vous. Un autre fichier = une autre stack, n'y touchez pas.

### Remise à zéro ciblée (recommandée)

Détruit l'installation, **garde les images Docker et les modèles déjà téléchargés**. Cette
commande ne supprime que les conteneurs créés par le `docker-compose.yml` de ce dépôt — donc
exactement ceux d'une installation ratée, y compris les `comfyui`/`ollama` de l'ancienne mise
en page — et ne peut pas toucher une stack voisine :

```bash
docker ps -a --format '{{.Names}}' | while read -r c; do [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c" 2>/dev/null)" = "$HOME/ai-content-studio/docker-compose.yml" ] && docker rm -f "$c"; done; sudo rm -rf ~/ai-content-studio/comfyui ~/ai-content-studio/.env
```

Si l'inventaire a montré un ComfyUI ou un Ollama **sans label** (créé hors compose, par
`docker run`), il ne sera pas supprimé par la commande ci-dessus : supprimez-le nommément,
après avoir vérifié qu'il vient bien de votre tentative d'installation.

Le volume `ollama-data` est conservé : `install.sh` en recopie les poids vers `~/ollama/data`,
ce qui évite 9,6 Go de retéléchargement. Le volume `ai-content-studio_gallery-data` l'est aussi (index de la galerie, tags et favoris).

### Remise à zéro totale

Tout part, y compris les images (~30 Go) et **les modèles (~150 Go, plusieurs heures de
téléchargement)** :

```bash
docker rm -f ai-content-studio-web ai-content-studio-updater ai-content-studio-gallery comfyui-nvidia ollama-api 2>/dev/null; docker volume rm ollama-data ai-content-studio_gallery-data 2>/dev/null; docker rmi mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest ollama/ollama:latest ai-content-studio-updater ai-content-studio-gallery 2>/dev/null; sudo rm -rf ~/comfyui-spark ~/ollama ~/ai-content-studio
```

Relisez l'inventaire avant de la lancer : `~/comfyui-spark` peut **préexister** à
l'installation de l'app (c'est le cas sur la machine de référence, où cette stack ComfyUI est
antérieure et gérée par son propre `compose.yaml`) — la détruire vous ferait retélécharger
150 Go pour rien. À réserver aux modèles corrompus ou à une image ComfyUI cassée. Dans le doute, gardez
`~/comfyui-spark/basedir/models` : les fichiers déjà présents ne sont pas retéléchargés.

### Réinstaller

```bash
git clone https://github.com/yoyo-sama/dellaicontent.git ~/ai-content-studio && cd ~/ai-content-studio && HF_TOKEN=<votre_jeton_hf> ./install.sh
```

### Ce qu'il ne faut pas supprimer

Docker, le driver NVIDIA et `nvidia-container-toolkit` ne sont jamais en cause dans un échec
d'installation de cette stack, et `install.sh` ne les installe pas — il vérifie leur présence
et affiche la marche à suivre si l'un manque. `docker system prune -a` récupérerait de la place
mais forcerait le re-pull de toutes les images : à réserver à un disque saturé.

## 6. Vérifier qu'une installation tient

Le meilleur test est de relancer le script : il est idempotent.

```bash
cd ~/ai-content-studio && ./install.sh 2>&1 | tail -25
```

Attendu : `reused` sur les trois services, `already present (not re-downloaded) : 22`,
`Ollama model gemma4:e4b: present`, et cinq `HTTP 200` en health-checks (`:8188`, `:11434`, `:8090`,
`/update/status`, `/gallery/health`). Ensuite seulement,
ouvrez `http://<ip>:8090`, testez **✨ Enrichir le brief (LLM)** sur un champ de prompt, puis une
génération d'image simple (Krea 2) avant d'essayer la vidéo.

## 7. Revenir en arrière après une mise à jour de ComfyUI

L'application peut mettre ComfyUI à jour elle-même (invite au chargement quand il est plus ancien
que `comfyui.min` dans `workflows/manifest.json`, voir le README). L'invite affiche la commande de
retour arrière ; le tag est `v` + l'ancienne version (visible dans l'en-tête de la console ComfyUI
ou via `GET /comfy/system_stats` avant la mise à jour) :

```bash
git -C ~/comfyui-spark/run/ComfyUI checkout v0.36.0 && docker restart comfyui-nvidia   # tag d'exemple
```

Si la mise à jour est passée mais que ComfyUI ne répond plus au bout de ~3 min, lire
`docker logs comfyui-nvidia --tail 50`. Si le ComfyUI-Manager lui-même a été mis à niveau au
passage, le redémarrage (`execv`) ne rejoue pas les userscripts du conteneur : `docker restart comfyui-nvidia`.

## 8. Objets git appartenant à root

Le conteneur `updater` tourne avec l'UID/GID du propriétaire du dépôt (`user: "${APP_UID:-1000}:${APP_GID:-1000}"`,
valeurs écrites dans `.env` par `install.sh`). Un ancien updater tournait en root et a laissé des
dossiers appartenant à root dans `.git/objects`, ce qui casse `git add` pour vous. `install.sh` le
détecte et affiche le correctif ; pour vérifier et réparer à la main :

```bash
find ~/ai-content-studio/.git ! -user "$(id -un)" -print -quit        # une sortie = mauvais propriétaire
sudo chown -R "$(id -un):$(id -gn)" ~/ai-content-studio/.git
cd ~/ai-content-studio && docker compose up -d --build --force-recreate updater
```

## 9. Service galerie

Le service `gallery` (conteneur `ai-content-studio-gallery`, `127.0.0.1:8094`, atteint par `:8090/gallery/`) indexe le dossier `output/` de ComfyUI pour la galerie : recherche, filtres, dates, tags, favoris, corbeille. La génération n'en dépend jamais : s'il ne répond pas, la galerie retombe sur les images mémorisées par ce navigateur (une note le dit et le journal d'événements reçoit un `WARN`).

### 9.1 Le service ne répond pas

```bash
curl -s http://localhost:8090/gallery/health                    # {"ok": true, "indexed": …, "scanning": …, "warning": null, …}
docker compose ps gallery                                       # Up ?
docker logs --tail 50 ai-content-studio-gallery                 # erreurs seulement : les requêtes ne sont pas journalisées
docker inspect -f '{{.RestartCount}} {{.State.Status}}' ai-content-studio-gallery
```

- `docker compose ps gallery` n'affiche rien ou `Exited` : `docker compose up -d --build gallery`.
- `RestartCount` ne cesse de monter : le service plante au démarrage et Docker le relance. Les dernières lignes du log disent pourquoi (port occupé : 9.2 ; problème sur `output/` : 9.3).
- Le conteneur est `Up` et répond sur `127.0.0.1:8094`, mais `:8090/gallery/health` donne un `404` ou une page HTML : le conteneur web n'a jamais chargé la règle `/gallery/` de `nginx.conf` (monté en fichier unique, un nginx déjà lancé ne voit pas le changement). `docker compose up -d --force-recreate ai-content-studio` ; ajoutez `-t 0` pour éviter ~10 s d'attente des WebSocket ouvertes.
- `"indexed": 0` avec `"scanning": true` juste après un démarrage : le premier scan tourne (environ 15 s pour 1 800 fichiers), la galerie l'attend toute seule. Un `"warning"` signifie que le dossier de sorties est absent ou vide alors que l'index ne l'est pas : le service ne supprime alors rien — vérifiez que `output/` est bien monté.

### 9.2 Le port 8094 est occupé

Le service tourne en réseau hôte et écoute toujours sur `127.0.0.1:8094`. Si un autre processus tient ce port, le conteneur s'arrête aussitôt et Docker le relance en boucle.

```bash
ss -ltnp "sport = :8094"          # qui le tient ?
```

Libérez le port, puis `docker compose up -d gallery`. Changer de port impose de modifier `PORT` dans `docker-compose.yml` **et** le `proxy_pass` de `location ^~ /gallery/` dans `nginx.conf` (puis de recréer le conteneur web, voir 9.1).

### 9.3 `output/` n'est pas inscriptible

La lecture marche, mais la corbeille, le renommage ou la restauration répondent une erreur (la page affiche « Le service de galerie n'a pas abouti : rien n'a été modifié. » ; les logs montrent un `PermissionError`). Le service tourne avec `APP_UID:APP_GID` de `.env` (1000:1000 par défaut), déplace les fichiers par lien physique, et un dossier ou un fichier qui ne lui appartient pas ne peut pas être déplacé.

```bash
ls -ld ~/comfyui-spark/basedir/output ~/comfyui-spark/basedir/output/.trash   # propriétaire ?
docker exec ai-content-studio-gallery id                                      # uid=1000 gid=1000
find ~/comfyui-spark/basedir/output ! -user "$(id -un)" -print -quit           # une sortie = un fichier d'un autre propriétaire
```

`install.sh` affiche le correctif sans jamais l'exécuter. Lancez-le vous-même, une fois :

```bash
sudo chown -R "$(id -u):$(id -g)" ~/comfyui-spark/basedir/output
```

Cela arrive aussi quand `output/` n'existait pas avant le premier `docker compose up` : Docker le crée alors en `root`.

### 9.4 Réindexer à zéro

L'index ne contient que ce qui se recalcule depuis les fichiers, **sauf les tags et les favoris**, qui n'existent que dans le volume `gallery-data` : réindexer les efface. Les images ne sont jamais touchées. Pour repartir de zéro (index corrompu, `APP_UID` changé après la création du volume, doute sur le schéma) :

```bash
cd ~/ai-content-studio
docker compose down gallery && docker volume rm <projet>_gallery-data && docker compose up -d --build gallery
```

`<projet>` est le nom du projet compose, c'est-à-dire le nom du dossier du dépôt (`ai-content-studio` pour le clone par défaut) : `docker volume ls | grep gallery-data` donne le nom exact. Le premier scan prend environ 15 s pour 1 800 fichiers. Les favoris de ce navigateur (`galleryFavs`) ne sont envoyés au service qu'une seule fois : pour les renvoyer après une réindexation, supprimez la clé `galleryFavsMigrated` du stockage local du navigateur, puis rechargez.

### 9.5 Vider la corbeille

« Supprimer » dans la galerie déplace le fichier vers `~/comfyui-spark/basedir/output/.trash/` et reste annulable (vue Corbeille, « Restaurer »). L'interface n'a aucune suppression définitive : elle est manuelle et **irréversible**.

```bash
rm -r ~/comfyui-spark/basedir/output/.trash
```

(ou un seul dossier `.trash/<id>`). Le service a créé ces dossiers avec son propre UID : aucun `sudo` n'est nécessaire s'il tourne sous votre compte. En moins d'une minute (`SCAN_INTERVAL`, 60 s) la vue Corbeille se vide : les lignes dont le fichier a disparu sont supprimées, avec leurs tags.

### 9.6 Après une mise à jour faite par l'updater

L'updater de l'app ne fait que `git pull` : il ne reconstruit jamais l'image `gallery` et ne recrée pas le conteneur web. Quand une mise à jour touche `docker/gallery/` ou `nginx.conf`, lancez :

```bash
cd ~/ai-content-studio
docker compose up -d --build gallery && docker compose up -d --force-recreate ai-content-studio
```

La seconde commande est nécessaire pour tout changement de `nginx.conf` (montage en fichier unique, voir 9.1) ; ajoutez `-t 0` pour éviter ~10 s d'attente des WebSocket ouvertes.
