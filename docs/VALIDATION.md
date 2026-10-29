# Validación del MVP — 29 de octubre de 2026

Las pruebas usan archivos temporales y contenedores desechables con dos tmpfs independientes. No se han montado ni modificado los datasets reales de TrueNAS.

| Comprobación                                            | Resultado                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                             | 39 pruebas correctas                                                                                   |
| `pnpm lint`                                             | Sin errores ni advertencias                                                                            |
| `pnpm typecheck`                                        | API y plantillas Angular correctas                                                                     |
| `pnpm format:check`                                     | Correcto                                                                                               |
| `pnpm build`                                            | NestJS y Angular compilados; frontend inicial aproximadamente 385 KB, 100 KB de transferencia estimada |
| `docker build -t muxplorer:0.1.2 .`                     | Imagen Linux amd64 construida con los tres motores y sus dependencias                                  |
| `pnpm test:acceptance`                                  | Smoke Docker y seis pruebas de navegador correctas                                                     |
| Ambos YAML mediante `docker compose ... config --quiet` | Correctos                                                                                              |
| `docker compose up --build -d`                          | Aplicación arrancada en 8098 y healthcheck healthy                                                     |

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
- Progreso de 7-Zip con redibujados por retroceso, rechazo de porcentajes atrasados, snapshots HTTP posteriores a eventos SSE, etapas finales explícitas y cancelación sin porcentaje obsoleto.
- Desde el navegador: crear/renombrar/eliminar carpeta, menús contextuales multimedia, añadir subtítulos mediante selector, crear MKV y comprobar resultado en el otro panel, extraer mediante diálogo, multiselección, arrastrar entre paneles con elección explícita y layout móvil sin desbordamiento horizontal.

Las capturas inspeccionadas están en `test-results/visual/`: explorador, remux, extracción y móvil. Se regeneran con `pnpm test:acceptance`; no son pantallas estáticas del producto.

## Alcance de las pruebas de MakeMKV

Se verifican con fixtures/mocks el parser robot, los prefijos ISO/BDMV, la construcción del flujo, el checkpoint persistente, la revisión obligatoria de IDs del MKV generado, el remux final y la publicación/limpieza. La imagen contiene MakeMKV 2.0.0, sus bibliotecas compiladas y el EULA íntegro. Desde 0.1.1 se verifica que MakeMKV es ejecutable como UID 1000 y aparece disponible automáticamente, sin una pantalla de aceptación.

**No se ha validado la conversión completa de una ISO/BDMV real con MakeMKV activado.** Tampoco se han verificado discos protegidos, archivos de 100 GB ni permisos/ACL/ZFS del NAS. Estos puntos requieren validación adicional en el entorno correspondiente. El README recoge estas limitaciones y los pasos de despliegue.

La validación se realiza localmente y no requiere publicar imágenes en registros externos.
