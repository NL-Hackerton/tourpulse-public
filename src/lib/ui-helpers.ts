import { type Confirmation, type TourType } from "@/lib/contracts";

export function modeLabel(type: TourType): string {
  switch (type) {
    case "music": return "Music planning";
    case "standup": return "Stand-up planning";
    case "podcast": return "Podcast planning";
  }
}

export function entityTypeName(type: string): string {
  return type.replace("urn:entity:", "").replaceAll("_", " ");
}

export function tagDisplay(tag: string): string {
  return tag.split(":").at(-1)?.replaceAll("_", " ") ?? tag;
}

export function confirmationFields(stop: { confirmations: Confirmation[] }, placeId: string): Confirmation[] {
  return stop.confirmations.filter((c) => c.entityId === placeId);
}
