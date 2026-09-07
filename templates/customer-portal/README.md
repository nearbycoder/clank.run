# __PROJECT_TITLE__

Private service requests with staff responses and customer-controlled closure.

Run `npm install`, `npm test`, `npm run dev`, `npm run doctor`, and `npm run deploy:check`. `npm run deploy` uses the ordinary Clank deployment flow.

The backend, typed UI actions, automatic MCP/OAuth surface, synthetic fixture, and application contract live in this project. Modify these readable files for your product. Lists show the latest 100 visible records.

Customers see only their own requests. Provision support staff through trusted server code using `runtime.auth.setRole(userId, "staff")`. Staff can see all requests and add responses; customers can close/reopen their own requests. This recipe does not include billing or document uploads.

Shared workflow rows store an explicit owner ID. Every query and mutation applies its appropriate account or privileged-role check. Keep those checks when extending the schema.
