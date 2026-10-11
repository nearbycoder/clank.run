import { createManagedIngress, type IngressRoute } from "@clank.run/framework";

createManagedIngress({ routes: () => [], assertCanaryCurrent(route) {
  const primary: Readonly<IngressRoute> = route;
  const primaryRelease: string | undefined = primary.releaseId;
  const candidateRelease: string | undefined = primary.canary?.releaseId;
  const candidateGeneration: number | undefined = primary.canary?.runtime?.generation;
  void primaryRelease; void candidateRelease; void candidateGeneration;
  // @ts-expect-error Captured route identity is readonly.
  route.projectId = "another_project";
  return undefined;
} });

// @ts-expect-error Authority checks cannot return a promise.
createManagedIngress({ routes: () => [], assertCanaryCurrent: async () => undefined });
// @ts-expect-error A truthy result is not native authority.
createManagedIngress({ routes: () => [], assertCanaryCurrent: () => true });
