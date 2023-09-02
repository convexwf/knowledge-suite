.PHONY: import-calibre import-calibre-dry import-html import-html-dry import-urls import-urls-dry

IMPORTER_WORKSPACE := @uknowledge/knowledge-local-importer

import-calibre:
	npm run build -w $(IMPORTER_WORKSPACE)
	npm run import:calibre -w $(IMPORTER_WORKSPACE) -- --root "$(ROOT)" $(ARGS)

import-calibre-dry:
	npm run build -w $(IMPORTER_WORKSPACE)
	npm run import:calibre -w $(IMPORTER_WORKSPACE) -- --root "$(ROOT)" --dry-run $(ARGS)

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
