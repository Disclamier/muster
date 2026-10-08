.PHONY: refresh build serve test
refresh:      ## scrape MFM + GrimSlate, sanity-check, rebuild app/data (keeps old data on failure)
	./scripts/refresh.sh
build:        ## rebuild app/data from existing data/*.json
	python3 scraper/build_data.py
serve:
	cd app && python3 -m http.server 8765
test:
	cd tests && npm test
