# Cambios

## 0.1.1

- MakeMKV se instala con permisos de ejecución correctos y queda habilitado desde el primer arranque. Se elimina el diálogo adicional de aceptación y el aviso de instalación manual.
- La imagen se comprueba ejecutando MakeMKV como usuario sin privilegios; las pruebas de Docker y navegador verifican que aparece disponible automáticamente.
- Se leen en directo los porcentajes que 7-Zip redibuja sobre la misma línea y se descartan valores atrasados o porcentajes que forman parte de un nombre de archivo.
- La validación, publicación y limpieza de una extracción se muestran como etapas independientes sin un porcentaje estimado.
- Al cancelar se retira el porcentaje incompleto y se muestra la cancelación como un estado normal, sin un falso error.
- Las respuestas HTTP antiguas no pueden sustituir el progreso ni el estado recibido después por SSE.
- Las imágenes validadas se publican con una etiqueta de versión, además de `latest` y la etiqueta del commit.
