import { createManagedIngress, type IngressShadowMetadata, type IngressShadowObserver, type IngressShadowTap } from "@clank.run/framework";

const tap: IngressShadowTap = { chunk(bytes) { const length: number = bytes; void length; return undefined; }, finish(kind, elapsed) {
  const outcome: "complete" | "cancelled" | "error" = kind; const duration: number = elapsed; void outcome; void duration; return undefined;
} };
const shadow: IngressShadowObserver = { observe(request, primary, metadata) {
  const input: Request = request; const bounded: Readonly<IngressShadowMetadata> = metadata; void input; void bounded;
  // @ts-expect-error Captured identity is readonly.
  primary.projectId = "another";
  // @ts-expect-error Body bytes are never exposed.
  metadata.body;
  return tap;
} };
createManagedIngress({ routes: () => [], shadow });
// @ts-expect-error Observation cannot wait for a reservation.
createManagedIngress({ routes: () => [], shadow: { observe: async () => tap } });
// @ts-expect-error Byte callbacks must be synchronous.
const asyncTap: IngressShadowTap = { chunk: async () => undefined, finish: () => undefined };
// @ts-expect-error Arbitrary truthy callback returns are refused.
const invalidTap: IngressShadowTap = { chunk: () => true, finish: () => undefined };
void asyncTap; void invalidTap;
