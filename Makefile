# Usage: make up | down | logs | migrate | test | ps | restart
SHELL := /bin/bash

SANDBOX_INTERNET ?= $(shell grep -E '^SANDBOX_INTERNET=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' | tr '[:upper:]' '[:lower:]')
COMPOSE_FILES := -f docker-compose.yml
ifeq ($(SANDBOX_INTERNET),true)
COMPOSE_FILES += -f docker-compose.internet.yml
endif
COMPOSE := docker compose $(COMPOSE_FILES)

.PHONY: up down logs migrate test test-e2e ps restart build check-env

check-env:
	@test -f .env || (echo "Missing .env: cp .env.example .env and fill it in" && exit 1)

up: check-env
	@echo "Sandbox internet access: $(if $(filter true,$(SANDBOX_INTERNET)),ON,off)"
	$(COMPOSE) up -d --build --remove-orphans

down:
	$(COMPOSE) down

restart: check-env
	$(COMPOSE) restart agent

logs:
	$(COMPOSE) logs -f --tail=200

ps:
	$(COMPOSE) ps

build: check-env
	$(COMPOSE) build

# Migrations also run automatically when the agent starts.
migrate: check-env
	$(COMPOSE) run --rm agent node dist/db/migrate-cli.js

test:
	pnpm test

# End-to-end acceptance suite: real sandbox server, Postgres, pg-boss, Pi agent loop,
# a fake Telegram Bot API and Pi's scripted model. Starts a throwaway Postgres on :55432.
test-e2e:
	@docker inspect firefly-testdb >/dev/null 2>&1 || docker run -d --name firefly-testdb -e POSTGRES_PASSWORD=test -e POSTGRES_DB=firefly -p 127.0.0.1:55432:5432 postgres:17-alpine >/dev/null
	@docker start firefly-testdb >/dev/null
	@until docker exec firefly-testdb pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
	pnpm test:e2e
