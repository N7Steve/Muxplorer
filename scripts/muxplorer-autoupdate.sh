#!/bin/bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BASE=/mnt/AppsPool/muxplorer/.maintenance
export DOCKER_CONFIG="$BASE/docker"
IMAGE=127.0.0.1:30008/n7steve/muxplorer:latest

exec 9>"$BASE/update.lock"
flock -n 9 || exit 0

state=$(midclt call app.get_instance muxplorer | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
[[ "$state" == RUNNING ]] || exit 0
mapfile -t containers < <(docker ps -q \
  --filter label=com.docker.compose.project=ix-muxplorer \
  --filter label=com.docker.compose.service=muxplorer)
if [[ ${#containers[@]} != 1 ]]; then
  echo 'No se ha encontrado un unico contenedor de muxplorer; no se modifica nada.' >&2
  exit 1
fi
running=$(docker inspect --format '{{.Image}}' "${containers[0]}")
log=$(mktemp)
trap 'rm -f "$log"' EXIT
if ! timeout 180 docker pull "$IMAGE" >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
available=$(docker image inspect --format '{{.Id}}' "$IMAGE")
[[ "$running" != "$available" ]] || exit 0

echo "$(date -Is): actualizando muxplorer."
midclt call --job app.redeploy muxplorer >/dev/null
for attempt in {1..60}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8098/api/health >/dev/null; then
    echo "$(date -Is): muxplorer responde correctamente."
    exit 0
  fi
  sleep 5
done
echo 'Muxplorer no responde tras la actualizacion. Revisar Apps y sus logs.' >&2
exit 1
