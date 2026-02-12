SHELL := /bin/bash

ORCH_ORCHESTRATOR_PORT ?= 19889
ORCH_SKIP_BUILD ?= 0
ORCH_BURST_COUNT ?= 24
ORCH_RETENTION ?= 7d
ORCH_HEARTBEAT_INTERVAL ?= 2s
ORCH_HEARTBEAT_TTL ?= 8s
ORCH_POLL_INTERVAL ?= 2s
ORCH_OPENCLAW_SKIP_CHANNELS ?= 1
ORCH_DELIVER_CHANNEL ?=
ORCH_DELIVER_TO ?=
ORCH_DELIVER_TIMEOUT_MS ?= 120000
ORCH_EXT_CONNECT_TIMEOUT_MS ?= 60000
ORCH_EXT_CONNECT_CHALLENGE_TIMEOUT_MS ?= 1000
ORCH_EXT_STATUS_RPC_TIMEOUT_MS ?= 20000
ORCH_EXT_DISPATCH_RPC_TIMEOUT_MS ?= 30000
ORCH_EXT_TASK_TIMEOUT_MS ?= 120000
ORCH_EXT_LIVE_WAIT_TIMEOUT_MS ?= 60000
ORCH_EXT_FAILOVER_OFFLINE_WAIT_TIMEOUT_MS ?= 45000
ORCH_EXT_BURST_RESULTS_TIMEOUT_MS ?= 180000
ORCH_EXT_OBSERVER_RESULT_TIMEOUT_MS ?= 6000
ORCH_EXT_EXTERNAL_RESULT_BUFFER_MS ?= 60000
ORCH_EXT_RETENTION_MAX_MS ?= 120000
ORCH_EXT_RETENTION_WAIT_FLOOR_MS ?= 60000
ORCH_EXT_RETENTION_EXTRA_WAIT_MS ?= 45000
GEMINI_API_KEY ?=
TELEGRAM_BOT_TOKEN ?=
ENV_FILE ?=
STATE_INSTANCE_URL ?=
STATE_AUTH_TOKEN ?=
STORAGE_INSTANCE_URL ?=
STORAGE_AUTH_TOKEN ?=
STORAGE_HTTP_PORT ?= 80

.PHONY: help test-docker-orchestration-rice test-docker-orchestration-rice-extended test-docker-orchestration-rice-retention test-docker-orchestration-rice-external-delivery

help:
	@echo "Targets:"
	@echo "  make test-docker-orchestration-rice [ENV_FILE=/abs/path/.env] [GEMINI_API_KEY=...] [STATE_INSTANCE_URL=...] [STATE_AUTH_TOKEN=...] [STORAGE_INSTANCE_URL=...] [STORAGE_AUTH_TOKEN=...] [STORAGE_HTTP_PORT=80] [ORCH_ORCHESTRATOR_PORT=19889] [ORCH_SKIP_BUILD=0]"
	@echo "  make test-docker-orchestration-rice-extended [ENV_FILE=/abs/path/.env] [GEMINI_API_KEY=...] [STATE_INSTANCE_URL=...] [STATE_AUTH_TOKEN=...] [STORAGE_INSTANCE_URL=...] [STORAGE_AUTH_TOKEN=...] [STORAGE_HTTP_PORT=80] [ORCH_ORCHESTRATOR_PORT=19889] [ORCH_SKIP_BUILD=0] [ORCH_BURST_COUNT=24] [ORCH_RETENTION=7d] [ORCH_HEARTBEAT_TTL=8s] [ORCH_EXT_BURST_RESULTS_TIMEOUT_MS=180000]"
	@echo "  make test-docker-orchestration-rice-retention [ENV_FILE=/abs/path/.env] [GEMINI_API_KEY=...] [STATE_INSTANCE_URL=...] [STATE_AUTH_TOKEN=...] [STORAGE_INSTANCE_URL=...] [STORAGE_AUTH_TOKEN=...] [STORAGE_HTTP_PORT=80] [ORCH_ORCHESTRATOR_PORT=19889] [ORCH_SKIP_BUILD=0] [ORCH_RETENTION=2m]"
	@echo "  make test-docker-orchestration-rice-external-delivery [ENV_FILE=/abs/path/.env] [GEMINI_API_KEY=...] [ORCH_DELIVER_CHANNEL=telegram] [ORCH_DELIVER_TO=123456789] [TELEGRAM_BOT_TOKEN=...] [ORCH_OPENCLAW_SKIP_CHANNELS=0]"

define run_orchestration_test
	set -euo pipefail; \
	if [[ -n "$(ENV_FILE)" ]]; then \
		if [[ ! -f "$(ENV_FILE)" ]]; then \
			echo "ENV_FILE not found: $(ENV_FILE)"; \
			exit 1; \
		fi; \
		set -a; \
		source "$(ENV_FILE)"; \
		set +a; \
	fi; \
	state_url="$(STATE_INSTANCE_URL)"; \
	state_token="$(STATE_AUTH_TOKEN)"; \
	storage_url="$(STORAGE_INSTANCE_URL)"; \
	storage_token="$(STORAGE_AUTH_TOKEN)"; \
	storage_http_port="$(STORAGE_HTTP_PORT)"; \
	gemini_api_key="$(GEMINI_API_KEY)"; \
	telegram_bot_token="$(TELEGRAM_BOT_TOKEN)"; \
	if [[ -z "$$state_url" ]]; then state_url="$${STATE_INSTANCE_URL:-}"; fi; \
	if [[ -z "$$state_token" ]]; then state_token="$${STATE_AUTH_TOKEN:-}"; fi; \
	if [[ -z "$$storage_url" ]]; then storage_url="$${STORAGE_INSTANCE_URL:-}"; fi; \
	if [[ -z "$$storage_token" ]]; then storage_token="$${STORAGE_AUTH_TOKEN:-}"; fi; \
	if [[ -z "$$storage_http_port" ]]; then storage_http_port="$${STORAGE_HTTP_PORT:-80}"; fi; \
	if [[ -z "$$gemini_api_key" ]]; then gemini_api_key="$${GEMINI_API_KEY:-}"; fi; \
	if [[ -z "$$telegram_bot_token" ]]; then telegram_bot_token="$${TELEGRAM_BOT_TOKEN:-}"; fi; \
	if [[ -z "$$state_url" ]]; then \
		echo "Missing STATE_INSTANCE_URL (set flag or ENV_FILE)"; \
		exit 1; \
	fi; \
	if [[ -z "$$state_token" ]]; then \
		echo "Missing STATE_AUTH_TOKEN (set flag or ENV_FILE)"; \
		exit 1; \
	fi; \
	if [[ -z "$$storage_url" ]]; then \
		echo "Missing STORAGE_INSTANCE_URL (set flag or ENV_FILE)"; \
		exit 1; \
	fi; \
	if [[ -z "$$storage_token" ]]; then \
		echo "Missing STORAGE_AUTH_TOKEN (set flag or ENV_FILE)"; \
		exit 1; \
	fi; \
	ORCH_ORCHESTRATOR_PORT="$(ORCH_ORCHESTRATOR_PORT)" \
	ORCH_SKIP_BUILD="$(ORCH_SKIP_BUILD)" \
	ORCH_BURST_COUNT="$(ORCH_BURST_COUNT)" \
	ORCH_RETENTION="$(ORCH_RETENTION)" \
	ORCH_HEARTBEAT_INTERVAL="$(ORCH_HEARTBEAT_INTERVAL)" \
	ORCH_HEARTBEAT_TTL="$(ORCH_HEARTBEAT_TTL)" \
	ORCH_POLL_INTERVAL="$(ORCH_POLL_INTERVAL)" \
	ORCH_OPENCLAW_SKIP_CHANNELS="$(ORCH_OPENCLAW_SKIP_CHANNELS)" \
	ORCH_DELIVER_CHANNEL="$(ORCH_DELIVER_CHANNEL)" \
	ORCH_DELIVER_TO="$(ORCH_DELIVER_TO)" \
	ORCH_DELIVER_TIMEOUT_MS="$(ORCH_DELIVER_TIMEOUT_MS)" \
	ORCH_EXT_CONNECT_TIMEOUT_MS="$(ORCH_EXT_CONNECT_TIMEOUT_MS)" \
	ORCH_EXT_CONNECT_CHALLENGE_TIMEOUT_MS="$(ORCH_EXT_CONNECT_CHALLENGE_TIMEOUT_MS)" \
	ORCH_EXT_STATUS_RPC_TIMEOUT_MS="$(ORCH_EXT_STATUS_RPC_TIMEOUT_MS)" \
	ORCH_EXT_DISPATCH_RPC_TIMEOUT_MS="$(ORCH_EXT_DISPATCH_RPC_TIMEOUT_MS)" \
	ORCH_EXT_TASK_TIMEOUT_MS="$(ORCH_EXT_TASK_TIMEOUT_MS)" \
	ORCH_EXT_LIVE_WAIT_TIMEOUT_MS="$(ORCH_EXT_LIVE_WAIT_TIMEOUT_MS)" \
	ORCH_EXT_FAILOVER_OFFLINE_WAIT_TIMEOUT_MS="$(ORCH_EXT_FAILOVER_OFFLINE_WAIT_TIMEOUT_MS)" \
	ORCH_EXT_BURST_RESULTS_TIMEOUT_MS="$(ORCH_EXT_BURST_RESULTS_TIMEOUT_MS)" \
	ORCH_EXT_OBSERVER_RESULT_TIMEOUT_MS="$(ORCH_EXT_OBSERVER_RESULT_TIMEOUT_MS)" \
	ORCH_EXT_EXTERNAL_RESULT_BUFFER_MS="$(ORCH_EXT_EXTERNAL_RESULT_BUFFER_MS)" \
	ORCH_EXT_RETENTION_MAX_MS="$(ORCH_EXT_RETENTION_MAX_MS)" \
	ORCH_EXT_RETENTION_WAIT_FLOOR_MS="$(ORCH_EXT_RETENTION_WAIT_FLOOR_MS)" \
	ORCH_EXT_RETENTION_EXTRA_WAIT_MS="$(ORCH_EXT_RETENTION_EXTRA_WAIT_MS)" \
	ORCH_STATE_INSTANCE_URL="$$state_url" \
	ORCH_STATE_AUTH_TOKEN="$$state_token" \
	ORCH_STORAGE_INSTANCE_URL="$$storage_url" \
	ORCH_STORAGE_AUTH_TOKEN="$$storage_token" \
	ORCH_STORAGE_HTTP_PORT="$$storage_http_port" \
	ORCH_GEMINI_API_KEY="$$gemini_api_key" \
	ORCH_TELEGRAM_BOT_TOKEN="$$telegram_bot_token" \
	pnpm $(1)
endef

test-docker-orchestration-rice:
	@$(call run_orchestration_test,test:docker:orchestration-rice)

test-docker-orchestration-rice-extended:
	@$(call run_orchestration_test,test:docker:orchestration-rice:extended)

test-docker-orchestration-rice-retention:
	@$(call run_orchestration_test,test:docker:orchestration-rice:retention)

test-docker-orchestration-rice-external-delivery:
	@$(call run_orchestration_test,test:docker:orchestration-rice:external-delivery)
