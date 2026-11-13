# Parser criteria

Parser criteria check a redacted First Things fixture against the five acceptance gates. The domain has no `parser.json` yet. The Vitest file supplies the spec and calls `evaluateCriteria`.

## Sub-features

- `criteria-fixture` loads `criteria.json` and the one sha256 HTML fixture.
- `criteria-gates` passes `title`, `first_words`, `last_words`, `phrases_ordered`, and `no_script_or_raw_html`.
- `criteria-redaction` keeps the pinned words and rejects script or raw HTML in the extract.

## How to get to it (user POV)

- This check has no reader page. The maintained fixture is the user-visible contract for a future First Things parser.
- From the repo root, run the criteria test named below. Do not fetch `firstthings.com` for this proof.

## Driving it with verify-pirate-radio

Preconditions:

- The repo contains `src/parsers/domains/first-things/criteria.json`.
- The repo contains `src/parsers/domains/first-things/fixtures/2d74b9d666a4fc56265811332fdb1fb4c3ca2e1fde16c0f44c4d8694de7ad10e.html`.
- `src/parsers/domains/first-things/parser.json` is absent. That is the current tree, not a missing download.
- No scratch server is required.

- **Run the criteria.** Run `npm test -- tests/first-things-criteria.test.ts`. npm uses the package root, so the working directory can be the repo root or this skill directory. The process exits `0`.
- **Title and words.** The test requires the title `Voyages to the End of the World`, the opening words `Francis Bacon dreamed of abolishing`, and the closing words `have faith that he will.`
- **Phrases.** The ordered phrases are `might warn off potential invaders.` and `confronting a dragon representing Satan`.
- **Redaction.** The fixture is under 2000 bytes, contains no `<script` and no `javascript:`, and the parsed words stay inside the pinned set plus the filler `redacted`.
- **Proof.** Save the Vitest stdout next to the other proof, or rely on the command's exit code in the session log. A pass is the five gates in order with `ok: true`.

## Gotchas

- `npm test` also runs this file, plus the rest of the suite. Use the file path above when you want only the fixture gates.
- The HTML filename is the sha256 of its bytes, and `criteria.json` must set `examples[0].fixture` to `fixtures/<that hash>.html`. Renaming the file without updating that field fails the test. Updating the field without recomputing `digest` also fails.
- Do not replace the fixture with a live download. The committed file is redacted on purpose.
- A generated parser still has to land through a reviewed pull request. This test does not deploy one, and the running service does not load `src/parsers/domains/` at request time.
