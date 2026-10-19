# Text-import corpus

Real army-list exports used by `tests/textimport.test.js` to measure parse accuracy.

- `art*-*.txt`: lists published in tabletopbattles.com "competitive innovations" articles
  (GW app EN/FR/DE/ES, New Recruit GW/WTC/WTC-full, ListForge, tournament templates, free-form).
  Deduplicated; one list per file.
- `bs-um.txt`: a BattleScribe text roster (Ultramarines) from a public paste.
- `synth-*.txt`: hand-written fixtures for New Recruit "simple" and free-form text.
- `labels.json`: expected faction + detected format per file (factions checked against each list's own faction line).

Points in these lists come from several MFM versions, so unit points differing from current data is expected;
the tests check the parse (matching, counts, attachments, enhancements, warlord), not today's points.
