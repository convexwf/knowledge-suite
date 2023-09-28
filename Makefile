.PHONY: import-calibre import-calibre-dry import-calibre-docker import-calibre-docker-dry import-html import-html-dry import-urls import-urls-dry ai-up ai-down ai-pull-model

IMPORTER_WORKSPACE := @uknowledge/knowledge-local-importer
DOCKER_IMAGE ?= uknowledge-ingest-server:local
DOCKER_STORE_ROOT ?= $(CURDIR)/tmp/docker-import-store
CALIBRE_ROOT ?= tmp/epub

import-calibre:
	npm run build -w $(IMPORTER_WORKSPACE)
	npm run import:calibre -w $(IMPORTER_WORKSPACE) -- --root "$(ROOT)" $(ARGS)

import-calibre-dry:
	npm run build -w $(IMPORTER_WORKSPACE)
	npm run import:calibre -w $(IMPORTER_WORKSPACE) -- --root "$(ROOT)" --dry-run $(ARGS)

import-calibre-docker:
	docker build -t $(DOCKER_IMAGE) -f apps/knowledge-ingest-server/Dockerfile .
	mkdir -p "$(DOCKER_STORE_ROOT)"
	docker run --rm -v "$(abspath $(or $(ROOT),$(CALIBRE_ROOT)))":/input:ro -v "$(DOCKER_STORE_ROOT)":/data $(DOCKER_IMAGE) npm run import:calibre -w $(IMPORTER_WORKSPACE) -- --root /input --store-root /data --report-dir /data/reports $(ARGS)

import-calibre-docker-dry:
	docker build -t $(DOCKER_IMAGE) -f apps/knowledge-ingest-server/Dockerfile .
	mkdir -p "$(DOCKER_STORE_ROOT)"
	docker run --rm -v "$(abspath $(or $(ROOT),$(CALIBRE_ROOT)))":/input:ro -v "$(DOCKER_STORE_ROOT)":/data $(DOCKER_IMAGE) npm run import:calibre -w $(IMPORTER_WORKSPACE) -- --root /input --store-root /data --report-dir /data/reports --dry-run $(ARGS)

import-html:
	npm run build -w $(IMPORTER_WORKSPACE)
	npm run import:html -w $(IMPORTER_WORKSPACE) -- --root "$(ROOT)" $(ARGS)

import-html-dry:
	npm run build -w $(IMPORTER_WORKSPACE)
	npm run import:html -w $(IMPORTER_WORKSPACE) -- --root "$(ROOT)" --dry-run $(ARGS)

import-urls:
	npm run build -w $(IMPORTER_WORKSPACE)
	npm run import:urls -w $(IMPORTER_WORKSPACE) -- --file "$(FILE)" $(ARGS)

import-urls-dry:
	npm run build -w $(IMPORTER_WORKSPACE)
	npm run import:urls -w $(IMPORTER_WORKSPACE) -- --file "$(FILE)" --dry-run $(ARGS)

# --- AI Summary ---

AI_MODEL ?= qwen2.5:7b

ai-pull-model:
	@if ollama list | grep -q "$(AI_MODEL)"; then \
		echo "Model $(AI_MODEL) already pulled."; \
	else \
		echo "Pulling $(AI_MODEL)..."; \
		ollama pull $(AI_MODEL); \
	fi

ai-up: ai-pull-model
	@echo "Building Docker image..."
	docker compose build
	@echo "Starting services..."
	docker compose up -d
	@echo ""
	@echo "AI summary enabled. Endpoint: http://127.0.0.1:18765"
	@echo "API: POST /api/documents/:docId/ai-annotations"
	@echo ""

ai-down:
	docker compose down
