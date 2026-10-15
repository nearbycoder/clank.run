// Internal provenance only; JSON metadata supplied by a custom schema is not
// evidence that the built-in object parser synthesized an absent field.
const schemas = new WeakMap<object, { parse: unknown; json: unknown; children: readonly object[] }>();

export function registerBuiltinSchema(schema: { parse: unknown; toJSONSchema: unknown }, children: readonly object[]): void {
  schemas.set(schema, { parse: schema.parse, json: schema.toJSONSchema, children: [...children] });
}

export function isBuiltinSchema(schema: object): boolean {
  const seen = new WeakSet<object>();
  const visit = (value: object): boolean => {
    if (seen.has(value)) return true;
    const known = schemas.get(value), current = value as { parse?: unknown; toJSONSchema?: unknown };
    if (!known || current.parse !== known.parse || current.toJSONSchema !== known.json) return false;
    seen.add(value);
    return known.children.every(visit);
  };
  return visit(schema);
}
