# crew — single-binary Go CLI. Node is a dev-only dependency: it powers the test harness
# (tests/graph/run.mjs renders goldens, tests/e2e/utils/render.mjs rasterizes screen snapshots).
BUILD := .build

.PHONY: build test test-update cov clean

build:
	@mkdir -p $(BUILD)
	go build -o $(BUILD)/crew ./cmd/crew
	go build -o $(BUILD)/crew-graph ./cmd/graph

test: build
	node tests/graph/run.mjs
	sh tests/e2e/run.sh

test-update: build
	node tests/graph/run.mjs -u
	sh tests/e2e/run.sh -u

# black-box coverage: the instrumented binary writes GOCOVERDIR profiles while the suites drive it
cov:
	@mkdir -p $(BUILD); rm -rf .covdata; mkdir -p .covdata
	go build -cover -o $(BUILD)/crew ./cmd/crew
	go build -o $(BUILD)/crew-graph ./cmd/graph
	GOCOVERDIR=$(CURDIR)/.covdata node tests/graph/run.mjs
	GOCOVERDIR=$(CURDIR)/.covdata sh tests/e2e/run.sh
	go tool covdata textfmt -i=.covdata -o=.covdata/cov.txt
	go tool cover -func=.covdata/cov.txt | tail -1

clean:
	rm -rf $(BUILD) .covdata
