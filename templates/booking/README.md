# __PROJECT_TITLE__

Reserve one 30-minute consultation. Start times use UTC.

Run `npm install`, `npm test`, `npm run dev`, `npm run doctor`, and `npm run deploy:check`. `npm run deploy` uses the ordinary Clank deployment flow.

The backend, typed UI actions, automatic MCP/OAuth surface, synthetic fixture, and application contract live in this project. Modify these readable files for your product. Lists show the latest 100 visible records.

One shared consultation resource has 30-minute slots on UTC half-hours within the next 90 days. Overlap checks and inserts share one write transaction, preventing concurrent double booking. Users see/cancel only their own appointments. This recipe does not send reminders or take payments.

Shared workflow rows store an explicit owner ID. Every query and mutation applies its appropriate account or privileged-role check. Keep those checks when extending the schema.
