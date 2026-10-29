export interface Attestation {
  key: string;
  text: string;
}

export interface ProvenanceTemplateContent {
  version: number;
  body: string;
  attestations: Attestation[];
}

export const DRAFT_BANNER = "DRAFT – PENDING LAWYER REVIEW";

/** Keys the database also stores as dedicated boolean columns. */
export const CORE_ATTESTATIONS = {
  notFederalStateOrTribalLand: "not_government_or_tribal_land",
  notRemainsFuneralSacredPatrimony: "not_remains_funerary_sacred_patrimony",
  notIndianMadeMisrepresented: "no_unverified_indian_made_claim",
} as const;

/**
 * Placeholder wording for the beta. Not legal advice and not approved by
 * counsel (BUILD_PLAN L2, L3, L5, L6). Wording changes ship as a new version;
 * the database refuses edits to an existing version.
 */
export const PROVENANCE_TEMPLATE_V2: ProvenanceTemplateContent = {
  version: 2,
  body: [
    `${DRAFT_BANNER}. This wording is a placeholder and has not been approved by counsel.`,
    "",
    "Sworn provenance statement. I make this statement about the item in this listing, knowing that Used Artifacts, buyers, and law enforcement may rely on it. To the best of my knowledge, and after reasonable inquiry, I state each of the following:",
  ].join("\n"),
  attestations: [
    {
      key: CORE_ATTESTATIONS.notFederalStateOrTribalLand,
      text: "The item was not removed from any national forest, national park, Bureau of Land Management land, or other federal land; from any state, county, or municipal public land; or from any tribal or Indian land (Archaeological Resources Protection Act and state law).",
    },
    {
      key: "lawful_private_land_or_chain",
      text: "If the item was found on private land, it was found with the landowner's permission and in compliance with state law, including unmarked-burial and site-protection laws. Otherwise it came to me through the ownership history I describe below.",
    },
    {
      key: CORE_ATTESTATIONS.notRemainsFuneralSacredPatrimony,
      text: "The item is not, and does not contain, human remains, a funerary object, a sacred object, or an object of cultural patrimony, and it was not taken from a grave, burial, or burial mound (Native American Graves Protection and Repatriation Act).",
    },
    {
      key: CORE_ATTESTATIONS.notIndianMadeMisrepresented,
      text: "I have not described the item as Indian-made, Native American-made, or the product of any tribe or tribal member unless that claim has been verified (Indian Arts and Crafts Act).",
    },
    {
      key: "legal_title",
      text: "I own the item, have the legal right to sell it, and know of no claim against it by any person, tribe, or government.",
    },
    {
      key: "accurate_and_penalty",
      text: "The information in this listing and statement is true and complete. I understand that a false statement may lead to removal of the listing, suspension of my account, referral to authorities, and civil or criminal penalties.",
    },
  ],
};

export const IACA_DISCLOSURE =
  "Under the Indian Arts and Crafts Act, it is illegal to offer or display for sale any good in a manner that falsely suggests it is Indian-produced, an Indian product, or the product of a particular tribe. Used Artifacts does not verify maker identity; listings in this category may not claim an item is Indian-made or Native American-made.";

export function isAttestationList(value: unknown): value is Attestation[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a) =>
        a !== null &&
        typeof a === "object" &&
        typeof (a as Attestation).key === "string" &&
        typeof (a as Attestation).text === "string",
    )
  );
}
