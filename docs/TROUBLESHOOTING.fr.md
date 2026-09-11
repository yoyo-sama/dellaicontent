# Dépannage — installation et déploiement (GB10)

*English version: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).*

Ce guide couvre l'installation et le lancement de la stack, pas la qualité des rendus (voir
`docs/TESTING.md`) ni les pièges des pipelines (voir `docs/LESSONS.md`).

**`install.sh` diagnostique, répare et — avec `--mode uninstall` — désinstalle désormais
l'application tout seul.** L'essentiel de ce qui était autrefois une procédure manuelle dans ce
guide est maintenant `./install.sh --check` (diagnostic en lecture seule), `./install.sh
--dry-run` (idem, mais parcourt chaque étape), ou une exécution réelle. Le guide complet du
script est [docs/INSTALL.md](INSTALL.md) (en anglais). Ce qui reste ci-dessous est un
symptôme → cause, plus la poignée de choses que le script ne peut vraiment pas faire à votre
place : il ne lance jamais `sudo` lui-même, et un téléchargement gated Hugging Face suppose que
vous ayez accepté les conditions vous-même.

Chaque commande ci-dessous a été exécutée telle quelle sur un GB10 en service. Aucune n'installe
ni ne supprime quoi que ce soit sauf mention explicite.

## Symptômes courants et leur vraie cause

| Ce que vous voyez | Cause | Section |
|---|---|---|
| `Error: JSON.parse: unexpected character at line 1 column 1` | Le corps de la réponse n'est pas du JSON mais la page d'erreur **HTML** de nginx (502/504) : ComfyUI ou Ollama ne répond pas derrière le reverse proxy | [1](#1-diagnostic-en-trois-commandes) |
| `Enhancement failed: NetworkError when attempting to fetch resource` | La requête vers `/ollama/api/chat` ne s'est jamais terminée (connexion refusée ou coupée) | [1](#1-diagnostic-en-trois-commandes) |
| ComfyUI tourne mais ne voit aucun modèle | Les modèles ont été téléchargés dans un dossier que ce ComfyUI-là ne lit pas | [2](#2-comfyui-ne-voit-pas-les-modèles) |
| Un cadenas sur `comfyui-spark/` dans le gestionnaire de fichiers | Dossier créé par dockerd en `root:root` (bind-mount dont la source n'existait pas) — tout téléchargement de modèle échoue ensuite en "permission denied" | [2](#2-comfyui-ne-voit-pas-les-modèles) |
| `SKIPPED (native install stopped)` | Ollama est installé hors Docker et son service est arrêté, sans sudo sans mot de passe pour le démarrer | [3](#3-ollama) |
| `SKIPPED (port 11434 busy)` / `port is already allocated` | Un autre processus occupe le port | [3](#3-ollama) |
| Vous réparez ou mettez à jour un poste sur lequel une version plus ancienne a déjà tourné | Ancienne mise en page, détectée et migrée automatiquement | [4](#4-réparer-un-poste-sur-lequel-une-version-plus-ancienne-a-déjà-tourné) |
| Vous voulez retirer l'app, ou repartir propre | `--mode uninstall`, ou une remise à zéro complète | [5](#5-désinstallation--remise-à-zéro) |

**La langue du prompt n'est jamais la cause.** Un `JSON.parse` qui échoue à "line 1 column 1"
signifie que le tout premier caractère reçu n'est pas du JSON (typiquement le `<` de `<html>`) :
l'erreur se produit avant même la lecture du texte que vous avez saisi.

## 1. Diagnostic en trois commandes

```bash
cd ~/ai-content-studio && ./install.sh --check
```

En lecture seule, et le moyen le plus rapide de voir ce qui cloche : une ligne `state`, puis une
ligne pour chacun de `comfyui`, `ollama`, `web`, `updater`, `models`, `gated` et `disk`, puis la
même vérification proxy qu'à la fin d'une exécution réelle. Sort en `0` quand tout ce dont l'app
a besoin est en place, `2` sinon — ce qui en fait aussi un health-check scriptable.

Un `502`/`504` sur `/comfy/system_stats` ou `/ollama/api/version` dans cette vérification est
exactement ce qui produit le `JSON.parse` ou le `NetworkError` du navigateur : nginx répond,
mais avec sa propre page d'erreur HTML, pas le service derrière.

Pour vérifier un seul endpoint ou conteneur à la main plutôt que de lancer le script :

```bash
for u in /comfy/system_stats /ollama/api/version /update/status; do printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8090$u"; done
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE 'comfy|ollama|content-studio'
docker logs --tail 50 comfyui-nvidia
```

Un conteneur `Exited` : relancez `./install.sh` — il redémarre un conteneur arrêté plutôt que
d'en créer un second. Le tout premier démarrage de ComfyUI installe `comfy_kitchen` et prend
plusieurs minutes — un `502` pendant cette fenêtre est normal, et `install.sh` attend jusqu'à
15 minutes.

## 2. ComfyUI ne voit pas les modèles

Le piège classique, inchangé : les modèles sont sur le disque, mais pas là où ce ComfyUI-là les
lit. `./install.sh --check` montre déjà les deux faces, dans les lignes `comfyui` et
`models`/`gated` du diagnostic — le nombre qui compte est `lists: N of the M diffusion
model(s) present on disk`.

- **Si ComfyUI est un tiers** que le script n'a pas créé (le diagnostic affiche `FOREIGN
  COMFYUI`) et `lists: 0 of …` : une exécution réelle — pas `--dry-run`, qui ne rejoue pas cette
  étape, voir docs/INSTALL.md §16 — propose une **reprise en main** (« takeover ») : un fichier
  override écrit à côté de son propre compose file, ajoutant `BASE_DIRECTORY`/`WANTED_UID`/
  `WANTED_GID` à son environnement uniquement. Image, ports, volumes et réseaux restent
  intouchés, aucun octet de modèle ne bouge, et une confirmation est demandée d'abord. Annuler :
  un `rm` puis `docker compose up -d`. Détail : docs/INSTALL.md §9.
- **Si c'est le ComfyUI de l'installeur lui-même** : `BASE_DIRECTORY: /basedir` est absent ou
  faux dans `~/comfyui-spark/compose.yaml` — comparez avec `docker/stacks/comfyui.yml`,
  corrigez, puis relancez `./install.sh`. Sans cette variable, l'image `mmartial` ignore
  `/basedir` et cherche ses modèles dans `/comfy/mnt/ComfyUI/models`.

Pour vérifier les deux mêmes faits à la main :

```bash
docker inspect comfyui-nvidia --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
curl -s http://localhost:8188/object_info/UNETLoader | grep -o 'minimax_h3[^"]*' | head -3
```

### Un dossier de modèles cadenassé

`install.sh` ne lance jamais `sudo` à votre place. Si `~/comfyui-spark/basedir` se retrouve
appartenir à `root` (un bind-mount dont la source n'existait pas avant le premier démarrage du
conteneur), le plan affiche le correctif au lieu de tenter quoi que ce soit :

```
not done by this installer, which never runs sudo — fix it yourself: …/basedir belongs to
'root', every model download into it fails until you run: sudo chown -R <uid>:<gid> …
```

Lancez `sudo chown -R "$(id -u):$(id -g)" ~/comfyui-spark`, puis `./install.sh` à nouveau.

### Vérifier l'intégrité des modèles téléchargés

`./install.sh --check` remonte déjà ceci en une ligne `models` (`N/M present`). Pour le détail
fichier par fichier, ce qu'il utilise en interne :

```bash
M=~/comfyui-spark/basedir/models; while IFS='|' read -r d f s u; do case "$d" in ''|\#*) continue;; esac; case "$s" in ''|*[!0-9]*) continue;; esac; a=$(stat -c%s "$M/$d/$f" 2>/dev/null || echo 0); t=$((s/100)); [ "$t" -lt 1 ] && t=1; if [ "$a" -eq 0 ]; then r=MISSING; elif [ "$a" -ge $((s-t)) ] && [ "$a" -le $((s+t)) ]; then r=OK; else r=INCOMPLETE; fi; printf '%-11s %s\n' "$r" "$d/$f"; done < ~/ai-content-studio/scripts/models.txt
```

`MISSING` et `INCOMPLETE` se corrigent en relançant `./install.sh` (`curl -C -` reprend un
téléchargement interrompu).

**Limite connue de ce contrôle** : la tolérance est de 1 %, la même que celle utilisée par
`install.sh`, et elle est nécessaire — des révisions Hugging Face republiées peuvent différer de
quelques kilo-octets de `scripts/models.txt`. Un fichier tronqué de moins de 1 % passe donc pour
bon. La seule preuve qui compte reste un rendu réel, inspecté (`docs/TESTING.md`) — un job
ComfyUI qui rapporte "success" ne prouve rien.

## 3. Ollama

`install.sh` détecte Ollama **par son service** (`:11434`), pas par un conteneur : une
installation native (systemd) est réutilisée telle quelle, et le modèle `gemma4:e4b` est tiré
par l'API HTTP dans les deux cas. Vérification et pull manuel, valides dans les deux cas :

```bash
curl -s http://localhost:11434/api/tags | grep -o '"gemma4:e4b"' || curl -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}'
```

Si le récapitulatif affiche `SKIPPED (native install stopped)` : un Ollama natif existe mais ne
répondait pas, et le `sudo -n systemctl start ollama.service` du script a échoué —
délibérément, il ne demande jamais de mot de passe, et il ne crée pas non plus de conteneur dans
ce cas, pour que deux instances Ollama ne se disputent jamais le port. Le script affiche :

```
WARNING: could not start the native ollama service (no passwordless sudo?)
    run it yourself, then run this script again:  sudo systemctl enable --now ollama.service
    no container was created, so two ollama instances never fight over port 11434
```

Lancez cette commande, puis `./install.sh` à nouveau. Si le port est tenu par autre chose à la
place, `sudo ss -ltnp 'sport = :11434'` dit par quoi.

## 4. Réparer un poste sur lequel une version plus ancienne a déjà tourné

C'est le cas le plus fréquent : une première installation a été tentée avant la v1.0.7, quand
`docker-compose.yml` déclarait aussi `comfyui` et `ollama` avec leurs volumes sous
`~/ai-content-studio/comfyui/`. `install.sh` fait désormais toute la migration lui-même : il
supprime les conteneurs hérités et les recrée en tant que stacks `~/comfyui-spark`/`~/ollama`,
copie les poids Ollama depuis le volume `ollama-data` vers `~/ollama/data` (évite un
téléchargement de 9,6 Go), et déplace les modèles ComfyUI de l'ancien dossier vers celui que le
ComfyUI en cours d'exécution lit réellement — fichier par fichier, `mv -n`, rien n'est jamais
écrasé ni supprimé.

```bash
cd ~/ai-content-studio && git pull
./install.sh --check                                      # confirme : state OLD LAYOUT (pre-1.0.7)
./install.sh --dry-run                                     # parcourt chaque étape en « would … », ne change rien
HF_TOKEN=hf_xxx ./install.sh                               # l'applique (HF_TOKEN seulement si LTX 2.5 manque encore)
```

`install.sh` écrit son propre journal dans `~/install-YYYY-MM-DD-HHMM.log` ; une exécution peut
durer des heures à cause des téléchargements de modèles.

**Ce qui prouve que la migration a eu lieu** : la ligne de diagnostic `state : OLD LAYOUT
(pre-1.0.7) — …`, et dans le plan, une étape commençant par `docker rm -f <conteneur>
(inherited: this repository's compose file created it)` pour ComfyUI et pour Ollama. Dans le
tableau `Models: before -> after` qui suit, les fichiers déplacés apparaissent en `MOVED (from
the legacy repository folder)`, ceux déjà téléchargés en `KEPT (already in place)`.

**Un doublon est signalé** (`N file(s) already present in <dir>; the copy in <old> is a
duplicate you may delete yourself`) : les deux copies sont laissées en place exprès — supprimez
l'ancienne vous-même si vous voulez récupérer l'espace ; cela ne bloque jamais rien et n'est
jamais compté comme travail restant.

**Le déplacement laisse des fichiers derrière lui** (`moved: N left behind: M`, M non nul) :
l'ancien dossier appartient à root.

```bash
sudo chown -R "$(id -u):$(id -g)" ~/ai-content-studio/comfyui
```

Relancez ensuite `./install.sh` — le déplacement reprend là où il s'était arrêté.

**Aucune étape de migration n'apparaît** (le conteneur s'affiche en `reused` plutôt qu'une étape
`docker rm -f … (inherited: …)`) : il n'a pas été créé par le `docker-compose.yml` de ce dépôt
(vérifié par le label compose) — un conteneur créé à la main, ou par une autre stack. Le script
n'y touche jamais ; utilisez la commande d'inventaire de la
[§5](#inventaire-dabord--qui-possède-quoi) pour voir d'où il vient réellement avant de décider
à la main.

**Vérifier** : relancez `./install.sh` — il est idempotent, et c'est le meilleur test. Tout
devrait afficher `reused`, et les vérifications proxy devraient toutes afficher `HTTP 200`.
Puis dans l'app (`http://<ip>:8090`) : **✨ Enhance (LLM)** sur un champ de prompt, puis une
simple image Krea 2 avant de tenter la vidéo.

## 5. Désinstallation / remise à zéro

```bash
./install.sh --mode uninstall --dry-run     # aperçu, ne supprime rien
./install.sh --mode uninstall               # demande par composant avant de supprimer quoi que ce soit
```

Ne supprime jamais qu'un conteneur créé par cet installeur — vérifié par son propre label
compose, jamais par nom ou par image (docs/INSTALL.md §11). Modèles, poids Ollama, workflows,
`.env` et les fichiers de stack (`compose.yaml`, `compose.override.yaml`, userscripts) sont
toujours conservés, et listés avec leur taille à la fin sous `Kept — nothing below was
deleted`. Sans surveillance (pas de terminal) :
`./install.sh --mode uninstall --yes --components web,updater,comfyui,ollama`.

**Réinstaller ensuite** : `./install.sh` à nouveau — il réutilise les fichiers de stack
conservés.

### Inventaire d'abord — qui possède quoi

Utile avant de statuer sur un conteneur que la désinstallation a laissé dans la liste `NOT
ours`, ou un conteneur jamais créé par `docker compose` :

```bash
for c in $(docker ps -a --format '{{.Names}}'); do printf '%-30s %-48s %s\n' "$c" "$(docker inspect -f '{{.Config.Image}}' "$c")" "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c")"; done
```

La troisième colonne décide : les conteneurs pointant vers
`<home>/ai-content-studio/docker-compose.yml` (ou, pour ComfyUI/Ollama, vers
`~/comfyui-spark/compose.yaml`/`~/ollama/compose.yaml` écrits par cet installeur) viennent de
votre installation. Une colonne vide veut dire un conteneur créé hors compose (`docker run`),
qui n'appartient qu'à vous. Un fichier différent veut dire une autre stack — n'y touchez pas.

### Remise à zéro complète (images et modèles compris — plusieurs centaines de Go retéléchargés)

`install.sh` ne supprime jamais une image, un volume ou un fichier de modèle — délibérément :
ce sont des données coûteuses, et ce n'est quasiment jamais ce qui a vraiment cassé une
installation. Si vous voulez vraiment tout faire disparaître (une image corrompue, récupérer de
l'espace disque) :

```bash
docker rm -f ai-content-studio-web ai-content-studio-updater comfyui-nvidia ollama-api 2>/dev/null; docker volume rm ollama-data 2>/dev/null; docker rmi mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest ollama/ollama:latest ai-content-studio-updater 2>/dev/null; sudo rm -rf ~/comfyui-spark ~/ollama ~/ai-content-studio
```

Relisez d'abord l'inventaire ci-dessus : `~/comfyui-spark` peut **précéder** l'installation de
l'app (c'est le cas sur la machine de référence, où cette stack ComfyUI est plus ancienne et
gérée par son propre `compose.yaml`) — la détruire vous ferait retélécharger 150 Go pour rien.
Dans le doute, conservez `~/comfyui-spark/basedir/models` : les fichiers déjà présents ne sont
jamais retéléchargés.

### Réinstaller

```bash
git clone https://github.com/yoyo-sama/dellaicontent.git ~/ai-content-studio && cd ~/ai-content-studio && HF_TOKEN=hf_xxx ./install.sh
```

### Ce qu'il ne faut pas supprimer

Docker, le driver NVIDIA et `nvidia-container-toolkit` ne sont jamais la cause d'une
installation ratée de cette stack, et `install.sh` ne les installe pas — il vérifie leur
présence et affiche quoi lancer s'il en manque un. `docker system prune -a` récupérerait de
l'espace mais forcerait un re-pull de chaque image : à garder pour un disque saturé, pas pour
cette app en particulier.

## 6. Vérifier qu'une installation tient la route

```bash
cd ~/ai-content-studio && ./install.sh --check
```

Idempotent et en lecture seule : `state : UP TO DATE` et un code de sortie `0` veulent dire que
tout ce dont l'app a besoin est en place. C'est seulement alors qu'il faut ouvrir
`http://<ip>:8090`, tester **✨ Enhance (LLM)** sur un champ de prompt, puis une génération
d'image simple (Krea 2) avant de tenter la vidéo.
