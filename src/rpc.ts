import { Rpc } from "@opencode/plugin/rpc"
import { diagnostics, stages, type FailureData } from "./diagnostics"

const input = {
  type: "object", properties: { sessionID: { type: "string", minLength: 1, maxLength: 256 }, bundle: { type: "string" }, version: { type: "integer", minimum: 0 } },
  required: ["sessionID"], additionalProperties: false,
} as const
const unavailable = { type: "object", properties: { diagnostic: { type: "string", enum: Object.keys(diagnostics) }, stage: { type: "string", enum: Object.keys(stages) }, httpStatus: { type: "integer", minimum: 100, maximum: 599 } }, additionalProperties: false } as const
const method = { input, output: { type: "object" }, errors: { unavailable } } as const

const mutation = { ...method, input: { ...input, required: ["sessionID", "bundle", "version"] } } as const
const login = {
  input: { type: "object", additionalProperties: false },
  output: { type: "object", properties: { authenticated: { const: true } }, required: ["authenticated"], additionalProperties: false },
  errors: { unavailable, busy: { type: "object", additionalProperties: false } },
} as const
export const BaoRpc = Rpc.define({ id: "opencode.bao", methods: { status: method, enable: mutation, disable: mutation, login }, events: {} })
export type Status = { sessionID: string; version: number; bundles: { name: string; enabled: boolean; keys: number }[]; protectedValues: number; catalogUnavailable?: boolean; catalogFailure?: FailureData }
