"""Build, validate and publish Muxplorer from the development computer (Python 3.11+).

    python scripts/release-local.py check
    python scripts/release-local.py prepare [--preview]
    python scripts/release-local.py publish tmp/releases/<commit>
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = "100.81.25.109:30008"
REPOSITORY = "n7steve/muxplorer"
IMAGE = f"{REGISTRY}/{REPOSITORY}"


def run(*args, env=None, capture=False):
    executable = shutil.which(str(args[0]))
    if not executable:
        raise RuntimeError(f"No se encuentra {args[0]} en PATH")
    result = subprocess.run([executable, *map(str, args[1:])], cwd=ROOT,
                            env=env, text=True, capture_output=capture)
    if result.returncode:
        detail = f": {result.stderr.strip()[-600:]}" if capture and result.stderr else ""
        raise RuntimeError(f"Ha fallado {args[0]} (codigo {result.returncode}){detail}")
    return result.stdout.strip() if capture else ""


def git(*args):
    return run("git", *args, capture=True)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def app_version():
    version = json.loads((ROOT / "apps/api/package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError(f"Version de Muxplorer no valida: {version}")
    return version


def verify_private_image(image):
    """Ensure the published Gitea package rejects anonymous pulls over HTTP."""
    prefix = IMAGE + ":"
    if not image.startswith(prefix) or not re.fullmatch(r"[\w.-]+", image[len(prefix):]):
        raise RuntimeError("Referencia de imagen inesperada para la comprobacion privada")
    reference = image[len(prefix):]
    manifest_url = f"http://{REGISTRY}/v2/{REPOSITORY}/manifests/{reference}"
    headers = {
        "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        "User-Agent": "muxplorer-anonymous-registry-check",
    }
    try:
        with urllib.request.urlopen(urllib.request.Request(manifest_url, headers=headers), timeout=30):
            pass
    except urllib.error.HTTPError as error:
        if error.code == 403:
            return
        if error.code != 401:
            raise RuntimeError("No se ha podido verificar la privacidad de la imagen") from None
        challenge = error.headers.get("WWW-Authenticate", "") if error.headers else ""
        if not challenge.lower().startswith("bearer "):
            return
        params = dict(re.findall(r'([a-zA-Z]+)="([^"]*)"', challenge))
        realm = params.get("realm", "")
        if not realm.startswith(f"http://{REGISTRY}/"):
            raise RuntimeError("No se ha podido verificar la privacidad de la imagen") from None
        query = urllib.parse.urlencode({k: params[k] for k in ("service", "scope") if k in params})
        token_url = f"{realm}?{query}" if query else realm
        try:
            with urllib.request.urlopen(
                urllib.request.Request(token_url, headers={"User-Agent": "muxplorer-anonymous-registry-check"}),
                timeout=30,
            ) as response:
                token = json.load(response).get("token", "")
            if not token:
                return
            with urllib.request.urlopen(
                urllib.request.Request(manifest_url, headers={**headers, "Authorization": "Bearer " + token}),
                timeout=30,
            ):
                pass
        except urllib.error.HTTPError as token_error:
            if token_error.code in (401, 403):
                return
            raise RuntimeError("No se ha podido verificar la privacidad de la imagen") from None
        except (urllib.error.URLError, OSError, ValueError, KeyError):
            raise RuntimeError("No se ha podido verificar la privacidad de la imagen") from None
        raise RuntimeError("La imagen se puede descargar sin autenticar; haz privado el paquete antes de publicar")
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        raise RuntimeError("No se ha podido verificar la privacidad de la imagen") from None
    raise RuntimeError("La imagen se puede descargar sin autenticar; haz privado el paquete antes de publicar")


def check_registry_reachable():
    url = f"http://{REGISTRY}/v2/"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "muxplorer-check"}), timeout=15):
            return
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return
        raise RuntimeError(f"El registro Gitea respondio HTTP {error.code} en {url}") from None
    except (urllib.error.URLError, OSError) as error:
        raise RuntimeError(f"No se puede conectar con el registro Gitea en {url}: {error}") from None


def require_source(commit=None, clean=True):
    if git("branch", "--show-current") != "main":
        raise RuntimeError("La publicacion local requiere main")
    if clean and git("status", "--porcelain"):
        raise RuntimeError("Hay cambios sin commit; preparalos antes de publicar. --preview permite validar sin publicar.")
    head = git("rev-parse", "HEAD")
    if commit and head != commit:
        raise RuntimeError("HEAD ha cambiado; vuelve a preparar esta version")
    return head


def prepare(preview):
    started = time.monotonic()
    commit = require_source(clean=not preview)
    version = app_version()
    folder = ROOT / "tmp/releases" / (commit + ("-preview-" + secrets.token_hex(4) if preview else ""))
    if (folder / "prepared.json").exists():
        raise RuntimeError("Este commit ya tiene una preparacion; usa publish con su carpeta")
    folder.mkdir(parents=True, exist_ok=True)
    print(f"Preparando Muxplorer {version} ({commit[:12]})", flush=True)
    run(sys.executable, "-m", "unittest", "discover", "-s", "scripts/tests")
    run("pnpm", "install", "--frozen-lockfile")
    run("pnpm", "test")
    run("pnpm", "lint")
    run("pnpm", "typecheck")
    run("pnpm", "format:check")
    run("docker", "compose", "config", "--quiet")
    run("docker", "compose", "-f", "truenas-compose.yml", "config", "--quiet")
    image = f"muxplorer-local:{commit}"
    run("docker", "buildx", "build", "--load", "--provenance=false", "--platform", "linux/amd64", "-t", image,
        "--label", "org.opencontainers.image.source=https://github.com/N7Steve/Muxplorer",
        "--label", f"org.opencontainers.image.revision={commit}",
        "--label", f"org.opencontainers.image.version={version}", ".")
    run("pnpm", "test:acceptance", env={**os.environ, "MUXPLORER_IMAGE": image})
    require_source(commit, clean=not preview)
    image_id = json.loads(run("docker", "image", "inspect", image, capture=True))[0]["Id"]
    write_json(folder / "prepared.json", {
        "commit": commit, "preview": preview, "version": version, "image": image,
        "imageId": image_id, "durationSeconds": round(time.monotonic() - started),
    })
    print(f"Validacion completa. Carpeta: {folder}", flush=True)
    if preview:
        print("PREVIEW: no publicable; despues de confirmar y hacer commit, ejecuta prepare de nuevo.")
    else:
        print("Despues de subir este commit a origin/main: pnpm release:publish " + str(folder))


def publish(folder):
    folder = folder.resolve()
    prepared = json.loads((folder / "prepared.json").read_text())
    if prepared["preview"]:
        raise RuntimeError("Una preview no se puede publicar")
    commit = require_source(prepared["commit"])
    if git("ls-remote", "origin", "refs/heads/main").split()[0] != commit:
        raise RuntimeError("Sube primero el commit validado a origin/main")
    version = prepared["version"]
    if version != app_version():
        raise RuntimeError("La version preparada ya no coincide con apps/api/package.json")
    image = json.loads(run("docker", "image", "inspect", prepared["image"], capture=True))[0]
    if image["Id"] != prepared["imageId"]:
        raise RuntimeError("La imagen preparada ha cambiado")
    # Publish traceable sha tag first, verify package privacy, then update version and latest.
    target = f"{IMAGE}:sha-{commit}"
    run("docker", "tag", prepared["image"], target)
    run("docker", "push", target)
    verify_private_image(target)
    run("docker", "tag", prepared["image"], f"{IMAGE}:{version}")
    run("docker", "push", f"{IMAGE}:{version}")
    run("docker", "tag", prepared["image"], f"{IMAGE}:latest")
    run("docker", "push", f"{IMAGE}:latest")
    digests = json.loads(run("docker", "image", "inspect", target, capture=True))[0].get("RepoDigests", [])
    reference = next((d for d in digests if d.startswith(IMAGE + "@")), target)
    write_json(folder / "published.json", {
        "commit": commit, "version": version, "image": reference, "imageId": prepared["imageId"],
    })
    print(f"Publicado: {IMAGE}:{version}, {IMAGE}:latest ({reference})")


def check():
    for tool in ["git", "node", "pnpm", "docker"]:
        if not shutil.which(tool):
            raise RuntimeError(f"Falta {tool}")
    if run("docker", "info", "--format", "{{.OSType}}", capture=True) != "linux":
        raise RuntimeError("Docker Desktop debe usar contenedores Linux")
    run("docker", "buildx", "version", capture=True)
    check_registry_reachable()
    print(f"Herramientas listas y Gitea accesible en http://{REGISTRY}. Configura insecure-registries y 'docker login {REGISTRY} -u n7steve'.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check")
    prep = commands.add_parser("prepare")
    prep.add_argument("--preview", action="store_true", help="Valida cambios sin commit; no publicable")
    pub = commands.add_parser("publish")
    pub.add_argument("folder", type=Path)
    args = parser.parse_args()
    os.chdir(ROOT)
    lock_path = ROOT / "tmp/local-release.lock"
    lock_path.parent.mkdir(exist_ok=True)
    with lock_path.open("r+b" if lock_path.exists() else "w+b") as lock:
        if os.name == "nt":
            import msvcrt
            if lock_path.stat().st_size == 0:
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "check":
            check()
        elif args.command == "prepare":
            prepare(args.preview)
        else:
            publish(args.folder)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
