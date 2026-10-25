"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search, X, LoaderCircle, Plus } from "lucide-react";
import { entityTypes, searchResponseSchema, type Entity } from "@/lib/contracts";
import { requestJson } from "@/lib/client";

interface Props {
  label: string;
  type: (typeof entityTypes)[number];
  onSelect: (entity: Entity) => void;
  disabled?: boolean;
  excluded?: string[];
}

export default function EntitySearch({ label, type, onSelect, disabled, excluded = [] }: Props) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const excludedKey = excluded.join(",");

  useEffect(() => {
    setResults([]);
    setActive(-1);
    setError("");
    if (query.trim().length < 2 || disabled) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const parsed = await requestJson(`/api/search?q=${encodeURIComponent(query.trim())}&type=${type}`, searchResponseSchema, { signal: controller.signal });
        if (!controller.signal.aborted) {
          const excludedIds = new Set(excludedKey.split(","));
          setResults(parsed.entities.filter((e) => !excludedIds.has(e.id)));
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Search unavailable. Try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, type, disabled, excludedKey]);

  function choose(entity: Entity) {
    onSelect(entity);
    setQuery("");
    setOpen(false);
    setResults([]);
  }

  return <div className="entity-search" ref={wrapper} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <label className="field-label" htmlFor={id}>{label}</label>
    <div className="search-input">
      {loading ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
      <input id={id} value={query} placeholder={type === "artist" ? "Search an artist…" : `Search ${type.replaceAll("_", " ")}…`}
        role="combobox" aria-autocomplete="list" aria-expanded={open && query.length >= 2}
        aria-controls={`${id}-results`} aria-activedescendant={active >= 0 ? `${id}-result-${active}` : undefined}
        disabled={disabled} autoComplete="off" onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((n) => Math.min(n + 1, results.length - 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive((n) => results.length ? Math.max(n - 1, 0) : -1); }
          if (event.key === "Enter" && open && results[active]) { event.preventDefault(); choose(results[active]); }
        }} />
      {query && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}
    </div>
    {open && query.trim().length >= 2 && <div className="search-results" id={`${id}-results`} role="listbox" aria-label={`${label} results`}>
      {loading && <p className="search-note" role="status">Searching Qloo…</p>}
      {!loading && error && <p className="search-note" role="alert">{error}</p>}
      {!loading && !error && results.length === 0 && <p className="search-note">No matches. Try another name.</p>}
      {!loading && results.map((entity, index) => <button key={entity.id} type="button" role="option" aria-selected={active === index}
        id={`${id}-result-${index}`} className={active === index ? "search-option active" : "search-option"}
        onPointerDown={(event) => event.preventDefault()} onClick={() => choose(entity)}>
        <span><strong>{entity.name}</strong><small>{entity.description || entity.type.replace("urn:entity:", "").replaceAll("_", " ")}</small></span><Plus size={15} />
      </button>)}
    </div>}
  </div>;
}
