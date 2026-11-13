# Queue

The queue page lists the local fixture feed and accepts a pasted URL. Conversion of a pasted URL is proved on the hermetic QA stack, not by submitting the scratch stack.

## Sub-features

- `queue-form` shows the paste field, `Convert URL`, the custom-text form, and `Convert Text`.
- `queue-feed` lists `Inside Micron's Attempts` from the local fixture feed with a `Convert` button.
- `queue-submissions` lists the seeded articles as `succeeded` by `demo.reader`.
- `queue-convert` submits the Harbor Lights fixture through `/queue` and opens the finished article. This sub-feature uses `npm run qa` only.

## How to get to it (user POV)

- Choose `Queue` in the primary nav. The path is `/queue`. `/backlog` renders the same page.
- Paste a URL into `Paste article URL` and choose `Convert URL`. Use this only in `npm run qa`.
- On the scratch stack, read the feed row and the recent activity list. Do not choose `Convert`.

## Driving it with verify-pirate-radio

Preconditions:

- For the scratch page, doctor prints `doctor ok` and the issuer feed is the only configured feed.
- For conversion, Postgres has `pirate_radio_qa` from `bash scripts/dev/start.sh`. Stop if a QA run is already using that database.

- **Open the queue.** Run `npm run verify:drive -- queue`. The script signs in, chooses `Queue`, and waits for `#article-url`.
- **See the form.** `#queue-url` reads `Convert URL`. `#custom-title` and `#queue-text` are visible. The script does not fill or submit either form.
- **See the fixture row.** A `queue-row` heading reads `Inside Micron's Attempts` and that row has a `Convert` button. `Monday: Three Morning Takes` is absent because the voice filter drops it.
- **See seeded history.** `#submissions` contains `The Quiet Return of the Generalist Engineer`, `succeeded`, and `demo.reader`.
- **Read the JSON the page fetched.** The same command requests `GET /queue.json` and `GET /submissions.json` with the session. `queue.json` lists `Inside Micron's Attempts` with `converted` false and omits `Monday: Three Morning Takes`. `submissions.json` lists each seeded title with status `succeeded` and `submittedByUsername` `demo.reader`. The bodies are `<evidenceDir>/queue.json` and `<evidenceDir>/submissions.json`.
- **Proof of the page.** `queue.png` shows the form and the Micron row. `Convert` has not been activated.
- **Convert a fixture URL.** From the repo root, run `npm run qa`. Playwright opens `/auth/login?returnTo=/queue` as `qa.reader`, fills `#article-url` with the fixture origin `/p/<slug>`, chooses `#queue-url`, and waits until `#url-status` starts with `Queued.`. The article URL becomes `/article/<slug>`, `h1` is `Harbor Lights After Midnight`, `#story-body` contains the pier sentence and the ferry sentence, and `#article-player .shk-time_duration` is not `00:00`.
- **QA proof.** The run writes `output/qa/test-results/**/reader-article.png`. The log line starts with `[qa] PASS`.

## Gotchas

- Choosing `Convert`, `Convert URL`, or `Convert Text` on the scratch stack starts real extraction. Launch removed the xAI key, so TTS fails or hangs, and a public URL may still be fetched. Treat a clicked button as a failed run.
- `npm run qa` is the conversion proof because `tests/qa/network-stub.mjs` answers the fixture host and `https://api.x.ai` on loopback. The scratch stack does not load that stub.
- QA uses free ports and `pirate_radio_qa`. It does not read `output/qa/verify/state.json`. Do not point QA `DATABASE_URL` at the scratch `databaseName`.
- The second QA test rejects bearer and `X-API-Key` calls. Do not change that test to make a token pass.
- `PIRATE_RADIO_QA_EVIDENCE=1` adds a trace and a video. The teardown redacts cookies. Do not commit `output/`.
