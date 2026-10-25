"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Place, Stop } from "@/lib/contracts";
import ngeohash from "ngeohash";
import { withinMarket } from "@/lib/geography";
import { neighborhoodScore } from "@/lib/scoring";
import type { FeatureCollection, Point, Polygon } from "geojson";
// maplibre-gl imports safely in Node (SSR); Map instances are created in
// browser-only effects, so the server bundle never touches WebGL.
import { Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import type { GeoJSONSource as MapLibreGeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import "./map.css";

/** Bundled same-origin MapLibre worker. Next 16 emits it as a hashed build
 *  asset in both Turbopack and webpack modes; never a remote/untrusted URL. */
const workerUrl = new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString();
const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";
setWorkerUrl(workerUrl);

const SOURCE_CELLS = "tp-cells";
const SOURCE_PLACES = "tp-places";
const LAYER_CELL_FILL = "tp-cell-fill";
const LAYER_CELL_LINE = "tp-cell-line";
const LAYER_CELL_SELECTED = "tp-cell-selected";
const LAYER_PLACE = "tp-place-point";
const LAYER_PLACE_LABEL = "tp-place-label";

interface NeighborhoodMapProps {
  stop: Stop | null;
  anchorType: string | null;
  anchorCount: number;
  nicheWeight: number;
  onNeighborhoodSelect: (cityId: string, geohash: string) => void;
  disabled: boolean;
}

interface DisplayCell {
  geohash: string; score: number; affinityRank: number; popularity: number;
  contributions: Record<string, number>; selected: boolean; polygon: Polygon;
}
interface CellProps { geohash: string; score: number; selected: number; }
interface DisplayPlace {
  id: string; name: string; kind: "venue" | "partner"; address: string; neighborhood: string;
  affinity: number | null; selected: boolean; point: [number, number];
}
interface PlaceProps {
  id: string; name: string; kind: "venue" | "partner"; address: string; neighborhood: string;
  affinity: number | null; selected: number;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** GeoHash decode_bbox → [minlat, minlon, maxlat, maxlon] → closed GeoJSON
 *  polygon [lon, lat]. Cell precision is whatever the provider returned
 *  (not always 7), so the boundary always comes from the cell string itself. */
function cellPolygon(hash: string): Polygon | null {
  try {
    const [minLat, minLon, maxLat, maxLon] = ngeohash.decode_bbox(hash);
    if (![minLat, minLon, maxLat, maxLon].every(Number.isFinite)) return null;
    const ring: [number, number][] = [
      [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat],
    ];
    return { type: "Polygon", coordinates: [ring] };
  } catch { return null; }
}

function buildDisplayCells(stop: Stop, lambda: number): DisplayCell[] {
  const cells: DisplayCell[] = [];
  for (const cell of stop.cells) {
    const polygon = cellPolygon(cell.geohash);
    if (!polygon || !withinMarket(cell, stop)) continue;
    // The same axes carry Qloo heatmap values or explicitly disclosed
    // observed-place proxies; the niche slider never issues a query.
    const score = neighborhoodScore(cell.affinityRank, cell.popularity, lambda);
    if (!Number.isFinite(score) || score < 0 || score > 1) continue;
    cells.push({
      geohash: cell.geohash, score, affinityRank: cell.affinityRank, popularity: cell.popularity,
      contributions: cell.contributions, selected: cell.geohash === stop.selectedNeighborhood, polygon,
    });
  }
  return cells.sort((a, b) => b.score - a.score);
}

function buildDisplayPlaces(stop: Stop): DisplayPlace[] {
  const fromPlace = (place: Place, kind: "venue" | "partner"): DisplayPlace | null => {
    if (place.lat === null || place.lon === null || !withinMarket(place, stop)) return null;
    return {
      id: place.id, name: place.name, kind, address: place.address, neighborhood: place.neighborhood,
      affinity: place.affinity,
      selected: kind === "venue" ? stop.selectedVenueId === place.id : stop.selectedPartnerIds.includes(place.id),
      point: [place.lon, place.lat],
    };
  };
  return [
    ...stop.venues.map((place) => fromPlace(place, "venue")),
    ...stop.partners.map((place) => fromPlace(place, "partner")),
  ].filter((place): place is DisplayPlace => place !== null);
}

function cellsCollection(cells: DisplayCell[]): FeatureCollection<Polygon, CellProps> {
  return {
    type: "FeatureCollection",
    features: cells.map((cell) => ({
      type: "Feature",
      properties: { geohash: cell.geohash, score: cell.score, selected: cell.selected ? 1 : 0 },
      geometry: cell.polygon,
    })),
  };
}

function placesCollection(places: DisplayPlace[]): FeatureCollection<Point, PlaceProps> {
  return {
    type: "FeatureCollection",
    features: places.map((place) => ({
      type: "Feature",
      properties: {
        id: place.id, name: place.name, kind: place.kind, address: place.address,
        neighborhood: place.neighborhood, affinity: place.affinity, selected: place.selected ? 1 : 0,
      },
      geometry: { type: "Point", coordinates: place.point },
    })),
  };
}

function addCellLayers(map: MapLibreMap): void {
  if (map.getSource(SOURCE_CELLS)) return;
  map.addSource(SOURCE_CELLS, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource(SOURCE_PLACES, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: LAYER_CELL_FILL, type: "fill", source: SOURCE_CELLS,
    paint: {
      "fill-color": ["case", ["==", ["get", "selected"], 1], "#56d6e8",
        ["interpolate", ["linear"], ["get", "score"], 0, "#132b3d", 0.4, "#2e5d78", 0.7, "#b07e40", 1, "#ff7045"]],
      "fill-opacity": ["case", ["==", ["get", "selected"], 1], 0.92, 0.55],
    },
  });
  map.addLayer({
    id: LAYER_CELL_LINE, type: "line", source: SOURCE_CELLS,
    paint: { "line-color": "#0b0d10", "line-width": 0.9, "line-opacity": 0.8 },
  });
  map.addLayer({
    id: LAYER_CELL_SELECTED, type: "line", source: SOURCE_CELLS,
    filter: ["==", ["get", "selected"], 1],
    paint: { "line-color": "#d9fbff", "line-width": 2.4, "line-opacity": 1 },
  });
  map.addLayer({
    id: LAYER_PLACE, type: "circle", source: SOURCE_PLACES,
    paint: {
      "circle-radius": ["case", ["==", ["get", "selected"], 1], 10, 8],
      "circle-color": ["case", ["==", ["get", "selected"], 1], "#ffffff",
        ["==", ["get", "kind"], "venue"], "#64d7ae", "#f3bb63"],
      "circle-stroke-color": ["case", ["==", ["get", "selected"], 1], "#ff7045", "#0b0d10"],
      "circle-stroke-width": ["case", ["==", ["get", "selected"], 1], 2.6, 1.4],
      "circle-opacity": 0.95,
    },
  });
  map.addLayer({
    id: LAYER_PLACE_LABEL, type: "symbol", source: SOURCE_PLACES, minzoom: 11.4,
    layout: { "text-field": ["get", "name"], "text-size": 10.5, "text-offset": [0, 1.4], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
    paint: {
      "text-color": ["case", ["==", ["get", "selected"], 1], "#ffb59e", "#e2e9f0"],
      "text-halo-color": "#0b0d10", "text-halo-width": 1.2,
    },
  });
}

function applyCellData(map: MapLibreMap, cells: DisplayCell[], places: DisplayPlace[]): void {
  (map.getSource(SOURCE_CELLS) as MapLibreGeoJSONSource | undefined)?.setData(cellsCollection(cells));
  (map.getSource(SOURCE_PLACES) as MapLibreGeoJSONSource | undefined)?.setData(placesCollection(places));
}

function fitToCells(map: MapLibreMap, cells: DisplayCell[], stop: Stop): void {
  if (cells.length === 0) { map.easeTo({ center: [stop.lon, stop.lat], zoom: Math.max(map.getZoom(), 10.8), duration: 0 }); return; }
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const cell of cells) {
    for (const [lon, lat] of cell.polygon.coordinates[0]) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
  }
  if (![minLon, maxLon, minLat, maxLat].every(Number.isFinite)) return;
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 44, maxZoom: 13.2, duration: 0 });
}

function contributionLabel(key: string): string {
  return key.replace(/^entity_/, "").replace(/_affinity_rank$/, "").replaceAll("_", " ");
}

/** Cell contributions are per-entity-type provider records, e.g.
 *  entity_artist_affinity_rank. The active anchor maps to its entity type;
 *  when several anchors share a type the provider value is the type aggregate,
 *  so the label says so instead of claiming per-anchor attribution. */
function anchorContribution(cell: DisplayCell, anchorType: string | null): number | null {
  if (!anchorType) return null;
  const value = cell.contributions[`entity_${anchorType}_affinity_rank`];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function showCellPopup(map: MapLibreMap, popup: Popup | null, event: MapLayerMouseEvent, anchorType: string | null, anchorCount: number, lambda: number, cells: DisplayCell[]): void {
  if (!popup) return;
  const props = event.features?.[0]?.properties as CellProps | undefined;
  if (!props) return;
  const cell = cells.find((item) => item.geohash === props.geohash);
  if (!cell) return;
  const node = document.createElement("div");
  node.className = "tp-popup";
  const title = document.createElement("strong");
  title.textContent = `Neighborhood ${cell.geohash}`;
  node.appendChild(title);
  const rows: [string, string][] = [
    ["Cell score", cell.score.toFixed(3)],
    ["Affinity signal", cell.affinityRank.toFixed(3)],
    ["Popularity / density signal", cell.popularity.toFixed(3)],
  ];
  const contribution = anchorContribution(cell, anchorType);
  if (contribution !== null) {
    rows.push([`Anchor · ${anchorType}${anchorCount > 1 ? ` ×${anchorCount}` : ""}`, contribution.toFixed(3)]);
  } else if (anchorType !== null) {
    rows.push(["Anchor breakdown", "no evidence"]);
  } else {
    for (const [key, value] of Object.entries(cell.contributions).slice(0, 2)) {
      rows.push([contributionLabel(key), value.toFixed(3)]);
    }
  }
  for (const [label, value] of rows) {
    const row = document.createElement("span");
    const key = document.createElement("strong");
    key.textContent = label;
    row.appendChild(key);
    row.appendChild(document.createTextNode(` ${value}`));
    node.appendChild(row);
  }
  const foot = document.createElement("small");
  foot.textContent = `λ = ${lambda.toFixed(2)} · actual scores, not a percentage forecast`;
  node.appendChild(foot);
  popup.setLngLat(event.lngLat).setDOMContent(node).addTo(map);
}

function showPlacePopup(map: MapLibreMap, popup: Popup | null, event: MapLayerMouseEvent): void {
  if (!popup) return;
  const props = event.features?.[0]?.properties as PlaceProps | undefined;
  if (!props) return;
  const node = document.createElement("div");
  node.className = "tp-popup";
  const title = document.createElement("strong");
  title.textContent = props.name;
  node.appendChild(title);
  const kindRow = document.createElement("span");
  const kindKey = document.createElement("strong");
  kindKey.textContent = props.kind === "venue" ? "Venue candidate" : "Nearby partner";
  kindRow.appendChild(kindKey);
  node.appendChild(kindRow);
  const location = document.createElement("span");
  location.textContent = props.neighborhood || props.address || "Location details unavailable";
  node.appendChild(location);
  const affinityRow = document.createElement("span");
  const affinityKey = document.createElement("strong");
  affinityKey.textContent = "Qloo affinity";
  affinityRow.appendChild(affinityKey);
  affinityRow.appendChild(document.createTextNode(` ${props.affinity === null ? "no evidence" : props.affinity.toFixed(3)}`));
  node.appendChild(affinityRow);
  const foot = document.createElement("small");
  foot.textContent = "Selection and booking checks stay in the stop dossier.";
  node.appendChild(foot);
  popup.setLngLat(event.lngLat).setDOMContent(node).addTo(map);
}

export default function NeighborhoodMap({ stop, anchorType, anchorCount, nicheWeight, onNeighborhoodSelect, disabled }: NeighborhoodMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [lambda, setLambda] = useState<number>(() => (Number.isFinite(nicheWeight) ? nicheWeight : 0.3));
  const [mapError, setMapError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const live = useRef({ stop, lambda, anchorType, anchorCount, onNeighborhoodSelect, disabled });
  live.current = { stop, lambda, anchorType, anchorCount, onNeighborhoodSelect, disabled };

  // The console's niche slider is the source of truth; an external change
  // supersedes any local map-slider value. Local changes never hit the API.
  useEffect(() => {
    if (Number.isFinite(nicheWeight)) setLambda(nicheWeight);
  }, [nicheWeight]);

  const cells = useMemo(() => (stop ? buildDisplayCells(stop, lambda) : []), [stop, lambda]);
  const places = useMemo(() => (stop ? buildDisplayPlaces(stop) : []), [stop]);
  const liveCells = useRef<DisplayCell[]>([]);
  liveCells.current = cells;
  const livePlaces = useRef<DisplayPlace[]>([]);
  livePlaces.current = places;

  const stopId = stop?.id ?? null;

  useEffect(() => {
    if (typeof window === "undefined" || !stop) return;
    const element = containerRef.current;
    if (!element) return;
    setReady(false);
    setMapError(null);
    let alive = true;
    let popup: Popup | null = null;
    try {
      const map = new MapLibreMap({
        container: element,
        style: styleUrl,
        center: [stop.lon, stop.lat],
        zoom: 10.6,
        minZoom: 3,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
      mapRef.current = map;
      popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: "250px", offset: 12 });
      popupRef.current = popup;
      map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
      map.on("error", (event) => {
        if (!alive) return;
        setMapError(event.error instanceof Error ? event.error.message : String(event.error ?? "Map render error"));
      });
      map.on("load", () => {
        if (!alive) return;
        try {
          addCellLayers(map);
          applyCellData(map, liveCells.current, livePlaces.current);
          fitToCells(map, liveCells.current, stop);
          setMapError(null);
          setReady(true);
        } catch (cause) { if (alive) setMapError(describeError(cause)); }
      });
      map.on("click", LAYER_CELL_FILL, (event) => {
        const current = live.current;
        if (!current.stop || current.disabled) return;
        const props = event.features?.[0]?.properties as CellProps | undefined;
        if (!props) return;
        current.onNeighborhoodSelect(current.stop.id, props.geohash);
      });
      map.on("mousemove", LAYER_CELL_FILL, (event) => {
        map.getCanvas().style.cursor = live.current.disabled ? "" : "pointer";
        showCellPopup(map, popup, event, live.current.anchorType, live.current.anchorCount, live.current.lambda, liveCells.current);
      });
      map.on("mouseleave", LAYER_CELL_FILL, () => { map.getCanvas().style.cursor = ""; popup?.remove(); });
      map.on("mousemove", LAYER_PLACE, (event) => { showPlacePopup(map, popup, event); });
      map.on("click", LAYER_PLACE, (event) => { showPlacePopup(map, popup, event); });
      map.on("mouseleave", LAYER_PLACE, () => { popup?.remove(); });
    } catch (cause) { setMapError(describeError(cause)); }
    return () => {
      alive = false;
      popupRef.current?.remove(); popupRef.current = null;
      mapRef.current?.remove(); mapRef.current = null;
    };
  }, [stopId, retryKey]);

  useEffect(() => {
    if (!stopId || ready || mapError) return;
    const timer = setTimeout(() => setMapError("Map rendering did not become ready. Use the neighborhood list below or retry when the connection and display are available."), 15000);
    return () => clearTimeout(timer);
  }, [stopId, ready, mapError, retryKey]);

  // Data sync: new cells/places (or a new lambda) redraw the layers in place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try { applyCellData(map, cells, places); } catch { /* layers not added yet */ }
  }, [cells, places, ready, retryKey]);

  if (!stop) {
    return (
      <div className="tp-map-empty" role="status">
        <h3>No market selected</h3>
        <p>Create a tour, then pick a stop to explore its actual neighborhood cells and places.</p>
      </div>
    );
  }

  return (
    <div className="tp-map-body" data-map-unavailable={mapError ? "true" : undefined}>
      <div className="tp-map-stage">
        <div ref={containerRef} className="tp-map-canvas" role="application"
          aria-label={`${stop.name} neighborhood map. Select a cell on the map or from the list to change the neighborhood.`}>
          <div className="tp-map-attribution">© <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a> · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors</div>
        </div>
        {!ready && !mapError && (
          <div className="tp-map-loading" role="status"><span className="tp-spinner spin" aria-hidden="true" />Loading neighborhoods…</div>
        )}
        {mapError && (
          <div className="tp-map-error" role="alert">
            <p><strong>Map display unavailable.</strong> {mapError}</p>
            <p className="tp-map-error-note">WebGL or tile failures do not block planning — the cell list still selects neighborhoods.</p>
            <button type="button" className="button-secondary" onClick={() => { setMapError(null); setReady(false); setRetryKey((key) => key + 1); }}>Retry map</button>
          </div>
        )}
        {!mapError && (
          <div className="tp-map-legend">
            <div className="tp-legend-title">Cell score scale</div>
            <div className="tp-scale"><span style={{ background: "linear-gradient(90deg, #132b3d 0%, #2e5d78 40%, #b07e40 70%, #ff7045 100%)" }} /></div>
            <div className="tp-scale-labels"><span>0</span><span>1</span></div>
            <p className="tp-scale-note">score = affinity signal<sup>1−λ</sup> × popularity / density signal<sup>λ</sup> · exploratory, not a demand forecast</p>
            <div className="tp-legend-row"><i className="tp-legend-cell" aria-hidden="true" />selected cell</div>
            <div className="tp-legend-row"><i className="tp-legend-venue" aria-hidden="true" />venue</div>
            <div className="tp-legend-row"><i className="tp-legend-partner" aria-hidden="true" />partner</div>
          </div>
        )}
      </div>
      <aside className="tp-map-list" aria-label={`${stop.name} neighborhood cells and places`}>
        <section className="tp-list-section">
          <h3>Neighborhood cells</h3>
          <p className="tp-scale-note">Heatmap cells use Qloo affinity rank and popularity. If heatmap access is denied, place aggregation uses mean observed affinity and relative place density instead—not a population estimate.</p>
          {stop.warnings.map((warning) => <p className="tp-scale-note" key={warning}>{warning}</p>)}
          <label className="tp-lambda-label" htmlFor="tp-niche-focus">Niche → Broad<output htmlFor="tp-niche-focus">λ = {lambda.toFixed(2)}</output></label>
            <input id="tp-niche-focus" className="tp-range" type="range" min={0} max={0.6} step={0.05} value={lambda}
              disabled={disabled}
              aria-label="Niche to broad slider — higher values emphasize popularity or observed-place density; changes display locally"
              onChange={(event) => setLambda(Number(event.target.value))} />
          {cells.length === 0 ? (
            <p className="tp-list-empty">{stop.cells.length ? "Qloo returned cells without usable in-market scores." : "No neighborhood data for this market."}</p>
          ) : (
            <ul className="tp-cell-list">
              {cells.map((cell, index) => {
                const anchorValue = anchorContribution(cell, anchorType);
                return (
                  <li key={cell.geohash}>
                    <button type="button" className={`tp-cell-item ${cell.selected ? "selected" : ""}`} aria-pressed={cell.selected}
                      disabled={disabled}
                      title={`Select neighborhood ${cell.geohash}`}
                      onClick={() => onNeighborhoodSelect(stop.id, cell.geohash)}>
                      <span className="tp-cell-rank">{index + 1}</span>
                      <span className="tp-cell-name">{cell.geohash}</span>
                      <span className="tp-cell-score">{cell.score.toFixed(2)}</span>
                    </button>
                    <p className="tp-cell-meta">affinity signal {cell.affinityRank.toFixed(2)} · popularity/density {cell.popularity.toFixed(2)}{anchorValue !== null ? ` · ${anchorType} ${anchorValue.toFixed(2)}` : ""}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="tp-list-section">
          <h3>Places in market</h3>
          {places.length === 0 ? <p className="tp-list-empty">No verified in-market places.</p> : (
            <ul className="tp-place-list">
              {places.map((place) => (
                <li key={place.id} className={`tp-place-item ${place.selected ? "selected" : ""}`}>
                  <span className="tp-place-kind">{place.kind === "venue" ? "Venue" : "Partner"}</span>
                  <span className="tp-place-name">{place.name}</span>
                  <span className="tp-place-affinity">{place.affinity === null ? "—" : place.affinity.toFixed(3)}</span>
                  <small>{place.neighborhood || place.address || "Location details unavailable"}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="tp-map-list-note">Place selection and booking checks stay in the stop dossier.</p>
      </aside>
    </div>
  );
}