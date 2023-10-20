.PHONY: help setup setup-ai build build-server check test build-extension clean clean-store distclean \
        dev smoke e2e fixtures fixtures-update \
        docker-build docker-up docker-down docker-logs docker-up-ai docker-down-ai \
        import-calibre import-calibre-dry import-calibre-docker import-calibre-docker-dry \
        import-html import-html-dry import-urls import-urls-dry \
        ai-pull-model ai-up ai-down dev-ai

# ── Variables ──────────────────────────────────────────────────────────────

SERVER_HOST    ?= 127.0.0.1
SERVER_PORT    ?= 18765
SERVER_TOKEN   ?= dev-token
AI_MODEL       ?= qwen2.5:7b
AI_OLLAMA_URL  ?= http://localhost:11434

SERVER_WS      := @uknowledge/knowledge-ingest-server
SCHEMA_WS      := @uknowledge/knowledge-schema
DOCKER_IMAGE   ?= knowledge-ingest-server:local
DOCKER_STORE   ?= $(CURDIR)/tmp/docker-import-store
CALIBRE_ROOT   ?= tmp/epub

# ── Help (default target) ──────────────────────────────────────────────────

help: ## Show all targets
	@echo "Usage: make [target]"
	@echo ""
	@echo "── Setup ──"
	@echo "  setup                  Install deps + build all (one-click bootstrap)"
	@echo "  setup-ai               setup + verify Ollama model for AI summary"
	@echo ""
	@echo "── Build & Check ──"
	@echo "  build                  Build all packages"
	@echo "  build-server           Build server + schema only (no extension)"
	@echo "  check                  Typecheck all packages"
	@echo "  test                   Run all tests"
	@echo "  build-extension        Build Chrome extension only"
	@echo ""
	@echo "── Development ──"
	@echo "  dev                    Start ingest server (foreground)"
	@echo "  dev-ai                 Start ingest server with AI enabled (foreground)"
	@echo ""
	@echo "── Docker ──"
	@echo "  docker-build           Build Docker image"
	@echo "  docker-up              Start server in Docker (no AI)"
	@echo "  docker-up-ai           Start server in Docker with AI (experimental)"
	@echo "  docker-down            Stop Docker services"
	@echo "  docker-logs            Tail Docker logs"
	@echo ""
	@echo "── AI Summary (experimental) ──"
	@echo "  ai-pull-model          Pull AI model via Ollama"
	@echo ""
	@echo "── Import ──"
	@echo "  import-calibre         Import Calibre EPUB library"
	@echo "  import-calibre-dry     Dry-run Calibre import"
	@echo "  import-html            Import HTML files"
	@echo "  import-html-dry        Dry-run HTML import"
	@echo "  import-urls            Import URLs from file"
	@echo "  import-urls-dry        Dry-run URL import"
	@echo ""
	@echo "── Smoke & E2E ──"
	@echo "  smoke                  Run ingest smoke tests"
	@echo "  e2e                    Run Chrome extension E2E tests"
	@echo "  fixtures               Run parser fixture tests"
	@echo "  fixtures-update        Update parser fixture snapshots"
	@echo ""
	@echo "── Cleanup ──"
	@echo "  clean                  Remove dist/ directories"
	@echo "  clean-store            Remove knowledge-store/ (⚠ destructive)"
	@echo "  distclean              clean + clean-store + remove node_modules"
	@echo ""

# ── Setup ──────────────────────────────────────────────────────────────────

setup: ## Install deps and build all packages
	@echo "==> Installing dependencies..."
	npm install
	@echo ""
	@echo "==> Building all packages..."
	npm run build
	@echo ""
	@echo "✓ Setup complete."
	@echo "────────────────────────────────────────────────────────────"
	@echo "Next steps:"
	@echo "  Start server:   make dev"
	@echo "  Load extension: In Chrome, open chrome://extensions"
	@echo "                  → Enable Developer mode"
	@echo "                  → Load unpacked: apps/knowledge-web-clipper/dist"
	@echo ""
	@echo "  Server endpoint: http://$(SERVER_HOST):$(SERVER_PORT)"
	@echo "  Token:           $(SERVER_TOKEN)"
	@echo ""
	@echo "  AI summary (experimental): make setup-ai"
	@echo "────────────────────────────────────────────────────────────"

setup-ai: setup ## setup + verify Ollama model (experimental)
	@echo ""
	@echo "==> Checking Ollama..."
	@if ! command -v ollama >/dev/null 2>&1; then \
		echo "⚠  Ollama not found. Install from https://ollama.com"; \
		echo "   Then run: make ai-pull-model"; \
	else \
		$(MAKE) ai-pull-model; \
		echo ""; \
		echo "✓ AI setup complete."; \
		echo "  Start server with AI:  make dev-ai"; \
		echo "  Or use Docker:          make docker-up-ai"; \
	fi

# ── Build & Check ──────────────────────────────────────────────────────────

build: ## Build all packages
	npm run build

build-server: ## Build server + schema only (skip extension)
	npm run build -w $(SCHEMA_WS)
	npm run build -w $(SERVER_WS)

check: ## Typecheck all packages
	npm run check

test: ## Run all tests
	npm run test

build-extension: ## Build Chrome extension only
	npm run build:extension

# ── Development ────────────────────────────────────────────────────────────

dev: build-server ## Start ingest server (foreground, http://$(SERVER_HOST):$(SERVER_PORT))
	@echo "Starting server at http://$(SERVER_HOST):$(SERVER_PORT)..."
	npm run dev:server

dev-ai: build-server ## Start ingest server with AI enabled (foreground, experimental)
	@echo "Starting server with AI at http://$(SERVER_HOST):$(SERVER_PORT)..."
	KNOWLEDGE_AI_ENABLED=true \
	KNOWLEDGE_AI_PROVIDER=ollama \
	KNOWLEDGE_AI_OLLAMA_BASE_URL=$(AI_OLLAMA_URL) \
	KNOWLEDGE_AI_OLLAMA_MODEL=$(AI_MODEL) \
	npm run dev:server

# ── Docker ─────────────────────────────────────────────────────────────────

docker-build: ## Build Docker image
	docker compose build

docker-up: docker-build ## Start server in Docker (no AI, http://$(SERVER_HOST):$(SERVER_PORT))
	KNOWLEDGE_AI_ENABLED=false \
	KNOWLEDGE_TOKEN=$(SERVER_TOKEN) \
	docker compose up -d
	@echo "Server running at http://$(SERVER_HOST):$(SERVER_PORT)"

docker-up-ai: docker-build ## Start server in Docker with AI (experimental)
	@echo "==> Checking Ollama model..."
	@$(MAKE) ai-pull-model
	KNOWLEDGE_TOKEN=$(SERVER_TOKEN) \
	docker compose up -d
	@echo "AI-enabled server running at http://$(SERVER_HOST):$(SERVER_PORT)"

docker-down: ## Stop Docker services
	docker compose down

docker-logs: ## Tail Docker logs
	docker compose logs -f

# ── AI Summary (experimental) ──────────────────────────────────────────────

ai-pull-model: ## Pull AI model via Ollama (AI_MODEL=$(AI_MODEL))
	@if ! command -v ollama >/dev/null 2>&1; then \
		echo "⚠  Ollama not found. Install from https://ollama.com"; \
		exit 1; \
	fi
	@if ollama list | grep -q "$(AI_MODEL)"; then \
		echo "Model $(AI_MODEL) already pulled."; \
	else \
		echo "Pulling $(AI_MODEL)..."; \
		ollama pull $(AI_MODEL); \
	fi

# ── Import ─────────────────────────────────────────────────────────────────

import-calibre: ## Import Calibre EPUB library (ROOT=<dir>)
	npm run build -w $(IMPORTER_WS)
	npm run import:calibre -w $(IMPORTER_WS) -- --root "$(ROOT)" $(ARGS)

import-calibre-dry: ## Dry-run Calibre import (ROOT=<dir>)
	npm run build -w $(IMPORTER_WS)
	npm run import:calibre -w $(IMPORTER_WS) -- --root "$(ROOT)" --dry-run $(ARGS)

import-calibre-docker: ## Import Calibre via Docker (ROOT=<dir>)
	docker build -t $(DOCKER_IMAGE) -f apps/knowledge-ingest-server/Dockerfile .
	mkdir -p "$(DOCKER_STORE)"
	docker run --rm \
		-v "$(abspath $(or $(ROOT),$(CALIBRE_ROOT)))":/input:ro \
		-v "$(DOCKER_STORE)":/data \
		$(DOCKER_IMAGE) npm run import:calibre -w $(IMPORTER_WS) -- \
			--root /input --store-root /data --report-dir /data/reports $(ARGS)

import-calibre-docker-dry: ## Dry-run Calibre import via Docker (ROOT=<dir>)
	docker build -t $(DOCKER_IMAGE) -f apps/knowledge-ingest-server/Dockerfile .
	mkdir -p "$(DOCKER_STORE)"
	docker run --rm \
		-v "$(abspath $(or $(ROOT),$(CALIBRE_ROOT)))":/input:ro \
		-v "$(DOCKER_STORE)":/data \
		$(DOCKER_IMAGE) npm run import:calibre -w $(IMPORTER_WS) -- \
			--root /input --store-root /data --report-dir /data/reports --dry-run $(ARGS)

import-html: ## Import HTML files (ROOT=<dir>)
	npm run build -w $(IMPORTER_WS)
	npm run import:html -w $(IMPORTER_WS) -- --root "$(ROOT)" $(ARGS)

import-html-dry: ## Dry-run HTML import (ROOT=<dir>)
	npm run build -w $(IMPORTER_WS)
	npm run import:html -w $(IMPORTER_WS) -- --root "$(ROOT)" --dry-run $(ARGS)

import-urls: ## Import URLs from file (FILE=<path>)
	npm run build -w $(IMPORTER_WS)
	npm run import:urls -w $(IMPORTER_WS) -- --file "$(FILE)" $(ARGS)

import-urls-dry: ## Dry-run URL import (FILE=<path>)
	npm run build -w $(IMPORTER_WS)
	npm run import:urls -w $(IMPORTER_WS) -- --file "$(FILE)" --dry-run $(ARGS)

# ── Smoke & E2E ────────────────────────────────────────────────────────────

smoke: ## Run ingest smoke tests
	npm run build
	npm run smoke:ingest

e2e: ## Run Chrome extension E2E tests (requires playwright)
	npm run build
	npm run e2e:extension

fixtures: ## Run parser fixture tests
	npm run fixtures:parser

fixtures-update: ## Update parser fixture snapshots
	npm run fixtures:parser:update

# ── Cleanup ────────────────────────────────────────────────────────────────

clean: ## Remove dist/ directories
	rm -rf apps/*/dist packages/*/dist

clean-store: ## Remove knowledge-store/ (⚠ destroys all local data)
	rm -rf knowledge-store

distclean: clean clean-store ## Full cleanup: dist/ + store + node_modules
	rm -rf node_modules
	@echo "Run 'make setup' to rebuild."
