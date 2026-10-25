import { candidateCities, type Entity, type TourType } from "./contracts";
import { withinMarket } from "./geography";

const anchorTypes = new Set(["artist", "movie", "tv_show", "brand", "podcast", "book", "person"]);
const standupCategory = /^urn:tag:wikipedia_category:wikidata:(?:[a-z0-9_]+_)?stand_up_comedians$/;

export function isEntityType(entity: Entity, type: string): boolean {
  return entity.type === type || entity.type === `urn:entity:${type}`;
}

export function isComedian(entity: Entity): boolean {
  return isEntityType(entity, "person") && entity.tags.some((tag) =>
    tag === "urn:tag:genre:person:comedian" || standupCategory.test(tag));
}

export function validHeadliner(entity: Entity, mode: TourType): boolean {
  if (entity.deathDate) return false;
  return mode === "music" ? isEntityType(entity, "artist")
    : mode === "podcast" ? isEntityType(entity, "podcast") : isComedian(entity);
}

export function allowedAnchor(entity: Entity): boolean {
  return anchorTypes.has(entity.type.replace(/^urn:entity:/, ""));
}

const adultEntertainmentTag = /^urn:tag:(?:genre|category|activity_type):(?:place|qloo):adult_entertainment(?:_club)?$/;
/** Adult-entertainment clubs are never offered as tour venues or nearby partners. */
export function isAdultEntertainment(tags: readonly string[]): boolean {
  return tags.some((tag) => adultEntertainmentTag.test(tag));
}

/** The fixed market catalog is explicitly US-only; names alone never establish country. */
export function catalogDestination(name: string, location: { lat: number | null; lon: number | null } | null) {
  if (!location) return undefined;
  const normalized = name.toLowerCase();
  return candidateCities.find((city) => withinMarket(location, city)
    && (normalized === city.name.toLowerCase()
      || (city.name === "New York City" && normalized === "new york")
      || (city.name === "Washington" && /^washington(,? d\.?c\.?)?$/i.test(name))));
}
