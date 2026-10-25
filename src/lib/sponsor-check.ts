import type { ProposalType, SponsorCheck, TourPlan } from "./contracts";
import { proposalTypeCopy } from "./proposal-preferences";

// Shared by the Sponsors controls, the server action, drafting and exports so
// a brand's fit for the saved purpose reads the same everywhere. A check is
// the user's own sourced judgment, never a brand statement or commitment.
export const sponsorCheckLabels: Record<SponsorCheck["status"], string> = {
  discuss: "Worth discussing",
  not_suitable: "Not suitable",
};
export const sponsorFitUnreviewed = "Not reviewed";
export const sponsorOfferingLabel = "User-sourced brand offering for this purpose; not a brand commitment";
export const sponsorOfferingSourceLabel = "Public source the user cited for the brand offering; not fetched or verified by TourPulse";
export const sponsorOfferingCheckedLabel = "When the user checked the brand offering source";
export const unreviewedSponsorWarning = "Brand fit for this purpose was not reviewed by the user; the support request is generic.";
export const orphanSponsorCheckNote = "brand not in current candidates";

/** The check for a brand and purpose, by default the plan's saved purpose. */
export function sponsorCheckFor(plan: TourPlan, brandId: string, purpose: ProposalType = plan.input.proposalPreferences.proposalType): SponsorCheck | null {
  return plan.sponsorChecks.find((check) => check.brandId === brandId && check.purpose === purpose) ?? null;
}

export function sponsorIsCurrent(plan: TourPlan, brandId: string): boolean {
  return plan.sponsors.some((sponsor) => sponsor.entity.id === brandId);
}

/** Display name for a checked brand; a brand that left the candidates keeps the name saved with its check. */
export function sponsorCheckBrandName(plan: TourPlan, brandId: string): string {
  return plan.sponsors.find((sponsor) => sponsor.entity.id === brandId)?.entity.name
    ?? plan.sponsorChecks.find((check) => check.brandId === brandId)?.brandName ?? brandId;
}

export type SponsorDraftGate =
  | { status: "unreviewed" }
  | { status: "discuss"; check: SponsorCheck }
  | { status: "blocked"; reason: string; check: SponsorCheck };

/** How the user's check for the selected brand and saved purpose shapes drafting. */
export function sponsorDraftGate(plan: TourPlan, brandId: string): SponsorDraftGate {
  const check = sponsorCheckFor(plan, brandId);
  if (!check) return { status: "unreviewed" };
  if (check.status === "discuss") return { status: "discuss", check };
  return { status: "blocked", check,
    reason: `You judged ${sponsorCheckBrandName(plan, brandId)} not suitable for ${proposalTypeCopy[check.purpose].label}: “${check.reason}” Review or forget that check on the sponsor card, choose another brand, or change the saved purpose.` };
}
