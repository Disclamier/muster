.PHONY: refresh build serve test audit rules-check rules-apply
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
rules-check:  ## weekly: re-fetch GW app detachment pages (40k.app, headless Chrome), diff vs committed rules override; exit 1 on changes; never commits/pushes
	python3 scraper/rules_check.py
rules-apply:  ## same, and write the override + rebuild app/data (then review, test, commit yourself)
	python3 scraper/rules_check.py --apply
