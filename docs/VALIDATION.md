# Validación del MVP — 29 de octubre de 2026

Las pruebas usan archivos temporales y contenedores desechables con dos tmpfs independientes. No se han montado ni modificado los datasets reales de TrueNAS.

| Comprobación                                            | Resultado                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                             | 43 pruebas correctas                                                                                   |
| `pnpm lint`                                             | Sin errores ni advertencias                                                                            |
| `pnpm typecheck`                                        | API y plantillas Angular correctas                                                                     |
| `pnpm format:check`                                     | Correcto                                                                                               |
| `pnpm build`                                            | NestJS y Angular compilados; frontend inicial aproximadamente 385 KB, 100 KB de transferencia estimada |
| `docker build -t muxplorer:0.1.5 .`                     | Imagen Linux amd64 construida con los tres motores y sus dependencias                                  |
| `pnpm test:acceptance`                                  | Smoke Docker y diez pruebas de navegador correctas                                                     |
| Ambos YAML mediante `docker compose ... config --quiet` | Correctos                                                                                              |
| Healthcheck del contenedor de pruebas                   | Estado healthy tras ejecutar operaciones y reiniciar el contenedor                                     |

## Cambios 0.1.5

- Empezar no limita las tareas simultáneas. Se comprueban tres trabajos activos y el botón disponible con dos en ejecución.
- JOB_CONCURRENCY admite cualquier entero positivo para la cola automática, conservando el valor predeterminado 1.
- La cola no tiene el anterior tope de 100 trabajos; su planificación y recuperación tras reinicio se consultan por separado del historial visible de 500 registros. Se verifica iniciar un pendiente que ha quedado fuera de ese historial.

## Mejoras 0.1.4

- Preparación real de ISO/BDMV como operación en segundo plano, selección posterior de títulos y continuidad del mismo trabajo hasta la revisión y publicación. Se comprueba en los logs que la ISO se extrae una sola vez.
- Cancelación de una preparación lista, eliminación de su caché y retirada de la operación sin eliminar la ISO original.
- Inicio manual de una tarea mientras otra sigue activa, inicio de una tercera simultánea y persistencia de la retirada en SQLite.
- Elección de títulos preparada conservada tras reinicio y reanudación explícita del mismo trabajo.
- Navegador: pasar análisis a segundo plano, reabrir, elegir título, revisar pistas, escribir un nombre con el teclado y vaciar otro, comprobar los nombres reales del MKV y retirar la operación de forma persistente sin borrar el resultado.
- Navegador: botón Empezar disponible con dos tareas activas; diseño de escritorio y móvil con fuentes mayores. Captura `test-results/visual/review-editable.png`.

## Correcciones 0.1.2

- Porcentaje completo sin delimitador final (también dividido entre chunks) y eventos SSE que conservan el valor y estado de cada actualización.
- Botones físicos atrás/adelante enviados a Chromium mediante CDP: navegan una sola vez por el panel bajo el cursor y conservan la ubicación del otro panel.
- Activación beta simulada: obtiene la clave del anuncio oficial, conserva los ajustes y repite el análisis; protege las licencias personales y conserva la configuración si la descarga falla. Se comprobó además desde la imagen Docker el acceso HTTPS al anuncio oficial y la presencia de una clave con el formato esperado.

## Pruebas de extremo a extremo

- Configuración inicial sin token mediante usuario y contraseña, acceso con ambas credenciales, persistencia de la sesión, rechazo de usuario o contraseña incorrectos, bloqueo de una segunda configuración y rutas privadas sin sesión.
- Bloqueo de escrituras sin la cabecera de protección, traversal y navegación por symlinks.
- Crear carpetas, renombrar, copiar árboles entre dos filesystems, conflictos sin sobrescritura, mover y eliminar con confirmación.
- Extracción con los ejecutables reales: ZIP, RAR sin compresión generado como fixture, 7z protegido, 7z dividido y tar.gz. Rechazo de contraseña incorrecta y tar con symlink. Contraseñas ausentes del historial.
- Remux con MKVToolNix real, fuente principal más subtítulos externos, eliminación de pista, título, nombres, idiomas, flags default/forced y orden. Rutas con acentos incluidas.
- SSE autenticado, persistencia del historial tras reiniciar, UID 1000 y healthcheck del contenedor.
- Copia de un archivo sparse cancelada: estado cancelado, origen conservado y ausencia de publicación parcial.
- Reinicio con copia activa: estado interrumpido, sin finalización falsa ni reintento automático.
- Extracción real de un RAR multivolumen generado como fixture: 256 MiB en 17 partes. Se verificó que 7-Zip puede finalizar sin emitir 100%, y que sus porcentajes se actualizan con retrocesos de consola.
- Progreso de 7-Zip con redibujados por retroceso, seguimiento del contador actual incluso tras reinicios, snapshots HTTP posteriores a eventos SSE, etapas finales explícitas y cancelación sin porcentaje obsoleto.
- Desde el navegador: crear/renombrar/eliminar carpeta, menús contextuales multimedia, añadir subtítulos mediante selector, crear MKV y comprobar resultado en el otro panel, extraer mediante diálogo, multiselección, arrastrar entre paneles con elección explícita y layout móvil sin desbordamiento horizontal.

Las capturas inspeccionadas están en `test-results/visual/`: explorador, remux, extracción y móvil. Se regeneran con `pnpm test:acceptance`; no son pantallas estáticas del producto.

## Motores de disco en 0.1.3

Se verifican ISO y BDMV con un Blu-ray sintético de 125 segundos (AVC + AC3), tanto en MKVToolNix como en MakeMKV 1.18.4. Cada variante se analiza, extrae, espera la revisión obligatoria, remultiplexa y publica; se comprueba el número de pistas revisadas y la limpieza de temporales de ISO. Los fixtures están en `tests/fixtures/disc.zip` y su origen está documentado en esa carpeta.

La regresión de MakeMKV 2.0.0 se reprodujo al abrir la carpeta/ISO en un contenedor desechable (SIGSEGV). Con 1.18.4, sus bibliotecas y datos de la misma versión, se comprueba activación beta tras código 253 y conversión completa del fixture. Los tests unitarios cubren recuperación tras salida 139 y protección de licencias personales.

El navegador prueba las dos opciones del menú y la actualización 98 → 17 → 46 cuando una conexión SSE abierta no entrega datos. Se comprueba también la redacción de contraseñas y claves beta en logs correlacionados por proceso.

No se han verificado discos comerciales protegidos, todas las variantes Blu-ray/DVD, archivos de 100 GB ni permisos/ACL/ZFS del NAS. No se ha reproducido con el archivo concreto del NAS el 98% retenido; los logs y la sincronización HTTP permiten contrastar su contador real con la pantalla.
