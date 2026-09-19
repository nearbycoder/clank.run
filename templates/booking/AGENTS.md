# Recipe maintenance

Run `npm test`, `npm run doctor`, and `npm run deploy:check`. Keep the backend's authorization, optimistic version checks, and transition rules aligned with the UI and MCP contract. Test two accounts and the privileged role where applicable. Keep health independent of optional services. Never edit applied migrations or generated dist files. Synthetic fixtures use example.invalid identities; never production data. Verify sign-in, the primary create action, and narrow-screen layout in a browser after UI changes.
