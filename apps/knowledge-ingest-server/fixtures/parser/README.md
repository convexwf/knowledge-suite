# Parser Fixture Corpus

This corpus stores offline parser regression cases. Each case is replayed from
captured HTML and snapshot metadata; fixture tests must not fetch the network.

Case layout:

```text
cases/{case_id}/
├── case.json
├── input.html
├── input.snapshot.json
├── expected.document.json
├── expected.markdown.md
└── expected.candidates.json
```

Run checks:

```bash
npm run fixtures:parser -w @uknowledge/knowledge-ingest-server
```

Update expected outputs after an intentional parser change:

```bash
npm run fixtures:parser:update -w @uknowledge/knowledge-ingest-server
```

Only update snapshots after reviewing the Document, Markdown, and candidate
summary diffs for each changed case.
