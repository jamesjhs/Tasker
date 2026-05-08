# GitHub Copilot Instructions for Tasker

## When to Apply These Instructions

These instructions define **end-of-task** actions. Apply the Versioning, Validation, and Documentation steps **once only, when the task is fully complete** — not during iterative back-and-forth within a session. If the user is still refining requirements or reviewing intermediate output, hold off until the final implementation is confirmed and stable.

## Versioning

Once the task is complete, increment the **patch** version in `package.json` (e.g. `1.13.2` → `1.13.3`) unless the user explicitly requests a **minor** or **major** version bump. Use this rule:

- **Patch** (default): bug fixes, small features, refactors, dependency updates → `x.y.Z`
- **Minor** (when instructed): new user-facing features, non-breaking additions → `x.Y.0`
- **Major** (when instructed): breaking changes, architectural overhauls → `X.0.0`

## Validation Checklist

Once the task is complete, run the following once and fix any issues before closing out:

```
npm run build    # TypeScript compilation — zero errors required
npm test         # All 221 tests must pass
npm audit        # No high or critical vulnerabilities; update affected packages
```

If `npm audit` reports vulnerabilities, run `npm audit fix` and, if needed, `npm audit fix --force` — but review forced upgrades for breaking changes first.

## Documentation

Once the task is complete, update all documentation affected by the changes made:

- **`docs/installation.md`** — update if installation steps, environment variables, dependencies, or system requirements change
- **`docs/technical-manual.html`** — update if architecture, API routes, database schema, configuration, or internal behaviour changes
- **`docs/maintenance.md`** — update if operational, backup, or maintenance procedures change
- **`README.md`** — update if user-facing features, setup steps, or the feature list changes

Only update documentation for **non-admin, user-facing front-end changes** where it affects the user experience visible to standard users. Admin-only changes should be reflected in the technical manual but not in end-user docs.

Apply the **same version number** used in `package.json` to all updated documents. Version strings appear in these formats — update all occurrences:
- Markdown: `**Version x.y.z — Month YYYY**` or `**vx.y.z**`
- HTML `<title>` and headings: `vx.y.z`

Update the month/year alongside the version where it appears.

## Code Quality Standards

Every change must be evaluated against the following before completion:

1. **Function** — does it do what was asked, correctly and completely?
2. **Efficiency** — no unnecessary database queries, loops, or blocking operations
3. **Security** — input validated and sanitised; no injection vectors; auth enforced; rate limiting respected; Turnstile CAPTCHA checked where applicable
4. **Accessibility** — UI changes must use semantic HTML, ARIA attributes where needed, and keyboard-navigable controls
5. **Deliberate attack** — consider SQL injection, XSS, CSRF, brute force, privilege escalation, and path traversal
6. **User error** — graceful handling of missing input, unexpected types, and edge cases with clear user feedback
