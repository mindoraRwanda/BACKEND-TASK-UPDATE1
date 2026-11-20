# Backend CI formatting repair

This change applies the repository's pinned Prettier formatter to the seven
TypeScript files previously reported by the backend CI `format:check` step.

The repair is formatting-only. It does not intentionally change application
logic, database schemas, migrations, or runtime configuration.

The pull request must pass the full backend CI workflow before it is merged.
