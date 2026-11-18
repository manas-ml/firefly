# Usage: make up | down | logs | migrate | test | ps | restart
SHELL := /bin/bash

SANDBOX_INTERNET ?= $(shell grep -E '^SANDBOX_INTERNET=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' | tr '[:upper:]' '[:lower:]')
COMPOSE_FILES := -f docker-compose.yml
ifeq ($(SANDBOX_INTERNET),true)
COMPOSE_FILES += -f docker-compose.internet.yml
endif
# An exported COMPOSE_FILE (docker's own variable) takes precedence.
ifdef COMPOSE_FILE
COMPOSE := docker compose
else
COMPOSE := docker compose $(COMPOSE_FILES)
endif

.PHONY: up down logs migrate test test-e2e ps restart build check-env secrets backup restore update dashboard install menubar-config

check-env: secrets
	@test -f .env || (echo "Missing .env: cp .env.example .env and fill it in" && exit 1)

# The vault master key is generated once and kept out of .env. Back it up
# separately: without it, the secrets in the database can't be decrypted.
secrets:
	@mkdir -p secrets && chmod 700 secrets
	@test -s secrets/vault_master_key || (umask 022 && openssl rand -hex 32 > secrets/vault_master_key && echo "Generated secrets/vault_master_key (back it up somewhere safe)")
	@test -f secrets/mac_bridge_token || (umask 022 && : > secrets/mac_bridge_token)

install:
	./install.sh

# Back up now (the backup service also runs nightly at BACKUP_TIME).
backup: check-env
	$(COMPOSE) run --rm --no-deps --entrypoint /bin/sh backup /scripts/backup.sh

# make restore DIR=backups/2026-11-18_033000
restore: check-env
	@test -n "$(DIR)" || (echo "usage: make restore DIR=<backup folder>" && exit 1)
	scripts/restore.sh "$(DIR)"

update: check-env
	SANDBOX_INTERNET=$(SANDBOX_INTERNET) scripts/update.sh

dashboard:
	@echo "http://127.0.0.1:$$(grep -E '^HEALTH_PORT=' .env | cut -d= -f2 | grep . || echo 8080)/?token=$$(grep -E '^DASHBOARD_TOKEN=' .env | cut -d= -f2)"

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

# Writes the menu bar app's config (dashboard URL + token) on the Mac.
menubar-config:
	@mkdir -p "$$HOME/Library/Application Support/Firefly"
	@printf '{ "url": "http://127.0.0.1:%s", "token": "%s" }\n' "$$(grep -E '^HEALTH_PORT=' .env | cut -d= -f2 | grep . || echo 8080)" "$$(grep -E '^DASHBOARD_TOKEN=' .env | cut -d= -f2)" > "$$HOME/Library/Application Support/Firefly/menubar.json"
	@chmod 600 "$$HOME/Library/Application Support/Firefly/menubar.json"
	@echo "Wrote ~/Library/Application Support/Firefly/menubar.json"
