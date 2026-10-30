# MediaInfo rápido

Clic derecho sobre un archivo de vídeo o audio → **Ver MediaInfo**. Muestra contenedor, tamaño, duración, bitrate total y un resumen de cada pista. El vídeo incluye códec/perfil, bitrate de vídeo, resolución, HDR, fotogramas, profundidad y color. El audio incluye idioma, título, códec/perfil, bitrate, canales, distribución y frecuencia.

El HDR procede de los metadatos que comunica MediaInfo: Dolby Vision con su perfil, HDR10, HDR10+ y HLG, incluyendo combinaciones. No se deduce del nombre ni de tener 10 bits. Los datos ausentes aparecen como «No informado»; no se sustituye el bitrate de vídeo por el total ni se inventan bitrates de pistas.

Usa **Minimizar a Operaciones**, cierra el panel de operaciones y abre el menú de otro archivo → **Añadir a comparación**. También puedes seleccionar dos archivos y elegir **Comparar MediaInfo** directamente. La tabla resalta los campos distintos y ofrece **Solo diferencias**. Puedes quitar uno de los archivos para comparar con otro. Las pistas se comparan por posición y muestran idioma y título para identificarlas; no se afirma que sean pistas equivalentes. El bitrate y el códec ayudan a comparar, pero no establecen por sí solos una clasificación de calidad visual.

La consulta continúa al cerrar o minimizar el diálogo. Operaciones permite recuperarla o quitarla. Los resúmenes viven en la sesión de la página y se pierden al recargar. No se modifican los archivos originales. El análisis tiene un límite de 60 segundos y rechaza archivos que cambien durante la lectura.

La imagen Docker incluye el ejecutable `mediainfo`. Para desarrollo sin Docker, instálalo y, si no está en PATH, configura `MEDIAINFO_BIN`. El endpoint autenticado `POST /api/media/summary` recibe una ubicación `{root, path}` con las mismas validaciones de rutas y bloqueos de archivos en uso que el inspector existente.

Los campos se interpretan siguiendo la [documentación oficial de MediaInfo](https://mediaarea.net/en/MediaInfo/Support/Fields).
