# Cambios

## 0.1.5

- Revisión de pistas por grupos plegables de vídeo, audio y subtítulos, con tipografía mayor y sin repetir el archivo de origen en cada fila.
- Borrado de todos los nombres de pista desde el pie de la modal, banderas de idioma y logos de códec del skin Kodi Aeon Nox SiLVO. Nombre del códec arriba y logo con canales debajo, sin número de pista visible.
- Extensión `.mkv` automática en los campos de salida de revisión y remux; eliminados los avisos redundantes de la modal.
- Inicio manual sin límite de tareas simultáneas; eliminado el bloqueo al pulsar Empezar con dos trabajos activos.
- Concurrencia automática sin máximo fijo y cola sin el anterior tope de 100 trabajos. La planificación no depende del límite visual del historial.

## 0.1.4

- Preparación de ISO/BDMV con MKVToolNix en la cola de operaciones, con progreso, cancelación y reapertura para elegir títulos.
- La preparación ISO se conserva y reutiliza al crear los MKV para evitar una segunda extracción completa.
- Botón Empezar para ejecutar manualmente una segunda tarea, respetando un máximo de dos activas.
- Revisión de pistas editable con teclado: corregido el manejador del fondo del diálogo que impedía enfocar los campos, además de evitar controles de foco simultáneos.
- Tipografía más grande y textos de pistas con mayor contraste.
- Icono para retirar operaciones terminadas de la lista, con limpieza de temporales y conservación del resultado y del historial.

## 0.1.3

- Dos opciones para ISO/BDMV: MKVToolNix 103.0 sobre fuentes descifradas (con capítulos MPLS) y MakeMKV.
- MakeMKV fijado a 1.18.4 para evitar la regresión Linux de 2.0.0 al abrir Blu-ray desde archivos; recuperación de activación también tras salida anormal o aviso de versión antigua.
- Progreso actualizado por HTTP cada dos segundos además de SSE, sin retener el máximo anterior si 7-Zip reinicia su contador.
- Logs JSON de servidor, operaciones, procesos, progreso y activación, con credenciales redactadas.
- Pruebas reales de ambos motores desde ISO y BDMV, revisión de pistas y publicación, con un Blu-ray sintético incluido en el repositorio.

## 0.1.2

- Progreso de extracción en directo sin esperar al siguiente redibujado y eventos SSE independientes para cada actualización.
- Activación beta de MakeMKV desde su anuncio oficial al detectar evaluación pendiente o caducada, conservando licencias personales.
- Botones laterales del ratón para navegar por el historial del panel y de los selectores sin salir de la aplicación.

## 0.1.1

- MakeMKV se instala con permisos de ejecución correctos y queda habilitado desde el primer arranque. Se elimina el diálogo adicional de aceptación y el aviso de instalación manual.
- La imagen se comprueba ejecutando MakeMKV como usuario sin privilegios; las pruebas de Docker y navegador verifican que aparece disponible automáticamente.
- Se leen en directo los porcentajes que 7-Zip redibuja sobre la misma línea y se descartan valores atrasados o porcentajes que forman parte de un nombre de archivo.
- La validación, publicación y limpieza de una extracción se muestran como etapas independientes sin un porcentaje estimado.
- Al cancelar se retira el porcentaje incompleto y se muestra la cancelación como un estado normal, sin un falso error.
- Las respuestas HTTP antiguas no pueden sustituir el progreso ni el estado recibido después por SSE.
- Las imágenes validadas se publican con una etiqueta de versión, además de `latest` y la etiqueta del commit.
