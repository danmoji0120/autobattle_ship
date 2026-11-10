# SIDERARIUM Oracle production cutover

- Target branch: `deploy/production`.
- Source application revision: `398c63fa4c8a94329b433d7946ad40bd6c1d0981`.
- Render service was suspended by the operator before this cutover.
- The production PostgreSQL database remains hosted on Supabase; no restore is performed as part of deployment.
- A PostgreSQL custom-format backup was validated and stored off-host before cutover.
- GitHub Actions builds and activates only when `OCI_DEPLOY_ENABLED=true`; production fails closed without a reachable database.
- Never run the Render and OCI application writers simultaneously against the same world state.
