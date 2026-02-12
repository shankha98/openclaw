import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const OrchestrationDispatchParamsSchema = Type.Object(
  {
    idempotencyKey: NonEmptyString,
    message: NonEmptyString,
    sessionKey: NonEmptyString,
    targetWorkerId: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    thinking: Type.Optional(NonEmptyString),
    deliver: Type.Optional(Type.Boolean()),
    to: Type.Optional(NonEmptyString),
    channel: Type.Optional(NonEmptyString),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const OrchestrationDispatchResultSchema = Type.Object(
  {
    taskId: NonEmptyString,
    idempotencyKey: NonEmptyString,
    targetWorkerId: NonEmptyString,
    status: Type.Union([Type.Literal("accepted"), Type.Literal("deduped")]),
    acceptedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const OrchestrationStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const OrchestrationWorkerStatusSchema = Type.Object(
  {
    workerId: NonEmptyString,
    live: Type.Boolean(),
    static: Type.Boolean(),
    lastSeenAt: Type.Optional(NonEmptyString),
    ageMs: Type.Optional(Type.Integer({ minimum: 0 })),
    version: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const OrchestrationStatusResultSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    role: Type.Union([Type.Literal("off"), Type.Literal("orchestrator"), Type.Literal("worker")]),
    clusterId: Type.Union([NonEmptyString, Type.Null()]),
    runId: Type.Union([NonEmptyString, Type.Null()]),
    workers: Type.Array(OrchestrationWorkerStatusSchema),
    liveWorkers: Type.Array(NonEmptyString),
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const OrchestrationResultEventSchema = Type.Object(
  {
    schemaVersion: Type.Integer({ minimum: 1 }),
    taskId: NonEmptyString,
    idempotencyKey: NonEmptyString,
    targetWorkerId: NonEmptyString,
    sessionKey: NonEmptyString,
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    summary: NonEmptyString,
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
    startedAt: NonEmptyString,
    finishedAt: NonEmptyString,
    attempt: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
