import type { Module } from "./_shared.ts";
export async function loadDetector(id: string): Promise<Module | undefined> {
  switch (id) {
    case "a1_abscission": return (await import("./a1_abscission.ts")).a1_abscission;
    case "a2_velamen": return (await import("./a2_velamen.ts")).a2_velamen;
    case "a3_pseudobulb": return (await import("./a3_pseudobulb.ts")).a3_pseudobulb;
    case "a4_aquaporin": return (await import("./a4_aquaporin.ts")).a4_aquaporin;
    case "a5_phloem": return (await import("./a5_phloem.ts")).a5_phloem;
    case "a6_meristem": return (await import("./a6_meristem.ts")).a6_meristem;
    case "a7_passage": return (await import("./a7_passage.ts")).a7_passage;
    case "a8_rhizome": return (await import("./a8_rhizome.ts")).a8_rhizome;
    default: return undefined;
  }
}
export const DETECTOR_IDS = ["a1_abscission","a2_velamen","a3_pseudobulb","a4_aquaporin","a5_phloem","a6_meristem","a7_passage","a8_rhizome"];
