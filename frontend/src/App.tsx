import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Circle, Popup, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import {
  Radio, Users, Siren, History, MapPin, Send, Plus, Trash2, X,
  ShieldAlert, AlertTriangle, Baby, FlaskConical, Megaphone,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Fix default Leaflet marker icons when bundled.
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon   from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl:       markerIcon,
  shadowUrl:     markerShadow,
});

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const WS_URL  = API_URL.replace(/^http/, "ws");

// ─── Types ────────────────────────────────────────────────────────────────────
type Category = "presidencial" | "amenaza_extrema" | "amenaza_severa" | "amber" | "prueba";

interface Subscriber {
  id: string;
  name: string;
  lat: number;
  lon: number;
  created_at: number;
}

interface Alert {
  id: string;
  category: Category;
  category_name: string;
  title: string;
  message: string;
  instructions: string | null;
  center_lat: number;
  center_lon: number;
  radius_km: number;
  area_name: string;
  sender: string;
  reached_count: number;
  created_at: number;
}

const CATEGORY_META: Record<Category, { label: string; color: string; bg: string; ring: string; icon: LucideIcon }> = {
  presidencial:    { label: "Presidencial",    color: "#6366F1", bg: "bg-indigo-500/10",  ring: "ring-indigo-500",  icon: ShieldAlert  },
  amenaza_extrema: { label: "Amenaza Extrema", color: "#EF4444", bg: "bg-red-500/10",     ring: "ring-red-500",     icon: Siren        },
  amenaza_severa:  { label: "Amenaza Severa",  color: "#F97316", bg: "bg-orange-500/10",  ring: "ring-orange-500",  icon: AlertTriangle },
  amber:           { label: "AMBER",           color: "#EAB308", bg: "bg-yellow-500/10",  ring: "ring-yellow-500",  icon: Baby         },
  prueba:          { label: "Prueba",          color: "#9CA3AF", bg: "bg-slate-500/10",   ring: "ring-slate-500",   icon: FlaskConical },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  if (r.status === 204) return undefined as T;
  return r.json();
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { hour12: false });
}

function relTime(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60)   return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.round(s / 60)}m`;
  if (s < 86400) return `hace ${Math.round(s / 3600)}h`;
  return formatTime(ts);
}

// Custom divicon for subscribers.
function subscriberIcon(active: boolean) {
  return L.divIcon({
    className: "",
    html: `<div style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;background:${active ? "#22c55e" : "#38bdf8"};box-shadow:0 0 0 3px ${active ? "rgba(34,197,94,.25)" : "rgba(56,189,248,.25)"};border:2px solid #0b1220;"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// ─── Map click handler ───────────────────────────────────────────────────────
function ClickHandler({ onClick }: { onClick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FlyTo({ lat, lon, zoom }: { lat?: number | null; lon?: number | null; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    if (lat != null && lon != null) map.flyTo([lat, lon], zoom ?? map.getZoom(), { duration: 0.8 });
  }, [lat, lon, zoom, map]);
  return null;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
type Mode = "suscriptor" | "autoridad" | "historial";

export default function App() {
  const [mode, setMode] = useState<Mode>("suscriptor");
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [alerts,      setAlerts]      = useState<Alert[]>([]);
  const [me,          setMe]          = useState<Subscriber | null>(null);
  const [toast,       setToast]       = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [incoming,    setIncoming]    = useState<Alert | null>(null);

  // Subscribe flow
  const [subName, setSubName] = useState("");
  const [pendingSubPoint, setPendingSubPoint] = useState<{ lat: number; lon: number } | null>(null);

  // Admin flow
  const [cbCategory,     setCbCategory]     = useState<Category>("amenaza_severa");
  const [cbTitle,        setCbTitle]        = useState("");
  const [cbMessage,      setCbMessage]      = useState("");
  const [cbInstructions, setCbInstructions] = useState("");
  const [cbAreaName,     setCbAreaName]     = useState("");
  const [cbRadiusKm,     setCbRadiusKm]     = useState(5);
  const [cbCenter,       setCbCenter]       = useState<{ lat: number; lon: number } | null>(null);
  const [cbSender,       setCbSender]       = useState("Defensa Civil");
  const [sending,        setSending]        = useState(false);
  const [lastEmitted,    setLastEmitted]    = useState<{ alert: Alert; reached: { id: string; name: string; distance_km: number }[] } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  const refreshAll = async () => {
    try {
      const [s, a] = await Promise.all([
        api<Subscriber[]>("/subscribers"),
        api<Alert[]>("/alerts?limit=100"),
      ]);
      setSubscribers(s);
      setAlerts(a);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => { refreshAll(); }, []);

  // Restore identity from localStorage.
  useEffect(() => {
    const raw = localStorage.getItem("cb.me");
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as Subscriber;
      api<Subscriber>(`/subscribers/${saved.id}`).then(setMe).catch(() => {
        localStorage.removeItem("cb.me");
      });
    } catch { /* ignore */ }
  }, []);

  // WebSocket for incoming alerts.
  useEffect(() => {
    if (!me) return;
    const ws = new WebSocket(`${WS_URL}/ws/${me.id}`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "alert" && data.alert) {
          const a = data.alert as Alert;
          setIncoming(a);
          setAlerts((prev) => (prev.some((p) => p.id === a.id) ? prev : [a, ...prev]));
          try {
            if ("Notification" in window && Notification.permission === "granted") {
              new Notification(`📡 ${a.category_name}: ${a.title}`, { body: a.message });
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; };
    return () => ws.close();
  }, [me]);

  // Ask for notification permission once the user subscribes.
  useEffect(() => {
    if (me && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, [me]);

  const showToast = (text: string, kind: "ok" | "err" = "ok") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 3500);
  };

  const handleMapClick = (lat: number, lon: number) => {
    if (mode === "suscriptor" && !me) {
      setPendingSubPoint({ lat, lon });
    } else if (mode === "autoridad") {
      setCbCenter({ lat, lon });
    }
  };

  const handleSubscribe = async () => {
    if (!pendingSubPoint || !subName.trim()) {
      showToast("Indicá tu nombre y hacé click en el mapa", "err");
      return;
    }
    try {
      const s = await api<Subscriber>("/subscribers", {
        method: "POST",
        body: JSON.stringify({ name: subName.trim(), lat: pendingSubPoint.lat, lon: pendingSubPoint.lon }),
      });
      setMe(s);
      localStorage.setItem("cb.me", JSON.stringify(s));
      setSubName("");
      setPendingSubPoint(null);
      showToast(`Registrado como ${s.name}`);
      refreshAll();
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`, "err");
    }
  };

  const handleUnsubscribe = async () => {
    if (!me) return;
    try {
      await api(`/subscribers/${me.id}`, { method: "DELETE" });
      localStorage.removeItem("cb.me");
      setMe(null);
      showToast("Baja realizada");
      refreshAll();
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`, "err");
    }
  };

  const handleEmit = async () => {
    if (!cbCenter) return showToast("Click en el mapa para elegir el centro", "err");
    if (!cbTitle.trim() || !cbMessage.trim() || !cbAreaName.trim()) {
      return showToast("Completá título, mensaje y área", "err");
    }
    setSending(true);
    try {
      const res = await api<{ alert: Alert; reached: { id: string; name: string; distance_km: number }[] }>("/alerts", {
        method: "POST",
        body: JSON.stringify({
          category: cbCategory,
          title: cbTitle.trim(),
          message: cbMessage.trim(),
          instructions: cbInstructions.trim() || null,
          center_lat: cbCenter.lat,
          center_lon: cbCenter.lon,
          radius_km: cbRadiusKm,
          area_name: cbAreaName.trim(),
          sender: cbSender.trim() || "Autoridad",
        }),
      });
      setLastEmitted(res);
      setAlerts((prev) => [res.alert, ...prev]);
      showToast(`Emitido — alcanzados ${res.alert.reached_count} usuario(s)`);
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`, "err");
    } finally {
      setSending(false);
    }
  };

  // Alerts that are "active" — drawn on the map (last 5).
  const activeAlerts = useMemo(() => alerts.slice(0, 5), [alerts]);

  // Center the map on Argentina by default.
  const center: [number, number] = me ? [me.lat, me.lon] : [-34.6, -58.5];

  return (
    <div className="flex h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-[380px] shrink-0 border-r border-slate-800 bg-slate-900/60 backdrop-blur flex flex-col">
        <div className="px-5 pt-5 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Radio size={22} className="text-indigo-400" />
            <h1 className="text-lg font-semibold tracking-tight">Cell Broadcast</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">Difusión geolocalizada de alertas de emergencia (tipo CMAS/WEA)</p>
        </div>

        <nav className="px-3 pt-3 flex gap-1">
          {([
            { k: "suscriptor", label: "Soy usuario",     icon: Users    },
            { k: "autoridad",  label: "Soy autoridad",   icon: Megaphone },
            { k: "historial",  label: "Historial",       icon: History  },
          ] as { k: Mode; label: string; icon: LucideIcon }[]).map(({ k, label, icon: Icon }) => (
            <button
              key={k}
              onClick={() => setMode(k)}
              className={`flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
                mode === k ? "bg-slate-800 text-white ring-1 ring-slate-700" : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {mode === "suscriptor" && (
            <section className="space-y-3">
              {me ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-wider text-emerald-300/80">Registrado</div>
                      <div className="text-base font-semibold">{me.name}</div>
                      <div className="text-xs text-slate-400 mt-1">
                        {me.lat.toFixed(4)}, {me.lon.toFixed(4)}
                      </div>
                    </div>
                    <button
                      onClick={handleUnsubscribe}
                      className="text-xs text-rose-300 hover:text-rose-200 inline-flex items-center gap-1"
                    >
                      <Trash2 size={14} /> Baja
                    </button>
                  </div>
                  <div className="mt-3 text-xs text-slate-400">
                    Recibís notificaciones en tiempo real cuando una alerta cubre tu zona.
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                    <div className="text-sm text-slate-300 mb-3 flex items-center gap-2">
                      <MapPin size={16} className="text-indigo-400" />
                      Hacé click en el mapa para marcar tu ubicación.
                    </div>
                    <input
                      value={subName}
                      onChange={(e) => setSubName(e.target.value)}
                      placeholder="Tu nombre (ej: Ana)"
                      className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <div className="mt-3 text-xs text-slate-400">
                      {pendingSubPoint
                        ? <span>Posición: <span className="text-slate-200 font-mono">{pendingSubPoint.lat.toFixed(4)}, {pendingSubPoint.lon.toFixed(4)}</span></span>
                        : <span className="italic">Aún no elegiste una posición</span>}
                    </div>
                    <button
                      disabled={!pendingSubPoint || !subName.trim()}
                      onClick={handleSubscribe}
                      className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-md bg-indigo-500 hover:bg-indigo-400 disabled:bg-slate-700 disabled:text-slate-500 px-3 py-2 text-sm font-medium text-white transition"
                    >
                      <Plus size={16} /> Suscribirme
                    </button>
                  </div>
                  <p className="text-xs text-slate-400">
                    Vas a recibir alertas (por WebSocket + notificaciones del navegador) cuando tu posición esté dentro del área de una emisión.
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Usuarios activos</div>
                <div className="text-2xl font-semibold">{subscribers.length}</div>
              </div>
            </section>
          )}

          {mode === "autoridad" && (
            <section className="space-y-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3">
                <div className="text-sm text-slate-300 flex items-center gap-2">
                  <MapPin size={16} className="text-rose-400" />
                  Click en el mapa para elegir el centro de la celda.
                </div>
                <div className="text-xs text-slate-400">
                  {cbCenter
                    ? <>Centro: <span className="text-slate-200 font-mono">{cbCenter.lat.toFixed(4)}, {cbCenter.lon.toFixed(4)}</span></>
                    : <span className="italic">Sin centro definido</span>}
                </div>

                <div>
                  <label className="text-xs text-slate-400">Categoría</label>
                  <div className="grid grid-cols-5 gap-1 mt-1">
                    {(Object.keys(CATEGORY_META) as Category[]).map((k) => {
                      const meta = CATEGORY_META[k];
                      const Icon = meta.icon;
                      const selected = cbCategory === k;
                      return (
                        <button
                          key={k}
                          onClick={() => setCbCategory(k)}
                          title={meta.label}
                          className={`flex flex-col items-center justify-center gap-1 rounded-md px-2 py-2 text-[10px] border transition ${
                            selected
                              ? "border-slate-500 bg-slate-800 text-white"
                              : "border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200"
                          }`}
                          style={selected ? { borderColor: meta.color, boxShadow: `0 0 0 1px ${meta.color}55` } : undefined}
                        >
                          <Icon size={16} className="" />
                          <span>{meta.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-slate-400">Título</label>
                  <input
                    value={cbTitle}
                    onChange={(e) => setCbTitle(e.target.value)}
                    placeholder="Ej: Evacuación preventiva"
                    className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>

                <div>
                  <label className="text-xs text-slate-400">Mensaje</label>
                  <textarea
                    value={cbMessage}
                    onChange={(e) => setCbMessage(e.target.value)}
                    rows={3}
                    placeholder="Descripción de la amenaza y alcance"
                    className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>

                <div>
                  <label className="text-xs text-slate-400">Instrucciones (opcional)</label>
                  <textarea
                    value={cbInstructions}
                    onChange={(e) => setCbInstructions(e.target.value)}
                    rows={2}
                    placeholder="Acciones recomendadas (refugio, rutas, etc.)"
                    className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-400">Área (nombre)</label>
                    <input
                      value={cbAreaName}
                      onChange={(e) => setCbAreaName(e.target.value)}
                      placeholder="Ej: Haedo"
                      className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400">Emisor</label>
                    <input
                      value={cbSender}
                      onChange={(e) => setCbSender(e.target.value)}
                      placeholder="Autoridad"
                      className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-slate-400">Radio (km)</label>
                    <span className="text-xs font-mono text-slate-200">{cbRadiusKm}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={300}
                    step={1}
                    value={cbRadiusKm}
                    onChange={(e) => setCbRadiusKm(Number(e.target.value))}
                    className="mt-1 w-full accent-rose-500"
                  />
                </div>

                <button
                  onClick={handleEmit}
                  disabled={sending || !cbCenter}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-rose-500 hover:bg-rose-400 disabled:bg-slate-700 disabled:text-slate-500 px-3 py-2 text-sm font-medium text-white transition"
                >
                  <Send size={16} /> {sending ? "Emitiendo..." : "Emitir Cell Broadcast"}
                </button>

                {lastEmitted && (
                  <div className="mt-2 rounded-md border border-slate-700 bg-slate-900/60 p-3 text-xs">
                    <div className="text-slate-300">
                      Última emisión: <span className="font-semibold">{lastEmitted.alert.title}</span>
                    </div>
                    <div className="text-slate-400 mt-1">Alcanzados: {lastEmitted.alert.reached_count}</div>
                    {lastEmitted.reached.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-slate-400 max-h-24 overflow-y-auto">
                        {lastEmitted.reached.slice(0, 10).map((r) => (
                          <li key={r.id}>• {r.name} — {r.distance_km} km</li>
                        ))}
                        {lastEmitted.reached.length > 10 && <li>… y {lastEmitted.reached.length - 10} más</li>}
                      </ul>
                    )}
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500">
                Tip: podés registrar varios usuarios ficticios desde pestañas distintas del navegador para ver la entrega en vivo.
              </p>
            </section>
          )}

          {mode === "historial" && (
            <section className="space-y-2">
              {alerts.length === 0 && (
                <div className="text-sm text-slate-500 italic">Aún no hay emisiones.</div>
              )}
              {alerts.map((a) => {
                const meta = CATEGORY_META[a.category] ?? CATEGORY_META.prueba;
                const Icon = meta.icon;
                return (
                  <div key={a.id} className={`rounded-lg border border-slate-800 ${meta.bg} p-3`}>
                    <div className="flex items-center gap-2">
                      <Icon size={16} style={{ color: meta.color }} />
                      <div className="text-xs uppercase tracking-wider" style={{ color: meta.color }}>
                        {meta.label}
                      </div>
                      <div className="text-[10px] text-slate-500 ml-auto">{relTime(a.created_at)}</div>
                    </div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{a.title}</div>
                    <div className="text-xs text-slate-300 mt-0.5 line-clamp-3">{a.message}</div>
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-400">
                      <span>📍 {a.area_name}</span>
                      <span>📏 {a.radius_km} km</span>
                      <span>👥 {a.reached_count}</span>
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 text-[11px] text-slate-500">
          API: <span className="font-mono text-slate-400">{API_URL}</span>
        </div>
      </aside>

      {/* Map */}
      <main className="relative flex-1">
        <MapContainer center={center} zoom={11} className="absolute inset-0">
          <TileLayer
            attribution='&copy; OpenStreetMap'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickHandler onClick={handleMapClick} />
          {me && <FlyTo lat={me.lat} lon={me.lon} zoom={12} />}

          {/* Existing subscribers */}
          {subscribers.map((s) => (
            <Marker key={s.id} position={[s.lat, s.lon]} icon={subscriberIcon(me?.id === s.id)}>
              <Popup>
                <div className="text-slate-100">
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-xs text-slate-400 font-mono">{s.lat.toFixed(4)}, {s.lon.toFixed(4)}</div>
                </div>
              </Popup>
            </Marker>
          ))}

          {/* Pending subscriber marker */}
          {mode === "suscriptor" && !me && pendingSubPoint && (
            <Marker position={[pendingSubPoint.lat, pendingSubPoint.lon]}>
              <Popup>Tu futura ubicación</Popup>
            </Marker>
          )}

          {/* Admin center marker + preview circle */}
          {mode === "autoridad" && cbCenter && (
            <>
              <Marker position={[cbCenter.lat, cbCenter.lon]}>
                <Popup>Centro de la celda</Popup>
              </Marker>
              <Circle
                center={[cbCenter.lat, cbCenter.lon]}
                radius={cbRadiusKm * 1000}
                pathOptions={{ color: CATEGORY_META[cbCategory].color, weight: 2, fillOpacity: 0.08, dashArray: "6 6" }}
              />
            </>
          )}

          {/* Recently emitted alerts */}
          {activeAlerts.map((a) => (
            <Circle
              key={a.id}
              center={[a.center_lat, a.center_lon]}
              radius={a.radius_km * 1000}
              pathOptions={{
                color: CATEGORY_META[a.category].color,
                weight: 2,
                fillColor: CATEGORY_META[a.category].color,
                fillOpacity: 0.08,
              }}
            />
          ))}
        </MapContainer>

        {/* Incoming alert banner */}
        {incoming && (
          <IncomingBanner alert={incoming} onClose={() => setIncoming(null)} />
        )}

        {/* Toast */}
        {toast && (
          <div
            className={`absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md px-4 py-2 text-sm shadow-lg border ${
              toast.kind === "ok"
                ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-200"
                : "bg-rose-500/10 border-rose-500/40 text-rose-200"
            }`}
          >
            {toast.text}
          </div>
        )}
      </main>
    </div>
  );
}

function IncomingBanner({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const meta = CATEGORY_META[alert.category] ?? CATEGORY_META.prueba;
  const Icon = meta.icon;
  return (
    <div className="absolute top-4 right-4 left-4 md:left-auto md:w-[460px] z-[1000]">
      <div
        className="rounded-xl border bg-slate-950/95 backdrop-blur shadow-2xl p-4 animate-pulse-once"
        style={{ borderColor: meta.color, boxShadow: `0 0 0 2px ${meta.color}66, 0 20px 40px -20px ${meta.color}55` }}
      >
        <div className="flex items-start gap-3">
          <div
            className="shrink-0 rounded-lg p-2"
            style={{ background: `${meta.color}22`, color: meta.color }}
          >
            <Icon size={22} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-xs uppercase tracking-wider" style={{ color: meta.color }}>
                {meta.label}
              </div>
              <div className="text-[11px] text-slate-500">• {relTime(alert.created_at)}</div>
            </div>
            <div className="text-base font-semibold text-slate-100 mt-0.5">{alert.title}</div>
            <div className="text-sm text-slate-300 mt-1">{alert.message}</div>
            {alert.instructions && (
              <div className="text-xs text-slate-400 mt-2 border-t border-slate-800 pt-2">
                <span className="uppercase text-[10px] tracking-wider text-slate-500">Instrucciones</span>
                <div className="mt-0.5">{alert.instructions}</div>
              </div>
            )}
            <div className="mt-2 text-[11px] text-slate-500">
              {alert.sender} • {alert.area_name} • radio {alert.radius_km} km
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
