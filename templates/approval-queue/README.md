# __PROJECT_TITLE__

Submit requests for a separate reviewer to approve or reject.

Run `npm install`, `npm test`, `npm run dev`, `npm run doctor`, and `npm run deploy:check`. `npm run deploy` uses the ordinary Clank deployment flow.

The backend, typed UI actions, automatic MCP/OAuth surface, synthetic fixture, and application contract live in this project. Modify these readable files for your product. Lists show the latest 100 visible records.

New accounts are members. Provision a reviewer through trusted server code using `runtime.auth.setRole(userId, "reviewer")`; no browser endpoint can grant roles. Reviewers see requests across this application and cannot approve their own submissions. Decisions are final in this recipe.

Shared workflow rows store an explicit owner ID. Every query and mutation applies its appropriate account or privileged-role check. Keep those checks when extending the schema.
