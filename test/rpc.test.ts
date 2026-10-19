import { expect, test } from "vitest"
import { Effect, JsonSchema, Schema, SchemaRepresentation } from "effect"
import { BaoRpc } from "../src/rpc"

// Match OpenCode 2.0.31 packages/core/src/rpc.ts parse(), without pattern overrides.
const codec = (schema: JsonSchema.JsonSchema) => Schema.make<Schema.Codec<unknown>>(
  SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema)).ast,
)

test("native RPC conversion decodes every Bao method input without enabling JSON Schema patterns", async () => {
  const inputs = {
    status: { sessionID: "synthetic-session" },
    enable: { sessionID: "synthetic-session", bundle: "alpha.env-1", version: 0 },
    disable: { sessionID: "synthetic-session", bundle: "alpha.env-1", version: 1 },
    login: {},
  }
  for (const name of Object.keys(inputs) as (keyof typeof inputs)[]) {
    const input = inputs[name]
    expect(await Effect.runPromise(Schema.decodeUnknownEffect(codec(BaoRpc.methods[name].input))(input))).toEqual(input)
  }
})

test("the previous optional bundle pattern blocks native conversion even for status", () => {
  const schema = BaoRpc.methods.status.input
  expect(() => codec({
    ...schema,
    properties: { ...schema.properties, bundle: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } },
  })).toThrow('Patterns may block validation and are disabled. Use patterns: "apply" for trusted schemas or "ignore" to discard them.')
})
