// ─────────────────────────────────────────────────────────────────────────────
// THE GROWER-PORTAL ACTIVATION LIST — hand-curated, and THE source of truth.
//
// Tim, 2026-07-22: "I just want to hand select the growers that are able to access the portal and
// for that status to be maintained on the data-hub side rather than via the admin UI on the
// grower-portal side."
//
// So: this file decides who appears in the grower portal. Edit it, then run
//
//     npm run portal:activate            # DRY RUN — prints the diff, writes nothing
//     npm run portal:activate -- --apply # writes core.portal_grower_activation
//
// Git is the audit trail: every change to who can see the portal is a reviewable diff with a
// reason attached, instead of an untracked click in someone's admin screen.
//
// RULES
//  • Identify growers by CODE, never uuid (the 0059 rule) — codes are what humans recognise and
//    what the remittances carry. `dim_grower.code` is NOT unique (WADDA exists as an active and an
//    inactive row), so the applier resolves code + is_active and REFUSES to guess if that is not
//    exactly one row.
//  • Anything not listed here is deactivated on the next --apply. Absence means "no portal".
//  • A `note` is mandatory. Six months from now the reason is the only thing that matters.
//  • Deactivating here removes a grower from the portal's directory. It does NOT revoke data
//    access — no RLS policy reads activation. That needs the claim-side gate in
//    semantic.auth0_consignor_ids(); until it exists, activation is a presentation control.
// ─────────────────────────────────────────────────────────────────────────────

export interface PortalActivationEntry {
  /** core.dim_grower.code of the ACTIVE row (e.g. 'MACSD'). */
  code: string;
  /** Why this grower has portal access. Mandatory — no silent entries. */
  note: string;
}

/**
 * Baseline set 2026-07-22 (migration 0063): the 25 consignors with a remittance in
 * SharePoint TullyAdmin/.../Remittances/Growers/2026 (all 30 pay-week folders, 07.01 → 15.07),
 * plus 4 parent entities Tim chose to retain because logins are often at parent level.
 */
export const PORTAL_ACTIVATION: PortalActivationEntry[] = [
  // ── Growers with a 2026 remittance ────────────────────────────────────────
  { code: 'ALCOC', note: '2026 remittances (Jan–May); 11 settlement schedules in 2026' },
  { code: 'DANDY', note: '2026 remittance 08.07.2026; 1 settlement schedule' },
  { code: 'GJFMF', note: '2026 remittances — "Flegler"/"GJ Flegler Mareeba Farm"; 27 schedules' },
  { code: 'JUSTE', note: '2026 remittances (Jan–Jul), "Justeatum"/"Justeatem"; 11 schedules' },
  { code: 'LAUGO', note: '2026 remittances (Laurelgold), weekly' },
  { code: 'LMBCO', note: '2026 remittances (LMB Cooroo), weekly' },
  { code: 'LMBEP', note: '2026 remittances (LMB East Palmerston), weekly' },
  { code: 'LRCLA', note: '2026 remittances (Collins Lakeland), weekly' },
  { code: 'LRCTU', note: '2026 remittances (Collins Tully), weekly' },
  { code: 'MACBO', note: '2026 remittances (Mackays Bolinda), weekly' },
  { code: 'MACGT', note: '2026 remittances (Mackays Gold Tyne, incl. the Passionfruit PDF)' },
  { code: 'MACRR', note: '2026 remittances (Mackays Ranch Road), weekly' },
  { code: 'MACSD', note: '2026 remittances (Mackays South Davidson), weekly' },
  { code: 'NOUBC', note: '2026 remittances (Nourish), weekly' },
  { code: 'NOUPA', note: '2026 remittances (Nourish Papaya), from 27.05.2026' },
  { code: 'OBIFW', note: '2026 remittances (Obie) Mar/Apr/Jun; 7 schedules' },
  { code: 'PRIMO', note: '2026 remittances (Primo Produce), from 25.03.2026' },
  { code: 'ROCKR', note: '2026 remittances (Rockridge), weekly' },
  { code: 'ROLFE', note: '2026 remittances (Rolfe, incl. the Rolfe Papaya PDF)' },
  { code: 'SANGH', note: '2026 remittances (Sangha Bros) ×4: 18.02, 04.03, 11.03, 18.03; 4 schedules' },
  { code: 'SERAV', note: '2026 remittances (Serra Avocados), from 18.03.2026' },
  { code: 'SERRA', note: '2026 remittances (Serra Farming), weekly' },
  { code: 'SLOWE', note: '2026 remittances (Lowe / S. Lowe & Sons), weekly' },
  { code: 'WADDA', note: '2026 remittances (Wadda Plantation) — the ACTIVE row, not "- Gallaghers"' },
  { code: 'ZONTA', note: "2026 remittances (Zonta's Bananas), weekly" },

  // ── Parent entities: NO remittance of their own (settlement lands on their farms), retained on
  //    Tim's explicit decision 2026-07-22 because portal logins are often at parent level and the
  //    directory groups by parent (0058). Deactivating them would strand a parent login while its
  //    farms stayed live.
  { code: 'GJFLE', note: 'PARENT of GJFMF — retained for parent-level login/grouping, not paid directly' },
  { code: 'LMBFA', note: 'PARENT of LMBCO/LMBEP — retained for parent-level login/grouping' },
  { code: 'LRCOL', note: 'PARENT of LRCLA/LRCTU — retained for parent-level login/grouping' },
  { code: 'MACKF', note: 'PARENT of MACBO/MACGT/MACRR/MACSD — retained for parent-level login/grouping' },
];

/** Codes listed above, for the applier. Duplicates are a mistake — surfaced, never deduped away. */
export function activationCodes(): string[] {
  return PORTAL_ACTIVATION.map((e) => e.code);
}

/** Duplicate codes in the list (should always be empty). */
export function duplicateCodes(): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const code of activationCodes()) {
    if (seen.has(code)) dupes.add(code);
    seen.add(code);
  }
  return [...dupes].sort();
}

/** Entries missing a usable note (mandatory). */
export function entriesMissingNote(): string[] {
  return PORTAL_ACTIVATION.filter((e) => !e.note || e.note.trim() === '').map((e) => e.code);
}
