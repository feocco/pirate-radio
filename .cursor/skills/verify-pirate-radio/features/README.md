# Pirate Radio verification map

This directory is the maintained source for verifying Pirate Radio. Read this index, then use the matching feature file.

## Baseline preconditions

- Launch with `bash .cursor/skills/verify-pirate-radio/verify.sh launch`.
- The state file is `output/qa/verify/state.json`. Use its `publicUrl`. The host is `localhost`.
- The database name is the state file's `databaseName`, shaped `pirate_radio_verify_<run>`. The library directory is `/tmp/pirate-radio-verify-<runId>/library`.
- Seed data is the three articles in `scripts/dev/seed-assets/articles.json`. The user is `demo.reader`.
- The queue feed is the local issuer serving `tests/fixtures/pirate-feed.xml`.
- Run `bash .cursor/skills/verify-pirate-radio/verify.sh doctor` and require `doctor ok` before a browser drive.
- Do not drive port `8123`, the `pirate_radio` database, or `output/library` from this map. Those belong to `npm run dev`.

## Driving conventions

- Start every seeded recipe from the baseline state.
- Prefer the role and accessible name in the feature file over a CSS-only guess. The ids below are the ones the pages already expose: `#article-url`, `#queue-url`, `#library`, `#story-body`, `#article-player`, `#account-menu`.
- Treat commands as literal.
- Browser drives go through `node .cursor/skills/verify-pirate-radio/drive.mjs <step>`.
- HTTP checks use `curl` against the state file's `publicUrl`.
- Queue conversion goes through `npm run qa`, which boots a second, hermetic stack.
- Parser criteria go through `npx vitest run tests/first-things-criteria.test.ts`.
- Cleanup may remove the scratch database and `/tmp` directory. It must not remove proof files.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes the PNG named in the feature file. The page title or the Pirate Radio wordmark has to be visible.
- HTTP proof includes the status and the JSON body, with no `Cookie` header written to disk.
- Mutation proof for queue conversion is the succeeded submission plus the article page from `npm run qa`.
- `drive.log` names the step on its `ok` line (`health`, `auth`, `article`, `queue`, or `all`). Vitest prints the criteria file name when that command runs.
- If a precondition is missing, report the command and the missing piece. Do not count a different path as a pass.

## Feature entry contract

Each feature file starts with an H1 and one paragraph. It then uses these H2 headings in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-pirate-radio`, and `Gotchas`.

## Features

- [Health](./health.md) checks the anonymous liveness route and the locked library.
- [Sign in and library](./auth-and-reader.md) checks the dev sign-in, the session, and the three seeded cards.
- [Article](./article.md) opens one seeded article, its player, and its saved progress.
- [Queue](./queue.md) checks the queue page on the scratch stack and conversion through `npm run qa`.
- [Parser criteria](./parser-criteria.md) runs the First Things fixture through `evaluateCriteria`.
