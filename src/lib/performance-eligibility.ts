import type { Entity, Evidence } from "./contracts";
import { lookupWikidataLife, type LifeLookup } from "./wikidata";

export const performanceStatusLimit = "Biographical checks do not verify current activity, availability, willingness or a booking. A missing death record is not proof of life.";
export type LifeLookupFn = (ids: readonly string[], signal?: AbortSignal) => Promise<LifeLookup>;

/** Inputs must be Qloo detail records, never user-supplied names or inferred IDs. */
export async function screenPerformers(entities: readonly Entity[], signal?: AbortSignal, lookup: LifeLookupFn = lookupWikidataLife) {
  const unresolved = entities.filter((entity) => !entity.deathDate);
  const ids = [...new Set(unresolved.flatMap((entity) => entity.wikidataId ? [entity.wikidataId] : []))];
  const checked = ids.length ? await lookup(ids, signal) : null;
  const records = new Map(checked?.records.map((record) => [record.id, record]));
  const evidenceById = new Map<string, Evidence[]>();
  const eligible = unresolved.filter((entity) => {
    if (!entity.wikidataId) return true;
    const record = records.get(entity.wikidataId);
    // Explicitly missing and omitted linked records are not safe performance leads.
    if (!record?.present || record.deathRecorded) return false;
    evidenceById.set(entity.id, checked ? [checked.evidence] : []);
    return true;
  });
  return { eligible, evidenceById, evidence: checked?.evidence ?? null,
    withheld: entities.length - eligible.length,
    unlinked: eligible.filter((entity) => !entity.wikidataId).length };
}
