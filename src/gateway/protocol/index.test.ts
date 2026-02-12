import type { ErrorObject } from "ajv";
import { describe, expect, it } from "vitest";
import {
  formatValidationErrors,
  validateOrchestrationDispatchParams,
  validateOrchestrationResultEvent,
  validateOrchestrationStatusParams,
} from "./index.js";

const makeError = (overrides: Partial<ErrorObject>): ErrorObject => ({
  keyword: "type",
  instancePath: "",
  schemaPath: "#/",
  params: {},
  message: "validation error",
  ...overrides,
});

describe("formatValidationErrors", () => {
  it("returns unknown validation error when missing errors", () => {
    expect(formatValidationErrors(undefined)).toBe("unknown validation error");
    expect(formatValidationErrors(null)).toBe("unknown validation error");
  });

  it("returns unknown validation error when errors list is empty", () => {
    expect(formatValidationErrors([])).toBe("unknown validation error");
  });

  it("formats additionalProperties at root", () => {
    const err = makeError({
      keyword: "additionalProperties",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at root: unexpected property 'token'");
  });

  it("formats additionalProperties with instancePath", () => {
    const err = makeError({
      keyword: "additionalProperties",
      instancePath: "/auth",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at /auth: unexpected property 'token'");
  });

  it("formats message with path for other errors", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err])).toBe("at /auth: must have required property 'token'");
  });

  it("de-dupes repeated entries", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err, err])).toBe(
      "at /auth: must have required property 'token'",
    );
  });
});

describe("orchestration protocol validators", () => {
  it("accepts valid orchestration.dispatch params", () => {
    expect(
      validateOrchestrationDispatchParams({
        idempotencyKey: "idem-1",
        message: "hello",
        sessionKey: "agent:main:main",
        timeoutMs: 15_000,
      }),
    ).toBe(true);
  });

  it("rejects invalid orchestration.dispatch params", () => {
    expect(
      validateOrchestrationDispatchParams({
        idempotencyKey: "",
        message: "hello",
        sessionKey: "agent:main:main",
      }),
    ).toBe(false);
  });

  it("accepts orchestration.status params", () => {
    expect(validateOrchestrationStatusParams({})).toBe(true);
  });

  it("accepts orchestration.result event payloads", () => {
    expect(
      validateOrchestrationResultEvent({
        schemaVersion: 1,
        taskId: "task-1",
        idempotencyKey: "idem-1",
        targetWorkerId: "worker-a",
        sessionKey: "agent:main:main",
        status: "ok",
        summary: "done",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempt: 1,
      }),
    ).toBe(true);
  });
});
