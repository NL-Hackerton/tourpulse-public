import { useId, type CSSProperties } from "react";
import type { TourPlan } from "@/lib/contracts";
import { candidateCities } from "@/lib/contracts";
import type { MarketResearch } from "@/lib/export";
import { checkNames } from "@/lib/venue-review";
import "./tour-visuals.css";

const checkCount = Object.keys(checkNames).length;
const weekday = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const monthDay = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

// Shared print masthead: a brand band over the document title so a printed page
// reads as a TourPulse document, with the not-a-booking boundary always visible.
export function PrintMasthead({ kind, title, meta, status }: { kind: string; title: string; meta: string[]; status?: string }) {
  return <header className="print-masthead">
    <div className="print-brand"><span className="print-brand-mark" aria-hidden="true" />TourPulse<span className="print-brand-kind">{kind}</span></div>
    <h1>{title}</h1>
    <p className="print-meta">{meta.filter(Boolean).join(" · ")}{status && <span className="print-status">{status}</span>}</p>
  </header>;
}

export function routeStops(plan: TourPlan) {
  return plan.schedule.orderedStopIds.map((id) => plan.stops.find((stop) => stop.id === id)).filter((stop) => stop !== undefined);
}

// Screen route metrics, set like the reference dashboard's inline KPIs: a label,
// the value and a quieter qualifier. Only ratios that exist in the plan get the
// three-step level marker; it never stands in for a missing number.
type Level = "ok" | "near" | "over" | "info";
function LevelMarker({ ratio, level }: { ratio: number; level: Level }) {
  const filled = ratio <= 0 ? 0 : Math.min(3, Math.max(1, Math.round(ratio * 3)));
  return <span className={`level-marker ${level}`} aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className={i < filled ? "on" : ""} />)}</span>;
}

export function RouteMetrics({ plan }: { plan: TourPlan }) {
  const { rows, totalKm, originalKm, travelDays } = plan.schedule;
  const shows = rows.filter((row) => row.kind === "show").length;
  const rests = rows.filter((row) => row.kind === "rest").length;
  const saved = originalKm - totalKm;
  const longest = Math.max(0, ...rows.map((row) => row.driveHours));
  const cap = plan.input.maxDriveHours;
  const capUse = cap > 0 ? longest / cap : 0;
  const savedShare = originalKm > 0 && saved > 0.5 ? saved / originalKm : 0;
  const metrics: { label: string; value: string; qualifier?: string; marker?: { ratio: number; level: Level } }[] = [
    { label: "Shows", value: String(shows), qualifier: `of ${plan.stops.length} markets` },
    { label: "Estimated drive", value: `${Math.round(totalKm).toLocaleString("en-US")} km` },
    { label: "Saved vs input order", value: savedShare ? `${Math.round(saved).toLocaleString("en-US")} km` : "None", qualifier: savedShare ? `${Math.round(savedShare * 100)}%` : undefined, marker: savedShare ? { ratio: savedShare, level: "info" } : undefined },
    { label: "Off days", value: String(rows.length - shows), qualifier: `${travelDays} travel, ${rests} rest` },
    { label: "Longest drive", value: `${longest.toFixed(1)} h`, qualifier: `of ${cap} h cap`, marker: { ratio: capUse, level: capUse > 1 ? "over" : capUse >= 0.9 ? "near" : "ok" } },
  ];
  return <dl className="route-metrics">{metrics.map((metric) => <div key={metric.label}>
    <dt>{metric.label}</dt>
    <dd>{metric.marker && <LevelMarker {...metric.marker} />}<span>{metric.value}</span>{metric.qualifier && <span className="route-metric-qualifier">{metric.qualifier}</span>}</dd>
  </div>)}</dl>;
}

// A straight-line sketch from verified coordinates, used on screen and paper.
// There are no tiles to fail, and the caption says it is not a road map.
export function RouteSketch({ plan }: { plan: TourPlan }) {
  const stops = routeStops(plan);
  const start = candidateCities.find((city) => city.name === plan.input.startCity);
  const showStart = start && !stops.some((stop) => stop.name === start.name);
  const points = [...(showStart ? [{ name: start.name, lat: start.lat, lon: start.lon }] : []), ...stops];
  if (!points.length) return null;
  const width = 300, height = 180, pad = 26;
  const meanLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const k = Math.cos((meanLat * Math.PI) / 180);
  const xs = points.map((point) => point.lon * k), ys = points.map((point) => -point.lat);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((width - pad * 2) / Math.max(maxX - minX, 0.5), (height - pad * 2) / Math.max(maxY - minY, 0.5));
  const offsetX = (width - (maxX - minX) * scale) / 2, offsetY = (height - (maxY - minY) * scale) / 2;
  const project = (lat: number, lon: number) => [offsetX + (lon * k - minX) * scale, offsetY + (-lat - minY) * scale] as const;
  const step = Math.max(1, Math.ceil(Math.max(maxX - minX, maxY - minY) / 4));
  const lats = Array.from({ length: 12 }, (_, i) => Math.floor(-maxY) - step * 2 + i * step).filter((lat) => { const y = project(lat, 0)[1]; return y > 0 && y < height; });
  const lons = Array.from({ length: 12 }, (_, i) => Math.floor(minX / k) - step * 2 + i * step).filter((lon) => { const x = project(0, lon)[0]; return x > 0 && x < width; });
  const path = points.map((point) => project(point.lat, point.lon).join(",")).join(" ");
  return <figure className="route-sketch">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Straight-line route overview, not a road map: ${points.map((point) => point.name).join(" to ")}`}>
      {lats.map((lat) => <line key={`lat${lat}`} className="grid" x1={0} x2={width} y1={project(lat, 0)[1]} y2={project(lat, 0)[1]} />)}
      {lons.map((lon) => <line key={`lon${lon}`} className="grid" y1={0} y2={height} x1={project(0, lon)[0]} x2={project(0, lon)[0]} />)}
      <polyline className="leg" points={path} />
      {points.map((point, index) => {
        const [x, y] = project(point.lat, point.lon);
        const isStart = showStart && index === 0;
        const left = x > width * 0.68;
        return <g key={`${point.name}${index}`} className={isStart ? "start" : "stop"}>
          <circle cx={x} cy={y} r={isStart ? 4.5 : 7} />
          {!isStart && <text className="num" x={x} y={y + 2.6}>{showStart ? index : index + 1}</text>}
          <text className="label" x={left ? x - 10 : x + 10} y={y + 3} textAnchor={left ? "end" : "start"}>{isStart ? `Start · ${point.name}` : point.name}</text>
        </g>;
      })}
    </svg>
  </figure>;
}

// The route sketch as a chart: same header grammar as the drive chart, shared
// by the screen overview and the printed Day Sheet.
export function RouteOrderChart({ plan }: { plan: TourPlan }) {
  const titleId = useId();
  return <section className="chart" aria-labelledby={titleId}>
    <header className="chart-header"><div><h2 id={titleId}>Route order</h2><p>Straight-line sketch from verified coordinates, not road routing.</p></div></header>
    <RouteSketch plan={plan} />
  </section>;
}

// Estimated drive hours per itinerary day, drawn the way the reference
// dashboard draws a single-series bar chart: title and description, legend at
// the top right, horizontal gridlines with hour ticks, the user's daily cap as a
// dashed rule, and red only for a day that exceeds it. Values are printed above
// bars so touch, keyboard and paper readers see them without hover.
function hourTicks(maxHours: number) {
  const step = maxHours <= 4 ? 1 : maxHours <= 8 ? 2 : maxHours <= 16 ? 4 : 5;
  // One step of headroom above the tallest bar or cap keeps value labels inside the plot.
  const top = Math.max(step, Math.floor(maxHours / step) * step + step);
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
}

export function DailyDriveChart({ plan }: { plan: TourPlan }) {
  const titleId = useId();
  const { rows } = plan.schedule;
  if (!rows.length) return null;
  const cap = plan.input.maxDriveHours;
  const { top, ticks } = hourTicks(Math.max(cap, ...rows.map((row) => row.driveHours)));
  const at = (hours: number) => `${(hours / top) * 100}%`;
  const overCap = rows.some((row) => row.driveHours > cap);
  const dayLabel = (row: (typeof rows)[number]) => row.kind === "show" ? row.city ?? "Show" : row.kind === "travel" ? "Travel" : "Rest";
  return <section className="chart" aria-labelledby={titleId}>
    <header className="chart-header">
      <div><h2 id={titleId}>Daily drive</h2><p>Estimated hours per day against your {cap}-hour cap.</p></div>
      <ul className="chart-legend" aria-hidden="true"><li><i className="swatch drive" />Drive hours</li>{overCap && <li><i className="swatch over" />Over cap</li>}<li><i className="swatch cap" />Daily cap</li></ul>
    </header>
    <div className="drive-chart" style={{ "--days": rows.length } as CSSProperties} aria-hidden="true">
      <div className="drive-chart-y">{ticks.map((tick) => <span key={tick} style={{ bottom: at(tick) }}>{tick} h</span>)}</div>
      <div className="drive-chart-plot">
        {ticks.map((tick) => <span key={tick} className="drive-chart-grid" style={{ bottom: at(tick) }} />)}
        <span className="drive-chart-cap" style={{ bottom: at(cap) }} />
        <div className="drive-chart-bars">{rows.map((row, index) => <div key={index} className="drive-chart-col">
          {row.driveHours > 0 && <span className="drive-chart-value" style={{ bottom: at(row.driveHours) }}>{row.driveHours.toFixed(1)}</span>}
          <span className={`drive-chart-bar${row.driveHours > cap ? " over" : ""}`} style={{ height: at(row.driveHours) }} />
        </div>)}</div>
      </div>
      <div className="drive-chart-x">{rows.map((row, index) => <div key={index} className={row.kind} title={dayLabel(row)}><span>{weekday(row.date)} {monthDay(row.date)}</span><strong>{dayLabel(row)}</strong></div>)}</div>
    </div>
    <div className="sr-only"><table><caption>Estimated drive hours per itinerary day; daily cap {cap} hours</caption><thead><tr><th>Day</th><th>Plan</th><th>Hours</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}><td>{weekday(row.date)} {monthDay(row.date)}</td><td>{dayLabel(row)}</td><td>{row.driveHours.toFixed(1)}{row.driveHours > cap ? " (over cap)" : ""}</td></tr>)}</tbody></table></div>
  </section>;
}

// Per-market summary in route order: Qloo discovery rank, the 0–1 City Fit
// heuristic as a meter, the anchor bundle's rank change, and the user's own
// venue research progress. None of it is a forecast or a booking.
export function MarketCards({ plan, markets }: { plan: TourPlan; markets: MarketResearch[] }) {
  const stops = routeStops(plan);
  return <div className="print-markets">{stops.map((stop, index) => {
    const market = markets.find((item) => item.id === stop.id);
    const working = market?.venues.find((venue) => venue.selected);
    // Same rule as the on-screen queue: current candidates only, and a judgment
    // marked for revisit is counted separately rather than as its old status.
    const live = stop.venueDecisions.filter((decision) => stop.venues.some((venue) => venue.id === decision.entityId));
    const counts = [...(["shortlist", "hold", "exclude"] as const).map((status) => [status, live.filter((decision) => decision.status === status && !decision.needsReview).length] as const), ["revisit", live.filter((decision) => decision.needsReview).length] as const];
    const current = working ? checkCount - working.missing.length : 0;
    const before = stop.anchorDelta !== null && stop.destinationRank + stop.anchorDelta >= 1 ? stop.destinationRank + stop.anchorDelta : null;
    return <article key={stop.id} className="print-market">
      <header><span className="print-market-num">{index + 1}</span><h3>{stop.name}</h3><span>{market?.showDate ? `${weekday(market.showDate)} ${monthDay(market.showDate)}` : "no show date"}</span></header>
      <p className="print-market-rank">Qloo market rank <strong>#{stop.destinationRank}</strong>{plan.anchors.length > 0 && before !== null && before !== stop.destinationRank && <span className="print-delta">headliner only #{before}</span>}</p>
      <div className="print-meter" aria-label={`City Fit ${stop.cityFit?.toFixed(2) ?? "insufficient evidence"}`}>
        <span>City Fit</span><span className="print-meter-track"><span style={{ width: `${Math.round((stop.cityFit ?? 0) * 100)}%` }} /></span><b>{stop.cityFit?.toFixed(2) ?? "n/a"}</b>
      </div>
      <p className="print-market-venue"><span>Working venue</span>{working?.name ?? (stop.venues.length ? "None selected" : "No venue candidates returned")}</p>
      <div className="print-market-foot">
        <span className="print-chips">{counts.filter(([, count]) => count > 0).map(([status, count]) => <span key={status} className={`print-chip ${status}`}>{count} {status}</span>)}</span>
        {working && <span className="print-checks" aria-label={`${current} of ${checkCount} venue checks current`}>{Array.from({ length: checkCount }, (_, i) => <i key={i} className={i < current ? "on" : ""} />)}{current}/{checkCount} checks</span>}
      </div>
    </article>;
  })}</div>;
}

// A 0–1 discovery signal as a bar with its value. The label names the scale;
// it is never a percentage, forecast or probability.
export function ScoreMeter({ label, value, muted = false }: { label: string; value: number | null; muted?: boolean }) {
  return <div className={`score-meter${muted ? " muted" : ""}`} role="img" aria-label={`${label}: ${value === null ? "not available" : `${value.toFixed(2)} on a 0 to 1 scale`}`}>
    <span>{label}</span><span className="score-meter-track"><span style={{ width: `${Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)}%` }} /></span><b>{value?.toFixed(2) ?? "n/a"}</b>
  </div>;
}
