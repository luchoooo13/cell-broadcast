# Cell Broadcast

Sistema de difusión geolocalizada de alertas de emergencia inspirado en
**CMAS / WEA** (Wireless Emergency Alerts). Permite que cualquier usuario
registre su posición en un mapa y que una autoridad emita una alerta sobre
un **radio geográfico**; todos los suscriptores dentro del radio reciben la
notificación **en tiempo real** por WebSocket.

### Demo

- **Frontend**: https://cell-broadcast-app-2l7rqaxy.devinapps.com
- **Backend** (FastAPI): https://app-sshfqgti.fly.dev
- **Docs OpenAPI**: https://app-sshfqgti.fly.dev/docs

### Stack

| Capa       | Tecnología                                                        |
|------------|-------------------------------------------------------------------|
| Backend    | FastAPI + SQLite + WebSocket (Python 3.12, Poetry)                |
| Frontend   | Vite + React + TypeScript + Tailwind + Leaflet + lucide-react     |
| Deploy     | Backend en Fly.io (volumen `/data` para SQLite), frontend estático|

### Categorías de alerta

Siguen el modelo CMAS/WEA:

| ID                 | Nombre              | Opt-out |
|--------------------|---------------------|---------|
| `presidencial`     | Alerta Presidencial | ❌ (obligatoria) |
| `amenaza_extrema`  | Amenaza Extrema     | ✅      |
| `amenaza_severa`   | Amenaza Severa      | ✅      |
| `amber`            | Alerta AMBER        | ✅      |
| `prueba`           | Prueba del Sistema  | ✅      |

### Flujo

1. **Registro**: un usuario entra a la app, hace click en el mapa para marcar
   su posición y se suscribe.
2. **Suscripción en vivo**: el cliente abre un WebSocket en `/ws/{subscriber_id}`
   y queda esperando alertas.
3. **Emisión**: una autoridad (pestaña "Soy autoridad") elige categoría,
   título, mensaje, instrucciones, emisor y **centro + radio** (click en el
   mapa + slider). Al emitir, el backend:
   - Persiste la alerta en SQLite.
   - Calcula qué suscriptores caen dentro del radio (Haversine).
   - Envía push inmediato a cada uno por WebSocket.
4. **Recepción**: el suscriptor ve un banner inmediato + notificación del
   navegador. Historial completo disponible en la pestaña "Historial".

### API

| Método | Endpoint                              | Descripción                                     |
|--------|---------------------------------------|-------------------------------------------------|
| GET    | `/healthz`                            | Healthcheck                                     |
| GET    | `/categories`                         | Lista de categorías soportadas                  |
| POST   | `/subscribers`                        | Registrar un suscriptor (`name`, `lat`, `lon`)  |
| GET    | `/subscribers`                        | Listar todos los suscriptores                   |
| PATCH  | `/subscribers/{id}`                   | Actualizar ubicación                            |
| DELETE | `/subscribers/{id}`                   | Baja                                            |
| POST   | `/alerts`                             | Emitir Cell Broadcast                           |
| GET    | `/alerts`                             | Historial (`?limit=N`)                          |
| GET    | `/alerts/{id}`                        | Detalle + destinatarios                         |
| GET    | `/subscribers/{id}/alerts`            | Alertas recibidas por ese suscriptor            |
| WS     | `/ws/{subscriber_id}`                 | Canal de push en tiempo real                    |

### Autorización (opcional)

Si definís la variable de entorno `CB_ADMIN_TOKEN` en el backend, el endpoint
`POST /alerts` exige que el body incluya ese token en el campo `admin_token`.
Si está vacía (modo simulador), la emisión es libre.

### Desarrollo local

```bash
# Backend
cd backend
poetry install
poetry run fastapi dev app/main.py  # http://localhost:8000

# Frontend
cd frontend
npm install --legacy-peer-deps
echo "VITE_API_URL=http://localhost:8000" > .env
npm run dev  # http://localhost:5173
```

### Estructura

```
cell-broadcast/
├── backend/              # FastAPI + SQLite
│   ├── app/main.py       # Toda la lógica: endpoints + WS hub + Haversine
│   └── pyproject.toml
└── frontend/             # React + Leaflet (Vite)
    ├── src/App.tsx
    └── src/App.css
```

### Créditos

Proyecto generado con asistencia de [Devin](https://app.devin.ai) para
[Lucho](https://github.com/luchoooo13).
