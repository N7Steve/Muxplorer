# Validación del MVP — 29 de octubre de 2026

Las pruebas usan archivos temporales y contenedores desechables con dos tmpfs independientes. No se han montado ni modificado los datasets reales de TrueNAS.

| Comprobación                                            | Resultado                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                             | 34 pruebas correctas                                                                                   |
| `pnpm lint`                                             | Sin errores ni advertencias                                                                            |
| `pnpm typecheck`                                        | API y plantillas Angular correctas                                                                     |
| `pnpm format:check`                                     | Correcto                                                                                               |
| `pnpm build`                                            | NestJS y Angular compilados; frontend inicial aproximadamente 385 KB, 100 KB de transferencia estimada |
| `docker build -t muxplorer:0.1.0 .`                     | Imagen Linux amd64 construida con los tres motores y sus dependencias                                  |
| `pnpm test:acceptance`                                  | Smoke Docker y cinco pruebas de navegador correctas                                                    |
| Ambos YAML mediante `docker compose ... config --quiet` | Correctos                                                                                              |
| `docker compose up --build -d`                          | Aplicación arrancada en 8098 y healthcheck healthy                                                     |

## Pruebas de extremo a extremo

- Configuración inicial sin token mediante usuario y contraseña, acceso con ambas credenciales, persistencia de la sesión, rechazo de usuario o contraseña incorrectos, bloqueo de una segunda configuración y rutas privadas sin sesión.
- Bloqueo de escrituras sin la cabecera de protección, traversal y navegación por symlinks.
- Crear carpetas, renombrar, copiar árboles entre dos filesystems, conflictos sin sobrescritura, mover y eliminar con confirmación.
- Extracción con los ejecutables reales: ZIP, RAR sin compresión generado como fixture, 7z protegido, 7z dividido y tar.gz. Rechazo de contraseña incorrecta y tar con symlink. Contraseñas ausentes del historial.
- Remux con MKVToolNix real, fuente principal más subtítulos externos, eliminación de pista, título, nombres, idiomas, flags default/forced y orden. Rutas con acentos incluidas.
- SSE autenticado, persistencia del historial tras reiniciar, UID 1000 y healthcheck del contenedor.
- Copia de un archivo sparse cancelada: estado cancelado, origen conservado y ausencia de publicación parcial.
- Reinicio con copia activa: estado interrumpido, sin finalización falsa ni reintento automático.
- Desde el navegador: crear/renombrar/eliminar carpeta, menús contextuales multimedia, añadir subtítulos mediante selector, crear MKV y comprobar resultado en el otro panel, extraer mediante diálogo, multiselección, arrastrar entre paneles con elección explícita y layout móvil sin desbordamiento horizontal.

Las capturas inspeccionadas están en `test-results/visual/`: explorador, remux, extracción y móvil. Se regeneran con `pnpm test:acceptance`; no son pantallas estáticas del producto.

## Alcance de las pruebas de MakeMKV

Se verifican con fixtures/mocks el parser robot, los prefijos ISO/BDMV, la construcción del flujo, el checkpoint persistente, la revisión obligatoria de IDs del MKV generado, el remux final y la publicación/limpieza. La imagen contiene MakeMKV 2.0.0, sus bibliotecas compiladas y el EULA íntegro. La aplicación no lo ejecuta antes de la aceptación del propietario.

**No se ha validado la conversión completa de una ISO/BDMV real con MakeMKV activado.** Tampoco se han verificado discos protegidos, archivos de 100 GB, RAR multipartes reales ni permisos/ACL/ZFS del NAS. Estos puntos requieren validación adicional en el entorno correspondiente. El README recoge estas limitaciones y los pasos de licencia/activación y despliegue.

La validación se realiza localmente y no requiere publicar imágenes en registros externos.
