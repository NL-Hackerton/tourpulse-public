"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TourPlan } from "@/lib/contracts";
import { candidateCities } from "@/lib/contracts";
import type { FeatureCollection, LineString, Point } from "geojson";
// maplibre-gl imports safely in Node (SSR); Map instances are created in
// browser-only effects, so the server bundle never touches WebGL.
import { Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import type { GeoJSONSource as MapLibreGeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import NeighborhoodMap from "./neighborhood-map";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";

/** Bundled same-origin MapLibre worker. Next 16 emits it as a hashed build
 *  asset in both Turbopack and webpack modes; never a remote/untrusted URL. */
const workerUrl = new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString();
const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";
setWorkerUrl(workerUrl);

const SOURCE_CITIES = "tp-cities";
const SOURCE_ROUTE = "tp-route";
const CITY_POINT_LAYER = "tp-city-point";
const CITY_NUMBER_LAYER = "tp-city-number";
const CITY_LABEL_LAYER = "tp-city-label";
const ROUTE_LINE_LAYER = "tp-route-line";

interface RouteOverviewProps {
  plan: TourPlan | null;
  selectedId: string;
  onSelect: (id: string) => void;
  onNeighborhoodSelect: (cityId: string, geohash: string) => void;
  activeAnchor: string | null;
  nicheWeight: number;
  disabled: boolean;
}

interface RouteStop { id: string; name: string; lat: number; lon: number; stopNumber: number; marketRank: number | null; affinity: number | null; cityFit: number | null; }
interface CityProps { id: string; name: string; stopNumber: number; marketRank: number | null; selected: number; affinity: number | null; cityFit: number | null; }

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Stops in schedule order; candidates fall back to the known static catalog. */
function orderedStops(plan: TourPlan | null): RouteStop[] {
  if (!plan) return [];
  const byId = new Map(plan.stops.map((stop) => [stop.id, stop]));
  return plan.schedule.orderedStopIds.flatMap((id) => {
    const stop = byId.get(id);
    return stop ? [{ id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon, stopNumber: 0, marketRank: stop.destinationRank, affinity: stop.affinity, cityFit: stop.cityFit }] : [];
  }).map((stop, index) => ({ ...stop, stopNumber: index + 1 }));
}

function cityPoints(plan: TourPlan | null, selectedId: string): FeatureCollection<Point, CityProps> {
  if (plan) {
    return {
      type: "FeatureCollection",
      features: orderedStops(plan).map((stop) => ({
        type: "Feature",
        properties: { id: stop.id, name: stop.name, stopNumber: stop.stopNumber, marketRank: stop.marketRank, selected: stop.id === selectedId ? 1 : 0, affinity: stop.affinity, cityFit: stop.cityFit },
        geometry: { type: "Point", coordinates: [stop.lon, stop.lat] },
      })),
    };
  }
  return {
    type: "FeatureCollection",
    features: candidateCities.map((city, index) => ({
      type: "Feature",
      properties: { id: city.name, name: city.name, stopNumber: index + 1, marketRank: null, selected: 0, affinity: null, cityFit: null },
      geometry: { type: "Point", coordinates: [city.lon, city.lat] },
    })),
  };
}

function routeLine(plan: TourPlan | null): FeatureCollection<LineString, Record<string, never>> {
  const stops = plan ? orderedStops(plan) : [];
  if (stops.length < 2) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: stops.map((stop) => [stop.lon, stop.lat] as [number, number]) },
    }],
  };
}

function addRouteLayers(map: MapLibreMap): void {
  if (map.getSource(SOURCE_CITIES)) return;
  map.addSource(SOURCE_CITIES, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource(SOURCE_ROUTE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: ROUTE_LINE_LAYER, type: "line", source: SOURCE_ROUTE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#56d6e8", "line-width": 2.2, "line-opacity": 0.85, "line-dasharray": [2, 1.6] },
  });
  map.addLayer({
    id: CITY_POINT_LAYER, type: "circle", source: SOURCE_CITIES,
    paint: {
      "circle-radius": ["case", ["==", ["get", "selected"], 1], 9, 6.5],
      "circle-color": ["case", ["==", ["get", "selected"], 1], "#ff7045", "#141b24"],
      "circle-stroke-color": ["case", ["==", ["get", "selected"], 1], "#ffb79e", "#ff7045"],
      "circle-stroke-width": ["case", ["==", ["get", "selected"], 1], 2.4, 1.6],
    },
  });
  map.addLayer({
    id: CITY_NUMBER_LAYER, type: "symbol", source: SOURCE_CITIES,
    layout: { "text-field": ["get", "stopNumber"], "text-size": 9.5, "text-allow-overlap": true, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": ["case", ["==", ["get", "selected"], 1], "#21100a", "#eef2f6"] },
  });
  map.addLayer({
    id: CITY_LABEL_LAYER, type: "symbol", source: SOURCE_CITIES,
    layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.5], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
    paint: {
      "text-color": ["case", ["==", ["get", "selected"], 1], "#ffb59e", "#dde5ee"],
      "text-halo-color": "#0b0d10", "text-halo-width": 1.3,
    },
  });
}

function applyRouteData(map: MapLibreMap, plan: TourPlan | null, selectedId: string): void {
  (map.getSource(SOURCE_CITIES) as MapLibreGeoJSONSource | undefined)?.setData(cityPoints(plan, selectedId));
  (map.getSource(SOURCE_ROUTE) as MapLibreGeoJSONSource | undefined)?.setData(routeLine(plan));
}

function fitRoute(map: MapLibreMap, plan: TourPlan | null): void {
  const stops = plan ? orderedStops(plan) : [];
  if (stops.length === 0) { map.easeTo({ center: [-74.35, 40.5], zoom: 5.4, duration: 0 }); return; }
  if (stops.length === 1) { map.easeTo({ center: [stops[0].lon, stops[0].lat], zoom: 8.4, duration: 0 }); return; }
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const stop of stops) {
    minLon = Math.min(minLon, stop.lon); maxLon = Math.max(maxLon, stop.lon);
    minLat = Math.min(minLat, stop.lat); maxLat = Math.max(maxLat, stop.lat);
  }
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 46, maxZoom: 8.4, duration: 0 });
}

function showCityPopup(map: MapLibreMap, popup: Popup | null, event: MapLayerMouseEvent, hasPlan: boolean): void {
  if (!popup) return;
  const props = event.features?.[0]?.properties as CityProps | undefined;
  if (!props) return;
  const node = document.createElement("div");
  node.className = "tp-popup";
  const title = document.createElement("strong");
  title.textContent = props.name;
  node.appendChild(title);
  if (hasPlan) {
    const rows: [string, string][] = [
      ["Route stop", String(props.stopNumber)],
      ["Qloo market rank", props.marketRank === null ? "not ranked" : String(props.marketRank)],
      ["Qloo affinity (0–1)", props.affinity === null ? "no evidence" : props.affinity.toFixed(3)],
      ["City Fit heuristic (0–1)", props.cityFit === null ? "no evidence" : props.cityFit.toFixed(3)],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement("span");
      const key = document.createElement("strong");
      key.textContent = label;
      row.appendChild(key);
      row.appendChild(document.createTextNode(` ${value}`));
      node.appendChild(row);
    }
    const foot = document.createElement("small");
    foot.textContent = "Estimated positions · not a road map";
    node.appendChild(foot);
  } else {
    const note = document.createElement("small");
    note.textContent = "Candidate market in the fixed Northeast catalog · not a Qloo recommendation";
    node.appendChild(note);
  }
  popup.setLngLat(event.lngLat).setDOMContent(node).addTo(map);
}

function flyToCity(map: MapLibreMap | null, plan: TourPlan | null, id: string): void {
  const city = plan ? plan.stops.find((stop) => stop.id === id) : candidateCities.find((c) => c.name === id);
  if (!city || !map) return;
  map.easeTo({ center: [city.lon, city.lat], zoom: Math.max(map.getZoom(), plan ? 8.2 : 5.8), duration: 500 });
}

function CityMap({ plan, selectedId, onSelect, disabled }: { plan: TourPlan | null; selectedId: string; onSelect: (id: string) => void; disabled: boolean; }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const lastFlyRef = useRef<string | null>(null);
  const live = useRef({ plan, selectedId, onSelect, disabled });
  live.current = { plan, selectedId, onSelect, disabled };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const element = containerRef.current;
    if (!element) return;
    let alive = true;
    let popup: Popup | null = null;
    try {
      const map = new MapLibreMap({
        container: element,
        style: styleUrl,
        center: [-74.35, 40.5],
        zoom: 5.4,
        minZoom: 3,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
      mapRef.current = map;
      popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: "230px", offset: 10 });
      popupRef.current = popup;
      map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
      map.on("error", (event) => {
        if (!alive) return;
        setMapError(event.error instanceof Error ? event.error.message : String(event.error ?? "Map render error"));
      });
      map.on("load", () => {
        if (!alive) return;
        try {
          addRouteLayers(map);
          applyRouteData(map, live.current.plan, live.current.selectedId);
          fitRoute(map, live.current.plan);
          lastFlyRef.current = live.current.selectedId || null;
          setMapError(null);
          setReady(true);
        } catch (cause) { if (alive) setMapError(describeError(cause)); }
      });
      map.on("click", CITY_POINT_LAYER, (event) => {
        const current = live.current;
        if (!current.plan || current.disabled) return;
        const props = event.features?.[0]?.properties as CityProps | undefined;
        if (!props) return;
        current.onSelect(props.id);
        const geometry = event.features?.[0]?.geometry;
        if (geometry && geometry.type === "Point") {
          map.easeTo({ center: geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), 8.2), duration: 550 });
        }
      });
      map.on("mousemove", CITY_POINT_LAYER, (event) => {
        const current = live.current;
        map.getCanvas().style.cursor = current.plan && !current.disabled ? "pointer" : "";
        showCityPopup(map, popup, event, Boolean(current.plan));
      });
      map.on("mouseleave", CITY_POINT_LAYER, () => { map.getCanvas().style.cursor = ""; popup?.remove(); });
    } catch (cause) { setMapError(describeError(cause)); }
    return () => {
      alive = false;
      popupRef.current?.remove(); popupRef.current = null;
      mapRef.current?.remove(); mapRef.current = null;
    };
  }, [retryKey]);

  useEffect(() => {
    if (ready || mapError) return;
    const timer = setTimeout(() => setMapError("Map rendering did not become ready. Use the stop list below or retry when the connection and display are available."), 15000);
    return () => clearTimeout(timer);
  }, [ready, mapError, retryKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try { applyRouteData(map, plan, selectedId); } catch { /* sources not added yet */ }
  }, [plan, selectedId, ready, retryKey]);

  // DaySheet sync: when the console moves the selected stop, follow it on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !plan) return;
    const stop = plan.stops.find((item) => item.id === selectedId);
    if (!stop || lastFlyRef.current === selectedId) return;
    lastFlyRef.current = selectedId;
    map.easeTo({ center: [stop.lon, stop.lat], zoom: Math.max(map.getZoom(), 8), duration: 500 });
  }, [plan, selectedId, ready]);

  const stopsList = useMemo(() => (
    plan ? orderedStops(plan)
      : candidateCities.map((city, index) => ({ id: city.name, name: city.name, lat: city.lat, lon: city.lon, stopNumber: index + 1, marketRank: null, affinity: null, cityFit: null }))
  ), [plan]);

  return (
    <div className="tp-map-body" data-map-unavailable={mapError ? "true" : undefined}>
      <div className="tp-map-stage">
        <div ref={containerRef} className="tp-map-canvas" role="application"
          aria-label={plan ? "Tour markets map. Select a stop on the map or from the list." : "Candidate markets map. Planning is required to select stops."}>
          <div className="tp-map-attribution">© <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a> · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors</div>
        </div>
        {!ready && !mapError && (
          <div className="tp-map-loading" role="status"><span className="tp-spinner spin" aria-hidden="true" />Loading map…</div>
        )}
        {mapError && (
          <div className="tp-map-error" role="alert">
            <p><strong>Map display unavailable.</strong> {mapError}</p>
            <p className="tp-map-error-note">WebGL or tile failures do not block planning — stop selection in the list still works.</p>
            <button type="button" className="button-secondary" onClick={() => { setMapError(null); setReady(false); setRetryKey((key) => key + 1); }}>Retry map</button>
          </div>
        )}
        {ready && (
          <div className="tp-map-legend">
            <div className="tp-legend-row"><i className="tp-legend-line" aria-hidden="true" />estimated route</div>
            <div className="tp-legend-row"><i className="tp-legend-dot" aria-hidden="true" />{plan ? "tour stop" : "candidate market"}</div>
            <p className="tp-legend-note">Geographic overview · not a road map</p>
          </div>
        )}
      </div>
      <aside className="tp-map-list" aria-label={plan ? "Tour stops list" : "Candidate markets list"}>
        <h3>{plan ? "Tour stops" : "Candidate markets"}</h3>
        <ul className="tp-stop-list">
          {stopsList.map((stop) => {
            const selected = stop.id === selectedId;
            return (
              <li key={stop.id}>
                <button type="button" className={`tp-stop-item ${selected ? "selected" : ""}`} aria-pressed={selected}
                  disabled={disabled || !plan}
                  title={plan ? `Select ${stop.name}` : `${stop.name} — known catalog, not a recommendation`}
                  onClick={() => { onSelect(stop.id); flyToCity(mapRef.current, plan, stop.id); }}>
                  <span className="tp-stop-rank" aria-label={`Route stop ${stop.stopNumber}`}>{stop.stopNumber}</span>
                  <span className="tp-stop-name">{stop.name}</span>
                  <span className="tp-stop-affinity">{plan && stop.marketRank !== null ? `Rank ${stop.marketRank}` : "—"}</span>
                </button>
                {plan && <p className="tp-stop-meta">Qloo affinity {stop.affinity === null ? "unavailable" : stop.affinity.toFixed(3)} · discovery signal, not demand</p>}
              </li>
            );
          })}
        </ul>
        <p className="tp-map-list-note">{plan ? "Estimated route · not a road map" : "Known static catalog · not a Qloo recommendation"}</p>
      </aside>
    </div>
  );
}

export default function RouteOverview({ plan, selectedId, onSelect, onNeighborhoodSelect, activeAnchor, nicheWeight, disabled }: RouteOverviewProps) {
  const [view, setView] = useState<"route" | "neighborhood">("route");
  const selectedStop = useMemo(() => plan?.stops.find((stop) => stop.id === selectedId) ?? plan?.stops[0] ?? null, [plan, selectedId]);
  const anchor = useMemo(() => {
    if (!plan || !activeAnchor) return null;
    const entity = plan.anchors.find((item) => item.id === activeAnchor) ?? (plan.headliner.id === activeAnchor ? plan.headliner : null);
    if (!entity) return null;
    const type = entity.type.replace(/^urn:entity:/, "");
    const count = [plan.headliner, ...plan.anchors].filter((item) => item.type === entity.type).length;
    return { type, count };
  }, [plan, activeAnchor]);

  return (
    <div className="route-overview tp-map">
      <div className="tp-map-toolbar">
        <div className="tp-map-toggle" role="group" aria-label="Map view">
          <button type="button" aria-pressed={view === "route"} onClick={() => setView("route")}>Cities</button>
          <button type="button" aria-pressed={view === "neighborhood"} disabled={!plan || plan.stops.length === 0}
            title={plan && plan.stops.length ? "Explore each stop's neighborhood cells" : "Create a tour to explore neighborhood cells"}
            onClick={() => setView("neighborhood")}>Neighborhoods</button>
        </div>
        <span className="tp-map-context">{view === "route"
          ? (plan ? `${plan.stops.length} markets · estimated lines, not roads` : "Eight candidate markets in the Northeast and Mid-Atlantic")
          : (selectedStop ? `${selectedStop.name} · neighborhood cells` : "Neighborhood view")}</span>
      </div>
      {view === "route" ? (
        <CityMap plan={plan} selectedId={selectedId} onSelect={onSelect} disabled={disabled} />
      ) : (
        <>
          {plan && (
            <div className="tp-city-chips" role="group" aria-label="Choose a market's neighborhoods">
              {plan.stops.map((stop) => (
                <button key={stop.id} type="button" className={`tp-city-chip ${stop.id === selectedStop?.id ? "selected" : ""}`}
                  aria-pressed={stop.id === selectedStop?.id} disabled={disabled}
                  onClick={() => onSelect(stop.id)}>{stop.name}</button>
              ))}
            </div>
          )}
          <NeighborhoodMap stop={selectedStop} anchorType={anchor?.type ?? null} anchorCount={anchor?.count ?? 0}
            nicheWeight={nicheWeight}
            onNeighborhoodSelect={onNeighborhoodSelect}
            disabled={disabled} />
        </>
      )}
    </div>
  );
}