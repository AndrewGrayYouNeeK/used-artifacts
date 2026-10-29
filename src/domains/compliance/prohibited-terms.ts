import type { ProhibitedTermSeverity } from "@/generated/prisma/enums";

export type ProhibitedTermLaw = "NAGPRA" | "ARPA" | "IACA" | "BGEPA" | "LOOTING";

export interface ProhibitedTermDef {
  pattern: string;
  isRegex?: boolean;
  severity: ProhibitedTermSeverity;
  law: ProhibitedTermLaw;
  reason: string;
}

/**
 * Baseline screening list. Seeded into ProhibitedTerm (where staff can add
 * more) and always applied even if the table is empty. BLOCK refuses the
 * submission; REVIEW lets it through to the compliance queue with a flag.
 * Pending counsel review (BUILD_PLAN L2, L3, L5).
 */
export const BASELINE_PROHIBITED_TERMS: readonly ProhibitedTermDef[] = [
  // NAGPRA: human remains, funerary objects, sacred objects, cultural patrimony.
  { pattern: "human remains?", isRegex: true, severity: "BLOCK", law: "NAGPRA", reason: "Human remains are banned" },
  { pattern: "human (bone|bones|skull|skulls|teeth|tooth|hair)", isRegex: true, severity: "BLOCK", law: "NAGPRA", reason: "Human remains are banned" },
  { pattern: "skeletal remains", severity: "BLOCK", law: "NAGPRA", reason: "Human remains are banned" },
  { pattern: "funerary", severity: "BLOCK", law: "NAGPRA", reason: "Funerary objects are banned" },
  { pattern: "grave goods?", isRegex: true, severity: "BLOCK", law: "NAGPRA", reason: "Funerary objects are banned" },
  { pattern: "burial (goods?|offerings?|objects?|artifacts?|items?|beads|pots?|pottery)", isRegex: true, severity: "BLOCK", law: "NAGPRA", reason: "Funerary objects are banned" },
  { pattern: "(from|out of|found in|dug from) (a |the )?(grave|burial|mound|burial mound|cemetery)", isRegex: true, severity: "BLOCK", law: "NAGPRA", reason: "Items taken from graves or burials are banned" },
  { pattern: "sacred objects?", isRegex: true, severity: "BLOCK", law: "NAGPRA", reason: "Sacred objects are banned" },
  { pattern: "medicine bundles?", isRegex: true, severity: "BLOCK", law: "NAGPRA", reason: "Sacred objects are banned" },
  { pattern: "cultural patrimony", severity: "BLOCK", law: "NAGPRA", reason: "Objects of cultural patrimony are banned" },
  { pattern: "sacred", severity: "REVIEW", law: "NAGPRA", reason: "Possible sacred object" },
  { pattern: "ceremonial", severity: "REVIEW", law: "NAGPRA", reason: "Possible sacred object" },
  { pattern: "effigy", severity: "REVIEW", law: "NAGPRA", reason: "Possible sacred or funerary object" },
  { pattern: "(kachina|katsina)s?", isRegex: true, severity: "REVIEW", law: "NAGPRA", reason: "Possible sacred object" },
  { pattern: "burial", severity: "REVIEW", law: "NAGPRA", reason: "Possible funerary object" },
  { pattern: "(skull|skulls|bone|bones)", isRegex: true, severity: "REVIEW", law: "NAGPRA", reason: "Possible human remains" },
  // ARPA and land-status words. Review rather than block, since sellers often write "not from ...".
  { pattern: "national (forest|park|monument|grassland|wildlife refuge)", isRegex: true, severity: "REVIEW", law: "ARPA", reason: "Mentions federal land" },
  { pattern: "(blm|federal|public|state|tribal|reservation) land", isRegex: true, severity: "REVIEW", law: "ARPA", reason: "Mentions federal, state, or tribal land" },
  { pattern: "state (park|forest)", isRegex: true, severity: "REVIEW", law: "ARPA", reason: "Mentions state land" },
  { pattern: "(dug|excavated|metal detect(ed|ing)|cave find)", isRegex: true, severity: "REVIEW", law: "LOOTING", reason: "Excavation wording; confirm the site and permission" },
  // IACA: no unverified Indian-made claims.
  { pattern: "(american )?indian[- ]made", isRegex: true, severity: "BLOCK", law: "IACA", reason: "Unverified Indian-made claim" },
  { pattern: "native[- ](american[- ])?made", isRegex: true, severity: "BLOCK", law: "IACA", reason: "Unverified Native American-made claim" },
  { pattern: "(authentic|genuine|certified) (native american|american indian|indian) (art|craft|jewelry|made|work)", isRegex: true, severity: "BLOCK", law: "IACA", reason: "Unverified Indian-made claim" },
  // Bald and Golden Eagle Protection Act.
  { pattern: "eagle (feathers?|claws?|talons?|parts)", isRegex: true, severity: "BLOCK", law: "BGEPA", reason: "Eagle parts cannot be sold" },
];
