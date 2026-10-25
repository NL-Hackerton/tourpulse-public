import type { Fit } from "./contracts";
import { meanAffinity } from "./scoring";

export type ComparisonInput = { id: string; baseScore: number; values: { placeId: string; value: number | null }[] };
/** Scores are exploratory. All candidates must cover exactly the same fixed set. */
export function compareFits(candidates: ComparisonInput[], placeIds: string[]): Map<string, Fit> {
  const expected = new Set(placeIds);
  const complete = expected.size > 0 && candidates.every((candidate) => {
    const ids = new Set(candidate.values.map((v) => v.placeId));
    return ids.size === expected.size && candidate.values.length === expected.size && candidate.values.every((v) => expected.has(v.placeId) && v.value !== null && Number.isFinite(v.value));
  });
  const means = candidates.map((c) => meanAffinity(c.values.map((v) => v.value)));
  const score = (i: number, weight: number, omit?: string) => weight * candidates[i].baseScore + (1 - weight) * (omit === undefined ? means[i]! : meanAffinity(candidates[i].values.filter((v) => v.placeId !== omit).map((v) => v.value))!);
  let sensitive = false;
  if (complete) {
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const direction = Math.sign(score(i, 0.6) - score(j, 0.6));
      if ([0.5, 0.7].some((w) => Math.sign(score(i, w) - score(j, w)) !== direction)) sensitive = true;
      if (expected.size > 1 && placeIds.some((id) => Math.sign(score(i, 0.6, id) - score(j, 0.6, id)) !== direction)) sensitive = true;
    }
  }
  return new Map(candidates.map((candidate, i) => [candidate.id, {
    score: complete && !sensitive ? score(i, 0.6) : null,
    baseScore: candidate.baseScore, placeAffinity: means[i],
    status: !complete ? "insufficient_evidence" : sensitive ? "sensitive" : "comparable",
    observedPlaces: candidate.values.filter((v) => expected.has(v.placeId) && v.value !== null).length,
    totalPlaces: expected.size,
    warnings: !complete ? ["Comparison withheld: every candidate must have a non-null observation for exactly the same retained places."] : sensitive ? ["Superiority withheld: ranking changes at weights 0.5/0.6/0.7 or when leaving out one place."] : ["Exploratory cross-query affinity comparison; calibration has not been established."],
  }]));
}
