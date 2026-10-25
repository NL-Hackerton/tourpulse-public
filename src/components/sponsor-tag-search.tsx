"use client";

import { useState, useRef, useEffect, useId } from "react";
import { Search, X, LoaderCircle, Plus } from "lucide-react";
import { tagResponseSchema, type Tag } from "@/lib/contracts";
import { requestJson } from "@/lib/client";

interface Props {
  label: string;
  selected: Tag[];
  onAdd: (tag: Tag) => void;
  onRemove: (tagId: string) => void;
  disabled?: boolean;
}

export default function SponsorTagSearch({ label, selected, onAdd, onRemove, disabled }: Props) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapper = useRef<HTMLDivElement>(null);
  const selectedKey = selected.map((t) => t.id).sort().join(",");
  const atLimit = selected.length >= 8;

  useEffect(() => {
    setResults([]);
    setActive(-1);
    setError("");
    if (query.trim().length < 2 || disabled || selected.length >= 8) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const selectedIds = new Set(selectedKey.split(","));
    const timer = setTimeout(async () => {
      try {
        const parsed = await requestJson(`/api/tags?q=${encodeURIComponent(query.trim())}`, tagResponseSchema, { signal: controller.signal });
        if (!controller.signal.aborted) setResults(parsed.tags.filter((t) => !selectedIds.has(t.id)));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Tag search unavailable. Try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, disabled, selectedKey]);

  return <div className="tag-search" ref={wrapper} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    {selected.length > 0 && <div className="tag-chips">{selected.map((tag) => <span key={tag.id} className="tag-chip">{tag.name}<button type="button" className="icon-button" disabled={disabled} aria-label={`Remove ${tag.name}`} onClick={() => onRemove(tag.id)}><X size={11} /></button></span>)}</div>}
    <label className="field-label" htmlFor={id}>{label}</label>
    <div className="search-input">
      {loading ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
      <input id={id} value={query} placeholder={`Search ${label.toLowerCase()}…`} role="combobox" aria-autocomplete="list" aria-expanded={open && query.length >= 2} aria-controls={`${id}-tags`} aria-activedescendant={active >= 0 ? `${id}-tag-${active}` : undefined} disabled={disabled || atLimit} autoComplete="off" onChange={(e) => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
        if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((n) => Math.min(n + 1, results.length - 1)); }
        if (e.key === "ArrowUp") { e.preventDefault(); setActive((n) => results.length ? Math.max(n - 1, 0) : -1); }
        if (e.key === "Enter" && open && results[active]) { e.preventDefault(); onAdd(results[active]); setQuery(""); setOpen(false); }
      }} />
      {query && <button type="button" className="icon-button" aria-label="Clear" onClick={() => setQuery("")}><X size={13} /></button>}
    </div>
    {atLimit && <p className="field-hint">Eight tags selected. Remove one to search for another.</p>}
    {open && query.trim().length >= 2 && <div className="search-results" id={`${id}-tags`} role="listbox" aria-label={label}>
      {loading && <p className="search-note" role="status">Searching tags…</p>}
      {!loading && error && <p className="search-note" role="alert">{error}</p>}
      {!loading && !error && results.length === 0 && <p className="search-note">No matching tags.</p>}
      {!loading && results.map((tag, index) => <button key={tag.id} type="button" role="option" aria-selected={active === index} id={`${id}-tag-${index}`} className={active === index ? "search-option active" : "search-option"} onPointerDown={(e) => e.preventDefault()} onClick={() => { onAdd(tag); setQuery(""); setOpen(false); }}>
        <span><strong>{tag.name}</strong><small>{tag.type}</small></span><Plus size={14} />
      </button>)}
    </div>}
  </div>;
}
