"""Cell Broadcast backend.

Simulates a CMAS/WEA-style cell broadcast system:
- Subscribers register a geographic position.
- Authorities emit alerts with a center + radius (the "cell").
- All subscribers inside the radius receive the alert via WebSocket push.
- Alerts and subscribers are persisted in SQLite.
"""

from __future__ import annotations

import asyncio
import math
import os
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ─── STORAGE ──────────────────────────────────────────────────────────────────
DB_PATH = os.environ.get("CB_DB_PATH", "/data/app.db")
if not os.path.isdir(os.path.dirname(DB_PATH)):
    # Fallback to local file when the /data volume is not mounted (local dev).
    DB_PATH = os.environ.get("CB_DB_PATH_LOCAL", "./cell_broadcast.db")

# Admin token for emitting alerts. If unset, emission is unrestricted
# (useful for the simulator; set CB_ADMIN_TOKEN in prod to require it).
ADMIN_TOKEN = os.environ.get("CB_ADMIN_TOKEN", "")

CATEGORIES: dict[str, dict[str, Any]] = {
    "presidencial":     {"name": "Alerta Presidencial",  "priority": "MAX",     "opt_out": False},
    "amenaza_extrema":  {"name": "Amenaza Extrema",      "priority": "EXTREME", "opt_out": True},
    "amenaza_severa":   {"name": "Amenaza Severa",       "priority": "SEVERE",  "opt_out": True},
    "amber":            {"name": "Alerta AMBER",         "priority": "AMBER",   "opt_out": True},
    "prueba":           {"name": "Prueba del Sistema",   "priority": "TEST",    "opt_out": True},
}


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _init_db() -> None:
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS subscribers (
              id          TEXT PRIMARY KEY,
              name        TEXT NOT NULL,
              lat         REAL NOT NULL,
              lon         REAL NOT NULL,
              created_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS alerts (
              id             TEXT PRIMARY KEY,
              category       TEXT NOT NULL,
              title          TEXT NOT NULL,
              message        TEXT NOT NULL,
              instructions   TEXT,
              center_lat     REAL NOT NULL,
              center_lon     REAL NOT NULL,
              radius_km      REAL NOT NULL,
              area_name      TEXT NOT NULL,
              sender         TEXT NOT NULL,
              reached_count  INTEGER NOT NULL DEFAULT 0,
              created_at     INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS alert_recipients (
              alert_id       TEXT NOT NULL,
              subscriber_id  TEXT NOT NULL,
              distance_km    REAL NOT NULL,
              PRIMARY KEY (alert_id, subscriber_id),
              FOREIGN KEY (alert_id)      REFERENCES alerts(id)      ON DELETE CASCADE,
              FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_alerts_created_at
              ON alerts(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_recipients_subscriber
              ON alert_recipients(subscriber_id);
            """
        )


# ─── WEBSOCKET HUB ────────────────────────────────────────────────────────────
class Hub:
    """In-process registry of WebSocket connections per subscriber."""

    def __init__(self) -> None:
        self._subs: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, subscriber_id: str, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._subs.setdefault(subscriber_id, set()).add(ws)

    async def disconnect(self, subscriber_id: str, ws: WebSocket) -> None:
        async with self._lock:
            peers = self._subs.get(subscriber_id)
            if peers is not None:
                peers.discard(ws)
                if not peers:
                    self._subs.pop(subscriber_id, None)

    async def send(self, subscriber_id: str, payload: dict[str, Any]) -> int:
        async with self._lock:
            peers = list(self._subs.get(subscriber_id, ()))
        delivered = 0
        for ws in peers:
            try:
                await ws.send_json(payload)
                delivered += 1
            except Exception:
                await self.disconnect(subscriber_id, ws)
        return delivered


hub = Hub()


# ─── UTILS ────────────────────────────────────────────────────────────────────
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _row(row: sqlite3.Row) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


# ─── LIFECYCLE ────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_: FastAPI):
    _init_db()
    yield


app = FastAPI(title="Cell Broadcast API", version="1.0.0", lifespan=lifespan)

# Disable CORS. Do not remove this for full-stack development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods
    allow_headers=["*"],  # Allows all headers
)


# ─── MODELS ───────────────────────────────────────────────────────────────────
class SubscriberIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class SubscriberOut(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    created_at: int


class SubscriberUpdate(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class AlertIn(BaseModel):
    category: str
    title: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=2000)
    instructions: str | None = Field(default=None, max_length=2000)
    center_lat: float = Field(ge=-90, le=90)
    center_lon: float = Field(ge=-180, le=180)
    radius_km: float = Field(gt=0, le=2000)
    area_name: str = Field(min_length=1, max_length=120)
    sender: str = Field(min_length=1, max_length=120)
    admin_token: str | None = None


class AlertOut(BaseModel):
    id: str
    category: str
    category_name: str
    title: str
    message: str
    instructions: str | None
    center_lat: float
    center_lon: float
    radius_km: float
    area_name: str
    sender: str
    reached_count: int
    created_at: int


# ─── ROUTES ───────────────────────────────────────────────────────────────────
@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"status": "ok", "db": DB_PATH}


@app.get("/categories")
async def list_categories() -> dict[str, Any]:
    return {"categories": CATEGORIES}


# ── Subscribers ────────────────────────────────────────────────────────────────
@app.post("/subscribers", response_model=SubscriberOut, status_code=201)
async def create_subscriber(body: SubscriberIn) -> dict[str, Any]:
    sid = uuid.uuid4().hex
    now = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            "INSERT INTO subscribers(id,name,lat,lon,created_at) VALUES (?,?,?,?,?)",
            (sid, body.name.strip(), body.lat, body.lon, now),
        )
    return {"id": sid, "name": body.name.strip(), "lat": body.lat, "lon": body.lon, "created_at": now}


@app.get("/subscribers", response_model=list[SubscriberOut])
async def list_subscribers() -> list[dict[str, Any]]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM subscribers ORDER BY created_at DESC").fetchall()
    return [_row(r) for r in rows]


@app.get("/subscribers/{sid}", response_model=SubscriberOut)
async def get_subscriber(sid: str) -> dict[str, Any]:
    with _conn() as c:
        row = c.execute("SELECT * FROM subscribers WHERE id = ?", (sid,)).fetchone()
    if not row:
        raise HTTPException(404, "subscriber not found")
    return _row(row)


@app.patch("/subscribers/{sid}", response_model=SubscriberOut)
async def update_subscriber(sid: str, body: SubscriberUpdate) -> dict[str, Any]:
    with _conn() as c:
        row = c.execute("SELECT * FROM subscribers WHERE id = ?", (sid,)).fetchone()
        if not row:
            raise HTTPException(404, "subscriber not found")
        c.execute("UPDATE subscribers SET lat = ?, lon = ? WHERE id = ?", (body.lat, body.lon, sid))
        row = c.execute("SELECT * FROM subscribers WHERE id = ?", (sid,)).fetchone()
    return _row(row)


@app.delete("/subscribers/{sid}", status_code=204)
async def delete_subscriber(sid: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM subscribers WHERE id = ?", (sid,))


# ── Alerts ─────────────────────────────────────────────────────────────────────
def _alert_out(row: sqlite3.Row) -> dict[str, Any]:
    data = _row(row)
    data["category_name"] = CATEGORIES.get(data["category"], {}).get("name", data["category"])
    return data


@app.post("/alerts", status_code=201)
async def create_alert(body: AlertIn) -> dict[str, Any]:
    if body.category not in CATEGORIES:
        raise HTTPException(400, f"unknown category: {body.category}")
    if ADMIN_TOKEN and body.admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "invalid admin token")

    aid = uuid.uuid4().hex
    now = int(time.time() * 1000)

    with _conn() as c:
        subs = c.execute("SELECT id, name, lat, lon FROM subscribers").fetchall()
        recipients = []
        for s in subs:
            d = haversine_km(body.center_lat, body.center_lon, s["lat"], s["lon"])
            if d <= body.radius_km:
                recipients.append((s["id"], s["name"], round(d, 2)))

        c.execute(
            """INSERT INTO alerts
               (id, category, title, message, instructions,
                center_lat, center_lon, radius_km, area_name, sender,
                reached_count, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                aid, body.category, body.title, body.message, body.instructions,
                body.center_lat, body.center_lon, body.radius_km, body.area_name, body.sender,
                len(recipients), now,
            ),
        )
        if recipients:
            c.executemany(
                "INSERT INTO alert_recipients(alert_id, subscriber_id, distance_km) VALUES (?,?,?)",
                [(aid, rid, dist) for (rid, _name, dist) in recipients],
            )

        alert_row = c.execute("SELECT * FROM alerts WHERE id = ?", (aid,)).fetchone()

    alert = _alert_out(alert_row)
    # Real-time push to every subscriber inside the cell.
    delivered = 0
    for rid, _name, dist in recipients:
        delivered += await hub.send(rid, {"type": "alert", "distance_km": dist, "alert": alert})

    return {
        "alert": alert,
        "reached": [{"id": r[0], "name": r[1], "distance_km": r[2]} for r in recipients],
        "websocket_deliveries": delivered,
    }


@app.get("/alerts", response_model=list[AlertOut])
async def list_alerts(limit: int = 50) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 500))
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_alert_out(r) for r in rows]


@app.get("/alerts/{aid}")
async def get_alert(aid: str) -> dict[str, Any]:
    with _conn() as c:
        row = c.execute("SELECT * FROM alerts WHERE id = ?", (aid,)).fetchone()
        if not row:
            raise HTTPException(404, "alert not found")
        recipients = c.execute(
            """SELECT ar.subscriber_id AS id, s.name, ar.distance_km
               FROM alert_recipients ar
               JOIN subscribers s ON s.id = ar.subscriber_id
               WHERE ar.alert_id = ?
               ORDER BY ar.distance_km ASC""",
            (aid,),
        ).fetchall()
    return {"alert": _alert_out(row), "recipients": [_row(r) for r in recipients]}


@app.get("/subscribers/{sid}/alerts", response_model=list[AlertOut])
async def alerts_for_subscriber(sid: str, limit: int = 50) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 500))
    with _conn() as c:
        if not c.execute("SELECT 1 FROM subscribers WHERE id = ?", (sid,)).fetchone():
            raise HTTPException(404, "subscriber not found")
        rows = c.execute(
            """SELECT a.*
               FROM alerts a
               JOIN alert_recipients ar ON ar.alert_id = a.id
               WHERE ar.subscriber_id = ?
               ORDER BY a.created_at DESC LIMIT ?""",
            (sid, limit),
        ).fetchall()
    return [_alert_out(r) for r in rows]


# ── WebSocket push for real-time alerts ───────────────────────────────────────
@app.websocket("/ws/{subscriber_id}")
async def ws_endpoint(ws: WebSocket, subscriber_id: str) -> None:
    with _conn() as c:
        exists = c.execute("SELECT 1 FROM subscribers WHERE id = ?", (subscriber_id,)).fetchone()
    if not exists:
        await ws.close(code=4404)
        return
    await hub.connect(subscriber_id, ws)
    try:
        await ws.send_json({"type": "hello", "subscriber_id": subscriber_id})
        while True:
            # We don't expect client messages, but keep the connection open.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(subscriber_id, ws)
