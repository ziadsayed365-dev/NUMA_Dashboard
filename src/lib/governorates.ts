// Shopify and Bosta each spell governorate names differently from each other
// and from our canonical list (seeded in governorate_fees). This maps every
// variant actually observed in real data back to the canonical name.
const ALIASES: Record<string, string> = {
  // Shopify spellings
  "al sharqia": "Sharqia",
  "kafr el-sheikh": "Kafr El Sheikh",
  // "6th of October" and "Helwan" are NOT folded into Giza / Cairo: Khazenly
  // prices them separately, so they are governorates of their own (migration 0084).
  "6th of october": "6th of October",
  helwan: "Helwan",
  // Bosta spellings
  assuit: "Asyut",
  "bani suif": "Beni Suef",
  behira: "Beheira",
  "el kalioubia": "Qalyubia",
  fayoum: "Faiyum",
  "kafr alsheikh": "Kafr El Sheikh",
  menya: "Minya",
};

export function normalizeGovernorate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const alias = ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed; // assume it's already canonical (exact matches need no mapping)
}
