# Publicaciones locales de Muxplorer

Muxplorer se compila, valida y publica desde el ordenador de desarrollo al registro
privado de Gitea (`100.81.25.109:30008/n7steve/muxplorer`). GitHub conserva el código
fuente (espejado como _pull mirror_ en Gitea) y ejecuta únicamente validación de PRs.

## Preparación inicial

Requisitos: Python 3.11+, Node.js 24+, pnpm 11, Git, Docker Desktop con contenedores
Linux y Playwright Chromium (`pnpm exec playwright install chromium`).

Añade `"insecure-registries": ["100.81.25.109:30008"]` en `%USERPROFILE%\.docker\daemon.json`
e inicia sesión una vez con un token de Gitea (`write:package`):

```powershell
docker login 100.81.25.109:30008 -u n7steve
pnpm release:check
```

## Validar sin publicar

```powershell
pnpm release:prepare --preview
```

## Publicar una versión

1. Confirma los cambios en `main`.
2. Con el árbol limpio: `pnpm release:prepare`
3. Sube el commit a GitHub: `git push origin main`
4. Publica la carpeta generada:

```powershell
pnpm release:publish "D:\Steve\Proyectos\Muxplorer\tmp\releases\<commit-completo>"
```

El publicador sube primero `sha-<commit>`, comprueba de forma anónima que el paquete es
privado (`401`/`403`) y solo entonces actualiza `:<version>` y `:latest`.
