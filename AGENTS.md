# Agent entry point — مقطوب

These instructions apply to the entire repository. Read [RULES.md](RULES.md) and `PROJECT_GUIDE.md` before planning or editing. `RULES.md` is the shared working-rules reference; this file is its short entry point.

## Start each task
- Read this file, `RULES.md`, `PROJECT_GUIDE.md`, `README.md`, then any applicable nested instructions.
- For data, storage, keys, migrations or releases, read `docs/operations/BACKUP_AND_RECOVERY.md`; its targets are proposals until approved and measured.
- Inspect Git status and the actual files; preserve other people's uncommitted changes.
- Treat the guide's current-state section as a dated baseline, not proof that code exists today.
- Identify the requested scope and relevant requirement IDs before changing anything.
- Follow the latest explicit user decisions; document superseded decisions instead of silently combining them.

## Non-negotiable project boundaries
- Customer: Android/iOS. Merchant: Android/iOS/Windows. Admin: Windows only. Courier: Android.
- No user-facing web application for any role. Shared server APIs are still required.
- Do not implement business features merely because they appear in the roadmap.
- Do not import the old project's code, database, credentials, or test claims wholesale.
- Keep customer data, credentials, private attachments and raw source PDFs out of this public repository.
- Backend authorization is mandatory; never trust a role, tenant, price or payment status supplied by a client or AI.
- Changes to money, stock, provider events and synchronization must tolerate retries without duplicate effects.
- AI mutations require an authorized user's preview and confirmation; recheck permissions and record version at execution.
- Never claim a mock, zero-test run or parser simulation proves PostgreSQL, provider or production readiness.
- Do not claim backups work without isolated restore evidence. Never overwrite live data with an older backup without incident authorization and reconciliation of subsequent writes and external payments.

## Work and handoff
- Use a short task branch and a pull request; do not self-approve or merge without the required review.
- Use available skills by capability; missing optional skills do not block ordinary work.
- Do not install skills or dependencies unrelated to the active task.
- Run checks appropriate to the change; do not fabricate commands for software that is not present.
- Record what changed, actual checks and results, remaining blockers and the next step.
- Update the guide when an approved decision or actual repository state changes.
- This guide does not grant permission to publish, deploy, delete data, contact providers or perform unrelated work.
