import type { GatewayRequestHandlers } from "./types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateOrchestrationDispatchParams,
  validateOrchestrationStatusParams,
} from "../protocol/index.js";

export const orchestrationHandlers: GatewayRequestHandlers = {
  "orchestration.dispatch": async ({ params, respond, context, client }) => {
    if (!validateOrchestrationDispatchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid orchestration.dispatch params: ${formatValidationErrors(
            validateOrchestrationDispatchParams.errors,
          )}`,
        ),
      );
      return;
    }
    const runtime = context.orchestration;
    if (!runtime || runtime.role() !== "orchestrator") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "orchestration.dispatch is only available when role=orchestrator",
        ),
      );
      return;
    }

    const request = params as {
      idempotencyKey: string;
      message: string;
      sessionKey: string;
      targetWorkerId?: string;
      agentId?: string;
      thinking?: string;
      deliver?: boolean;
      to?: string;
      channel?: string;
      timeoutMs?: number;
    };

    try {
      const payload = await runtime.dispatch(
        {
          idempotencyKey: request.idempotencyKey,
          message: request.message,
          sessionKey: request.sessionKey,
          targetWorkerId: request.targetWorkerId,
          agentId: request.agentId,
          thinking: request.thinking,
          deliver: request.deliver,
          to: request.to,
          channel: request.channel,
          timeoutMs: request.timeoutMs,
        },
        {
          requesterConnId: client?.connId,
          createdBy: client?.connect?.client?.id,
        },
      );
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "orchestration.status": async ({ params, respond, context }) => {
    if (!validateOrchestrationStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid orchestration.status params: ${formatValidationErrors(
            validateOrchestrationStatusParams.errors,
          )}`,
        ),
      );
      return;
    }

    if (!context.orchestration) {
      respond(
        true,
        {
          enabled: false,
          role: "off",
          clusterId: null,
          runId: null,
          workers: [],
          liveWorkers: [],
          ts: Date.now(),
        },
        undefined,
      );
      return;
    }

    try {
      const status = await context.orchestration.status();
      respond(true, status, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
