SHELL := /bin/bash

ORCH_ORCHESTRATOR_PORT ?= 19889
ORCH_SKIP_BUILD ?= 0
ORCH_BURST_COUNT ?= 24
ORCH_RETENTION ?= 7d
ENV_FILE ?=
STATE_INSTANCE_URL ?=
STATE_AUTH_TOKEN ?=
STORAGE_INSTANCE_URL ?=
STORAGE_AUTH_TOKEN ?=
STORAGE_HTTP_PORT ?= 80

.PHONY: help test-docker-orchestration-rice test-docker-orchestration-rice-extended test-docker-orchestration-rice-retention

help:
	@echo "Targets:"
	@echo "  make test-docker-orchestration-rice [ENV_FILE=/abs/path/.env] [STATE_INSTANCE_URL=...] [STATE_AUTH_TOKEN=...] [STORAGE_INSTANCE_URL=...] [STORAGE_AUTH_TOKEN=...] [STORAGE_HTTP_PORT=80] [ORCH_ORCHESTRATOR_PORT=19889] [ORCH_SKIP_BUILD=0]"
	@echo "  make test-docker-orchestration-rice-extended [ENV_FILE=/abs/path/.env] [STATE_INSTANCE_URL=...] [STATE_AUTH_TOKEN=...] [STORAGE_INSTANCE_URL=...] [STORAGE_AUTH_TOKEN=...] [STORAGE_HTTP_PORT=80] [ORCH_ORCHESTRATOR_PORT=19889] [ORCH_SKIP_BUILD=0] [ORCH_BURST_COUNT=24] [ORCH_RETENTION=7d]"
	@echo "  make test-docker-orchestration-rice-retention [ENV_FILE=/abs/path/.env] [STATE_INSTANCE_URL=...] [STATE_AUTH_TOKEN=...] [STORAGE_INSTANCE_URL=...] [STORAGE_AUTH_TOKEN=...] [STORAGE_HTTP_PORT=80] [ORCH_ORCHESTRATOR_PORT=19889] [ORCH_SKIP_BUILD=0] [ORCH_RETENTION=30s]"

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
	if [[ -z "$$state_url" ]]; then state_url="$${STATE_INSTANCE_URL:-}"; fi; \
	if [[ -z "$$state_token" ]]; then state_token="$${STATE_AUTH_TOKEN:-}"; fi; \
	if [[ -z "$$storage_url" ]]; then storage_url="$${STORAGE_INSTANCE_URL:-}"; fi; \
	if [[ -z "$$storage_token" ]]; then storage_token="$${STORAGE_AUTH_TOKEN:-}"; fi; \
	if [[ -z "$$storage_http_port" ]]; then storage_http_port="$${STORAGE_HTTP_PORT:-80}"; fi; \
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
	ORCH_STATE_INSTANCE_URL="$$state_url" \
	ORCH_STATE_AUTH_TOKEN="$$state_token" \
	ORCH_STORAGE_INSTANCE_URL="$$storage_url" \
	ORCH_STORAGE_AUTH_TOKEN="$$storage_token" \
	ORCH_STORAGE_HTTP_PORT="$$storage_http_port" \
	pnpm $(1)
endef

test-docker-orchestration-rice:
	@$(call run_orchestration_test,test:docker:orchestration-rice)

test-docker-orchestration-rice-extended:
	@$(call run_orchestration_test,test:docker:orchestration-rice:extended)

test-docker-orchestration-rice-retention:
	@$(call run_orchestration_test,test:docker:orchestration-rice:retention)
