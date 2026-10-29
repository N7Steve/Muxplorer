# Muxplorer

Explorador web de doble panel para organizar y preparar multimedia en TrueNAS SCALE. Angular standalone y Signals, NestJS, SQLite, 7-Zip, MKVToolNix y MakeMKV en una única imagen sin escritorio. **Los datos se procesan en el servidor; el navegador solo envía órdenes y recibe metadatos y progreso.**

## Arranque rápido con Docker

Requisitos: Docker Engine con Compose v2, arquitectura **Linux amd64**, Linux con Landlock habilitado (kernel ≥ 5.13). Docker Desktop con contenedores Linux también sirve para desarrollo. La construcción necesita conexión a npm, Debian y las descargas oficiales de los motores.

```sh
docker compose up --build -d
```

Abre [http://localhost:8098](http://localhost:8098) y elige el nombre de usuario y una contraseña de al menos 12 caracteres para la única cuenta de administrador. No hace falta token ni acceder a la consola. A partir de ese momento, inicia sesión con ese usuario y contraseña; la configuración inicial ya no permite crear ni sustituir cuentas. Las credenciales persisten en `/config`, y la contraseña se guarda hasheada. No hay credenciales de fábrica. Si actualizas una instalación anterior que solo tenía contraseña, conserva esa contraseña e inicia sesión con el usuario `admin`.

Los montajes de desarrollo son `./.local/downloads` y `./.local/plex`; Compose puede crearlos. No hacen referencia al NAS. Configuración, contraseña hasheada, sesiones e historial viven en el volumen independiente `config`, montado en `/config`. Haz copia de este volumen; no uses `docker compose down -v` si quieres conservarlo.

Copia `.env.example` a `.env` para cambiar puerto, ubicaciones locales, UID/GID o concurrencia. Para detener la aplicación:

```sh
docker compose down
```

## Uso

- Los botones laterales atrás/adelante del ratón recorren el historial del panel situado bajo el cursor, también en los selectores, y bloquean la navegación del navegador.
- Cada panel navega de forma independiente por Downloads y PlexMedia. Doble clic abre carpetas; breadcrumbs, atrás, adelante y subir permiten recorrerlas. Ordena por columnas y filtra por nombre.
- Ctrl/clic alterna selección, Shift/clic selecciona un rango, Ctrl+A selecciona todo. Ctrl+C / Ctrl+X / Ctrl+V prepara una copia o movimiento y abre la confirmación de destino. F2 renombra, Supr solicita confirmación, Enter abre, Retroceso sube, F5 actualiza y `/` enfoca el filtro.
- Copia y movimiento usan un selector visual que puede navegar por cualquiera de las raíces. Arrastrar entre paneles abre un diálogo para elegir explícitamente copiar o mover.
- El menú contextual de archivos comprimidos permite extraer aquí, en una nueva carpeta o en una ubicación elegida, con contraseña opcional. Inicia RAR multipartes desde su primer volumen y conserva todas las partes en la misma carpeta; lo mismo para `.7z.001`.
- MKVToolNix inspecciona las pistas reales. Activa, desactiva, reordena, cambia nombres, idioma BCP 47, default/forced y título. Añade varias fuentes de audio/subtítulos existentes mediante el selector. Cada fuente mantiene su propio espacio de IDs; no se concatenan archivos. La salida siempre es un MKV nuevo.
- MakeMKV analiza una ISO o `BDMV/index.bdmv`, muestra títulos, duración, capítulos, tamaño y streams disponibles. Selecciona uno o más títulos. Tras extraerlos, el trabajo solicita **revisión de las pistas reales generadas**. Confirma la selección definitiva para ejecutar un remux adicional y publicar los resultados. No se emparejan IDs del disco y MKV por heurísticas.
- El panel Operaciones muestra etapas, progreso disponible, mensajes, resultados y errores. **Empezar** permite iniciar una tarea en cola junto a las activas, sin límite de tareas simultáneas. Los análisis preparados ofrecen **Elegir títulos** y los MKV temporales **Revisar pistas**. El icono **Quitar de operaciones** retira una tarea completada, fallida o cancelada, limpia sus temporales y conserva sus resultados y registro en SQLite. Puedes navegar mientras trabaja, cancelar, revisar MakeMKV o abrir el destino. El historial visible muestra los últimos 500 trabajos; SQLite conserva los registros anteriores.

## Despliegue en TrueNAS SCALE

El archivo `truenas-compose.yml` está preparado para instalar una Custom App mediante YAML, en versiones de SCALE que usan Docker Compose. No contiene `build:`. Sus montajes son exactamente:

```yaml
- /mnt/StevePool/Steve/Downloads:/data/downloads:rw
- /mnt/PlexPool/PlexMedia:/data/plex:rw
```

No se montan otras carpetas del host ni el socket Docker. `/config` utiliza un volumen independiente.

La instalación normal descarga automáticamente la imagen publicada en GitHub Container Registry:

```yaml
image: ghcr.io/n7steve/muxplorer:latest
pull_policy: always
```

Ve a **Apps → Discover Apps → Install via YAML**, pega `truenas-compose.yml`, revisa `user: "1000:1000"` y guarda. TrueNAS descargará la imagen sin compilar el proyecto ni copiar archivos desde otro equipo. Abre `http://IP_DEL_NAS:8098` y crea el único administrador eligiendo su nombre de usuario y contraseña directamente en la página. El healthcheck está incluido en la imagen.

La imagen debe tener visibilidad **Public** en GitHub Packages para que el NAS pueda descargarla sin credenciales. Publicar la imagen no expone tu instancia ni tus datos multimedia: los datasets se montan al instalar la app. Si un paquete nuevo aún figura como privado, su propietario puede cambiarlo en [Package settings](https://github.com/users/N7Steve/packages/container/muxplorer/settings). No introduzcas credenciales en este YAML.

Cada push a `main` ejecuta `.github/workflows/publish-image.yml`: valida el código, construye una imagen amd64, ejecuta las pruebas de aceptación en Docker y navegador, y solo entonces publica **esa misma imagen probada** como `ghcr.io/n7steve/muxplorer:latest` y `ghcr.io/n7steve/muxplorer:sha-<commit completo>`. El workflow utiliza el token temporal de GitHub Actions con permiso de escritura de paquetes; no requiere guardar claves personales. También se puede iniciar manualmente desde Actions.

Para actualizar, vuelve a desplegar la app: `pull_policy: always` solicita la imagen actual al registro. No actualiza automáticamente un contenedor ya en ejecución. Para fijar una versión exacta o volver atrás, sustituye `latest` por una etiqueta `sha-...` de una publicación validada. Conserva el volumen `/config`.

La alternativa sin conexión sigue disponible: construye con `docker build -t muxplorer:0.1.5 .`, exporta con `docker save -o muxplorer-0.1.5.tar muxplorer:0.1.5`, transfiere el tar y cárgalo con `docker load -i ...`. Solo en ese caso cambia el YAML a `image: muxplorer:0.1.5` y `pull_policy: never`.

Valida los archivos antes de instalar:

```sh
docker compose config --quiet
docker compose -f truenas-compose.yml config --quiet
```

## UID/GID y ACL

La aplicación se ejecuta como **1000:1000**, sin capabilities y con `no-new-privileges`. `PUID`/`PGID` en el Compose local y `user:` en TrueNAS permiten cambiarlo. El proceso principal y los motores multimedia se ejecutan con esa identidad.

En TrueNAS prepara las ACL para que esa identidad pueda listar, leer, crear, renombrar y eliminar en los dos datasets. Concede también escritura en `/config`. Las ACL de creación y herencia determinan el acceso posterior desde Plex/SMB; los archivos nuevos usan permisos conservadores y la app aplica umask 027. La app **no ejecuta chmod/chown recursivos sobre los datasets** ni fuerza permisos para eludir las ACL.

Un volumen nuevo de `/config` se inicializa desde la imagen con propietario 1000:1000. Si eliges otro UID, prepara ese volumen con el propietario/ACL adecuados antes de arrancar. También puedes sustituir únicamente el volumen de configuración por un dataset de aplicaciones con ACL preparadas. No cambies permisos del árbol multimedia como parte de la instalación.

## ISO y BDMV: dos motores

El menú contextual de una ISO o `BDMV/index.bdmv` ofrece **Abrir con MKVToolNix** y **Abrir con MakeMKV**. Ambos generan un temporal, solicitan revisión de las pistas reales y publican el resultado mediante el mismo remux verificado.

La imagen instala MKVToolNix 103.0 desde el paquete oficial verificado por SHA-256, incluido el lector de capítulos MPLS que no estaba disponible en el paquete 74.0 de Debian. MKVToolNix usa las listas MPLS de un Blu-ray descifrado. Para una ISO, 7-Zip abre su estructura dentro de un temporal privado junto al archivo de origen, confinado con Landlock; esto requiere escritura y espacio libre en el origen además del destino. Al abrir desde la interfaz se crea una operación de preparación con progreso y cancelación. Puedes dejarla en segundo plano y volver desde **Elegir títulos** en Operaciones. La ISO se extrae una sola vez: el contenido privado se conserva mientras eliges los títulos y se reutiliza al crear los MKV; se elimina al terminar esa fase o al cancelar. La primera preparación sigue copiando el contenido de la ISO y su duración depende del tamaño y del almacenamiento. No es una lectura instantánea como la de MakeMKV. No requiere montajes, privilegios, licencia ni recodificación. Los DVD se muestran por conjunto VTS (no se reconstruye toda su navegación de menús); el contenido cifrado necesita MakeMKV o una copia descifrada.

## MakeMKV integrado

MakeMKV 1.18.4 se instala automáticamente en la misma imagen, con sus bibliotecas y permisos de ejecución para el usuario del contenedor. Está habilitado desde el primer arranque: no hay que crear otra imagen, definir variables de aceptación ni confirmar una pantalla adicional. La construcción y las pruebas ejecutan el motor como usuario sin privilegios para detectar errores de instalación antes de publicar.

Se fija 1.18.4 porque 2.0.0 presenta una regresión al abrir Blu-ray desde ISO/carpeta en Linux, reproducida con fixtures y [reportada en el foro oficial](https://forum.makemkv.com/forum/viewtopic.php?t=42565). Los paquetes binario y OSS corresponden a la misma versión y se verifican por SHA-256.

La configuración se crea automáticamente en `/config/makemkv/.MakeMKV/settings.conf`, conservando los ajustes existentes. El valor `app_DefaultSelectionString = "+sel:all"` permite conservar las pistas durante la extracción y revisarlas después. Si el motor solicita iniciar la evaluación, indica que ha caducado o exige registrar una versión antigua, se obtiene la clave beta vigente del anuncio oficial de MakeMKV y se repite el análisis una sola vez. Requiere conexión HTTPS a `forum.makemkv.com`; no incorpora una clave fija ni modifica licencias personales. Si no se puede activar, muestra una explicación para configurar `app_Key` en ese mismo archivo. El análisis del origen muestra los mensajes del motor cuando una operación no puede completarse.

Los binarios originales se obtienen de la [distribución oficial para Linux](https://forum.makemkv.com/forum/viewtopic.php?f=3&t=224), con hashes SHA-256 verificados. Las bibliotecas OSS se compilan sin escritorio y se conservan los avisos y licencias originales en la imagen. Interfaces empleadas: [modo robot de MakeMKV](https://www.makemkv.com/developers/usage.txt) y [mkvmerge](https://mkvtoolnix.download/doc/mkvmerge.html).

## Logs en TrueNAS

Los registros salen por stdout/stderr del contenedor y se consultan en **Apps → Muxplorer → Logs** (o `docker logs <contenedor>`). Cada registro de diagnóstico ocupa una línea JSON con fecha UTC y nombre del evento. `server.ready` identifica la versión y Node; `job.queued`, `job.started`, `job.progress`, `job.result` y `job.finished` incluyen `jobId`; `process.start`, `process.running` (cada 15 segundos) y `process.exit` incluyen `processId`, duración, código y señal de salida. El progreso se registra por cambio de etapa, cada cinco puntos o cada 15 segundos; `archive.engine_progress` muestrea la consola de 7-Zip cada cinco segundos.

También se registran conexión/desconexión SSE, peticiones de escritura (ruta y estado, sin cuerpo), cancelaciones y pasos de activación de MakeMKV. No se imprimen argumentos completos, credenciales ni claves de licencia. Las rutas y nombres de los archivos sí aparecen para diagnosticar cada operación. Los logs dependen de la retención configurada en TrueNAS/Docker; no se duplican en `/config`.

El navegador sincroniza operaciones por HTTP cada dos segundos además de SSE y conserva el orden de las revisiones. La cabecera SSE desactiva el buffering en proxies compatibles. El porcentaje refleja el contador actual del motor, incluso si este retrocede entre archivos o volúmenes; no se conserva artificialmente su máximo anterior.

## Integridad, temporales y reinicios

- No se sobrescribe ningún nombre existente. En caso de conflicto, cambia el nombre o el destino. El MVP deliberadamente no ofrece reemplazo destructivo.
- En Linux, renombrados y publicación usan `renameat2(RENAME_NOREPLACE)` con directorios padre abiertos sin seguir symlinks. Un movimiento en el mismo filesystem aprovecha el renombrado.
- Entre filesystems se copia en streaming a un área privada `.muxplorer-<id>`, se sincroniza cada archivo y se verifica SHA-256 leyendo la copia. Se compara el manifiesto del origen antes de publicar y antes de eliminar. Un error conserva el origen; si el borrado final falla, el destino publicado se registra y el trabajo avisa del fallo.
- Los árboles con enlaces simbólicos, hardlinks o archivos especiales se rechazan en las operaciones recursivas. Las rutas de API son pares `{root, path}` relativos, validados estrictamente. No existe API de descarga, subida, comandos arbitrarios ni navegación por el host.
- 7-Zip se ejecuta confinado con **Landlock**, con permiso de escritura únicamente en el temporal. Se validan rutas antes y árbol después; los enlaces y nombres duplicados se rechazan. En un kernel sin aislamiento compatible la extracción falla de forma explícita. No se activa un fallback inseguro. ZIP/7z/RAR usan el motor oficial; tar.gz/tgz/tar.xz se descomprimen en dos etapas.
- Los originales del remux y MakeMKV se conservan. La salida se inspecciona con MKVToolNix y se comprueba su número de pistas antes de publicarla.
- Una selección de varios archivos/títulos puede completar algunos antes de fallar en otro. Los resultados publicados aparecen en el trabajo; no se revierten automáticamente.
- Reiniciar marca trabajos pendientes o en ejecución como **interrumpidos**. No se reintentan automáticamente. Un checkpoint de MakeMKV que ya estaba esperando revisión puede revisarse explícitamente tras el reinicio. Un análisis MKVToolNix que ya había terminado de preparar el disco conserva la elección de títulos y el contenido privado; puede continuarse explícitamente desde Operaciones. El resto debe volver a iniciarse después de inspeccionar el destino. Los temporales retenidos se limpian desde Detalles del trabajo una vez cancelado/interrumpido.
- Cancelar una CLI envía TERM y después KILL a su grupo de procesos en Linux. Copias se cancelan por streaming. La eliminación y publicación se cancelan entre elementos/etapas; un renombrado o borrado ya iniciado no se revierte.
- Concurrencia automática configurable, inicialmente 1; el botón Empezar inicia cualquier tarea en cola sin límite de operaciones simultáneas. Las mutaciones de archivos están serializadas; algunas etapas de motores distintos pueden coincidir con concurrencia 2.

Los datasets se consideran almacenamiento de confianza compartido con tus aplicaciones. Evita que otro proceso cambie simultáneamente los padres de una ruta o modifique un origen en uso. Las comprobaciones de rutas no sustituyen aislamiento frente a un usuario local hostil con permisos de modificación sobre los mismos directorios. No se han probado ACL/ZFS en el NAS real.

## Configuración

| Variable                                      | Valor por defecto en Docker           | Uso                                                                    |
| --------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `WEB_PORT`                                    | `8098`                                | Puerto publicado por Compose                                           |
| `PORT`                                        | `8098`                                | Puerto interno del backend/healthcheck                                 |
| `TZ`                                          | `Europe/Madrid`                       | Zona del servidor; la interfaz muestra fechas en la zona del navegador |
| `PUID`, `PGID`                                | `1000`, `1000`                        | Identidad del contenedor en Compose local                              |
| `DOWNLOADS_PATH`, `PLEX_PATH`                 | `./.local/downloads`, `./.local/plex` | Directorios del host en desarrollo                                     |
| `DOWNLOADS_ROOT`, `PLEX_ROOT`                 | `/data/downloads`, `/data/plex`       | Raíces internas; no cambiar en TrueNAS                                 |
| `CONFIG_DIR`                                  | `/config`                             | SQLite, administrador y configuración persistente                      |
| `JOB_CONCURRENCY`                             | `1`                                   | Concurrencia automática; inicio manual sin límite                      |
| `COOKIE_SECURE`                               | `false`                               | `true` cuando se accede mediante HTTPS                                 |
| `MAKEMKV_HOME`                                | `/config/makemkv`                     | Configuración del motor y activación                                   |
| `SEVENZIP_BIN`, `MKVMERGE_BIN`, `MAKEMKV_BIN` | `7zz`, `mkvmerge`, `makemkvcon`       | Rutas de ejecutables para desarrollo                                   |
| `SANDBOX_BIN`, `RENAME_BIN`                   | `mux-sandbox`, `mux-rename`           | Helpers Linux incluidos en la imagen                                   |
| `WEB_DIR`                                     | `/app/web`                            | Angular compilado                                                      |

Para acceso remoto utiliza un proxy HTTPS y `COOKIE_SECURE=true`. Conserva la cabecera Host original y desactiva el buffering del endpoint SSE `/api/jobs/events`. No se configura CORS abierto. Las escrituras requieren una cabecera propia y el origen se compara con Host. Sesión HttpOnly y SameSite=Strict, expiración de 12 horas; contraseña scrypt con salt individual y límite de intentos de acceso. El único endpoint público operativo es el healthcheck, además de los necesarios para configurar/iniciar sesión.

## Desarrollo y arquitectura

Requisitos sin Docker: Node **24.15+** (o Node 26), pnpm **11.25.0**. Angular 21 LTS y TypeScript 5.9 están fijados y existe lockfile. Instala los motores CLI y los helpers Linux para probar todas las operaciones fuera de Docker; para el flujo completo se recomienda Docker.

```sh
pnpm install --frozen-lockfile
```

Crea `.local/downloads` y `.local/plex` en `apps/api` si trabajas con los valores por defecto del proceso de desarrollo, o configura `DOWNLOADS_ROOT`, `PLEX_ROOT` y `CONFIG_DIR` con rutas absolutas a fixtures locales. Arranca `pnpm dev`: API en 8098, Angular en 4200 con proxy `/api`. El proxy conserva Host para la verificación de origen. No uses rutas del NAS para pruebas.

```text
apps/web/src/app/   Explorer reutilizable, selector, tabla de pistas, shell, API/SSE
apps/api/src/      auth, paths, files, archives, mkv, makemkv, jobs, store y contratos
packages/shared/   Tipos de ubicaciones, metadatos, pistas, trabajos y peticiones
docker/            Helpers Linux de publicación sin reemplazo y aislamiento Landlock
tests/             Smoke Docker y pruebas de navegador con fixtures aisladas
```

El backend sirve Angular y API desde el mismo origen. Los motores se ejecutan con `spawn` y arrays de argumentos, nunca `shell:true`. SQLite usa WAL y sincronización FULL. No hay Redis, servicios de base de datos ni dependencias de escritorio. La imagen final no incluye compiladores ni dependencias de desarrollo del monorepo.

## Pruebas

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm format:check
pnpm build
docker build -t muxplorer:0.1.5 .
pnpm test:docker
pnpm exec playwright install chromium
pnpm test:acceptance
```

`test:docker` crea un contenedor desechable con **dos tmpfs aislados** para fixtures. Verifica autenticación, CSRF, traversal/symlinks, operaciones de archivos, conflictos, extracción real ZIP/RAR/7z protegido/7z multipartes/tar.gz, remux con varias fuentes, nombres Unicode, selección de pistas y flags, SSE, historial después de reiniciar, UID sin root y healthcheck. Genera archivos pequeños y un RAR sin compresión válido; además se ha comprobado localmente la extracción de un RAR multivolumen de 256 MiB repartido en 17 partes; no accede al NAS. El contenedor se elimina al terminar. `MUXPLORER_KEEP_TEST_CONTAINER=true` permite retenerlo para depuración, con credenciales de prueba mostradas en la salida; no lo uses con datos reales.

`test:acceptance` añade diez pruebas Playwright sobre ese mismo contenedor aislado: creación inicial del administrador sin token e inicio de sesión, operaciones básicas, remux desde el diálogo con subtítulos externos, extracción con selector y multiselección/arrastre/vista móvil y disponibilidad automática de los tres motores. Guarda capturas de verificación en `test-results/visual/`. Las pruebas multimedia de navegador solo aceptan nombres de contenedor `muxplorer-smoke-*`, para impedir que su siembra de fixtures se dirija accidentalmente al despliegue de producción. `test:e2e` permite repetir las pruebas básicas contra un servidor de test configurado con `MUXPLORER_URL`, `MUXPLORER_TEST_USERNAME` y `MUXPLORER_TEST_PASSWORD`; nunca lo apuntes a producción.

La prueba unitaria del pipeline verifica checkpoint, IDs del MKV generado y revisión obligatoria. Las pruebas Docker convierten además un Blu-ray sintético descifrado de 125 segundos desde ISO y BDMV con ambos motores, incluyendo activación beta de MakeMKV, revisión y remux final. No se han validado discos comerciales protegidos ni todas las variantes de Blu-ray.

## Problemas frecuentes y límites del MVP

- **Raíz no disponible / Permission denied:** comprueba el bind mount y la identidad numérica/ACL. La aplicación no cambia permisos para corregirlos.
- **Landlock no disponible:** el host debe tenerlo habilitado. No ejecutes el contenedor privilegiado ni desactives el aislamiento de extracción como solución.
- **Ya existe el destino:** cambia nombre o ubicación. No se ofrece sobrescritura en esta versión.
- **No queda espacio:** deja espacio para temporal y resultado. MakeMKV puede necesitar aproximadamente el doble del tamaño de la salida, además de la fuente.
- **Faltan partes RAR o contraseña incorrecta:** conserva todos los volúmenes y empieza por el primero. El error y la salida del motor aparecen en el trabajo; las contraseñas se redactan y no se persisten.
- **Idioma rechazado:** utiliza un código BCP 47/ISO compatible, por ejemplo `es`, `en`, `ja` o `und`.
- **MakeMKV no encuentra títulos:** revisa licencia/activación, integridad de la ISO y estructura `BDMV/STREAM`/`BDMV/PLAYLIST`. No se accede a unidades ópticas del host.
- **Progreso de extracción:** se leen en directo las actualizaciones de consola de 7-Zip, incluidos sus redibujados. La validación, publicación y limpieza se muestran como etapas sin un porcentaje inventado. Al cancelar se retira el porcentaje incompleto; las respuestas antiguas no pueden reemplazar estados más recientes.
- **Reinicio durante operación:** revisa resultados registrados y limpia los temporales privados del trabajo antes de repetirlo. No hay reanudación automática de copias parciales.
- El explorador no calcula tamaños recursivos de carpetas, no indexa la biblioteca y no ofrece vista de miniaturas. El listado completo se ordena en memoria; no hay paginación/virtualización para carpetas con cientos de miles de entradas.
- Solo se soporta la imagen amd64 actual. No se han probado archivos de 100 GB, todos los códecs ni combinaciones de discos protegidos. El soporte de variantes depende de los motores incluidos.
- Los tests locales de Windows usan una publicación alternativa para directorios; la producción Linux usa el helper atómico y se prueba por Docker.
- No hay transcodificación, reproducción avanzada, edición por timeline, Plex/Sonarr/Radarr, multiusuario ni automatizaciones.
