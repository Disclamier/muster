.PHONY: refresh build serve test audit
refresh:      ## scrape MFM + GrimSlate, sanity-check, rebuild app/data (keeps old data on failure)
	./scripts/refresh.sh
build:        ## rebuild app/data from existing data/*.json
	python3 scraper/build_data.py
serve:
	cd app && python3 -m http.server 8765
test:
	cd tests && npm test
audit:        ## independent points audit: live MFM (headless Chrome) vs what the app computes; exit 1 on any mismatch
	python3 audit/mfm_dump.py audit/out/dom
	python3 audit/mfm_parse.py audit/out/dom > audit/out/mfm_audit.json
	node audit/check_points.js audit/out/mfm_audit.json --json audit/out/result.json
