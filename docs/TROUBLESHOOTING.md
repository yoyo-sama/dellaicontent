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
| `skipped (native Ollama installed but not started)` | Ollama est installé hors Docker et son service est arrêté | [3](#3-ollama) |
| `skipped (port 11434 busy)` / `port is already allocated` | Un autre processus tient le port | [3](#3-ollama) |

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
exactement ce qui produit l'erreur `JSON.parse` côté navigateur. Ensuite :

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

## 4. Réparer une installation faite avec l'ancienne mise en page

Avant la v1.0.7, `docker-compose.yml` déclarait aussi `comfyui` et `ollama`, avec leurs volumes
sous `~/ai-content-studio/comfyui/`. Ce ComfyUI-là n'avait pas `BASE_DIRECTORY` et ne lisait
donc pas le dossier où le script téléchargeait les modèles. `install.sh` migre ces
installations automatiquement, mais l'ancien dossier n'est jamais déplacé pour vous.

```bash
cd ~/ai-content-studio && git pull && du -sh comfyui/basedir/models/* 2>/dev/null; ls -ld comfyui 2>/dev/null; df -h /home | tail -1
```

- Si l'ancien dossier ne contient rien d'utile (cas le plus fréquent : seul `loras` existe,
  créé par un bind-mount, les téléchargements ayant échoué en « permission denied ») :

  ```bash
  sudo rm -rf ~/ai-content-studio/comfyui
  ```

- S'il contient de vrais modèles, déplacez-les vers la nouvelle stack **avant** de relancer le
  script, ils seront reconnus et non retéléchargés :

  ```bash
  mkdir -p ~/comfyui-spark/basedir/models && sudo mv ~/ai-content-studio/comfyui/basedir/models/* ~/comfyui-spark/basedir/models/ && sudo chown -R "$(id -u):$(id -g)" ~/comfyui-spark
  ```

Puis l'installation elle-même. `HF_TOKEN` n'est pas facultatif en pratique : les 4 fichiers
LTX 2.5 viennent d'un dépôt Hugging Face *gated* et échouent proprement sans jeton (les autres
se téléchargent normalement).

```bash
cd ~/ai-content-studio && HF_TOKEN=<votre_jeton_hf> ./install.sh
```

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
ce qui évite 9,6 Go de retéléchargement.

### Remise à zéro totale

Tout part, y compris les images (~30 Go) et **les modèles (~150 Go, plusieurs heures de
téléchargement)** :

```bash
docker rm -f ai-content-studio-web ai-content-studio-updater comfyui-nvidia ollama-api 2>/dev/null; docker volume rm ollama-data 2>/dev/null; docker rmi mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest ollama/ollama:latest ai-content-studio-updater 2>/dev/null; sudo rm -rf ~/comfyui-spark ~/ollama ~/ai-content-studio
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

Attendu : `reused` sur les trois services, `already present (not re-downloaded) : 20`,
`Ollama model gemma4:e4b: present`, et quatre `HTTP 200` en health-checks. Ensuite seulement,
ouvrez `http://<ip>:8090`, testez **✨ Enrichir (LLM)** sur un champ de prompt, puis une
génération d'image simple (Krea 2) avant d'essayer la vidéo.
