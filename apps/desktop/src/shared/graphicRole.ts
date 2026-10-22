/** What a visual layer is for (CONTEXT.md "Graphic role") — the key a style's
 *  tokens and role-specific checks attach to. Stored as `graphic_role` on Text,
 *  Motif and ImageOverlay params and declared by a Motif manifest; null means
 *  untagged.
 *
 *  Any well-formed name is accepted at write time: a name outside the built-ins
 *  is a custom role, and whether the project's taste declares it is the lint's
 *  question, not the store's — a TASTE edit must never make a project
 *  unwritable. */
export const BUILTIN_GRAPHIC_ROLES = ['title', 'lower_third', 'callout', 'credit', 'logo', 'plate', 'illustration', 'none'] as const

export const GRAPHIC_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/** Why `value` cannot be stored as a `graphic_role`, or null when it can. */
export function graphicRoleProblem(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !GRAPHIC_ROLE_PATTERN.test(value))
    return `graphic_role must be null or a lowercase name matching ${GRAPHIC_ROLE_PATTERN.source} (built-ins: ${BUILTIN_GRAPHIC_ROLES.join(', ')}) — got ${JSON.stringify(value) ?? String(value)}`
  return null
}
