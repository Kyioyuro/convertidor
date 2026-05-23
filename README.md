# PDF Cambio

Convertidor web de PDF a DOCX, JPG y PNG con plan gratis limitado y plan Pro de $79 MXN al mes.

## Ejecutar localmente

```powershell
npm install
npm start
```

Abre `http://localhost:3000`.

## Variables para produccion

- `PORT`: puerto asignado por el hosting.
- `HOST`: host de escucha. Por defecto usa `0.0.0.0`.
- `SITE_URL`: dominio publico, por ejemplo `https://tudominio.com`.

Ejemplo:

```powershell
$env:SITE_URL="https://tudominio.com"
npm start
```

## Antes de publicar

1. Cambiar `SITE_URL` por el dominio real en el hosting.
2. Revisar `privacidad.html` y `terminos.html` con datos reales de contacto.
3. Conectar pagos reales para el plan Pro.
4. Guardar limites por usuario, IP o cuenta en una base de datos.
5. Activar Google AdSense solo cuando la web tenga dominio, contenido legal y trafico inicial.

## Limitaciones actuales

- PDF a DOCX extrae texto seleccionable; PDFs escaneados requieren OCR futuro.
- El plan Pro esta en modo demostracion en el navegador.
- Los limites gratis viven en la sesion del navegador; para produccion deben moverse al servidor.
