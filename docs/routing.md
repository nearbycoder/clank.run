# Routing

## Define and start a router

```tsx
const router = createRouter({
  routes: [
    { path: "/", component: Home, title: "Home" },
    {
      path: "/users/:id",
      component: User,
      title: match => `User ${match.params.id}`,
      load: async ({ params, signal }) => {
        const response = await fetch(`/api/users/${params.id}`, { signal });
        return response.json();
      },
    },
    { path: "/docs/:page?", component: Docs },
    { path: "*", component: NotFound },
  ],
  loading: Loading,
  error: LoadError,
});

const stop = router.start();
render(root, <router.View />);
```

Routes are checked in declaration order. Put a wildcard last.

## Patterns

- `/users/:id` captures one required segment.
- `/docs/:page?` captures an optional segment.
- `/files/*` captures the remainder as `wildcard`.
- `*` matches every path.

Captured values are URI-decoded. `matchPath()` and `matchRoutes()` are exported for server and test use.

## Component props

The matched component receives `{ route, params, query, data }`. Repeated query keys become arrays; a single value remains a string.

## Links and navigation

```tsx
<router.Link to="/users/42" class="underline">Open user</router.Link>

await router.navigate("/users/42");
await router.navigate("/login", { replace: true, state: { from: "/private" } });
```

Router links render ordinary anchors with `data-clank-link`. Modified clicks, downloads, explicit targets, external origins, and already-prevented events retain native browser behavior.

## Loaders and cancellation

Navigation sets the route to `loading`, passes an `AbortSignal` to its loader, then commits `ready` data. The previous loader is aborted on a newer navigation, and revision checks reject stale results even if the loader ignores abort.

## Guards

```ts
guard: ({ from, params }) => {
  if (!session.value) return `/login?next=/projects/${params.id}`;
  return true;
}
```

A guard may return `true`, `false`, or a redirect URL, synchronously or asynchronously. `false` cancels navigation. A string recursively navigates with replacement.

## Base paths and non-browser resolution

Set `base: "/app"` when hosted below an origin root. `matchRoutes()` and `resolve(url)` also work without a browser; relative URLs use a safe internal origin.
