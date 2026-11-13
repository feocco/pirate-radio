# Article

The article page plays one seeded item and shows the story text the seed wrote. Saved progress for the generalist article is already complete.

## Sub-features

- `article-open` opens the generalist article from its library title.
- `article-body` shows the title, byline, and opening sentence.
- `article-player` loads the shared player and a non-zero duration.
- `article-progress` returns the seeded completion for that slug and `404` for the custom-text slug.

## How to get to it (user POV)

- On the library, choose the heading `The Quiet Return of the Generalist Engineer`.
- Choose `Read` on that card. It points at `/article/return-of-the-generalist-engineer`.
- From a signed-in client, request `GET /progress/return-of-the-generalist-engineer`.

## Driving it with verify-pirate-radio

Preconditions:

- Doctor prints `doctor ok`.
- The scratch manifest contains `return-of-the-generalist-engineer` and `notes-on-shipping-audio`.
- You are on the `localhost` origin from the state file.

- **Open the article.** Run `npm run verify:drive -- article`. The script signs in, chooses the generalist heading, and waits for the URL path `/article/return-of-the-generalist-engineer`.
- **Read the story.** The `h1` is `The Quiet Return of the Generalist Engineer`. The page shows `By Mara Whitfield`. `#story-body` contains `For a decade the industry rewarded specialization.`
- **Hear the player.** `#article-player` shows `.shk-btn_toggle`. `.shk-time_duration` becomes something other than `00:00` or `00:00:00`. `GET /audio/return-of-the-generalist-engineer.mp3` returns `200` or `206`.
- **Check progress.** `GET /progress/return-of-the-generalist-engineer` returns `positionSeconds` `100`, `durationSeconds` `100`, and a `completedAt` value. The script writes `progress.json`.
- **Empty progress.** `GET /progress/notes-on-shipping-audio` returns `404` and `progress_not_found`.
- **Proof.** `article.png` shows the title, the opening sentence, and the player.

## Gotchas

- This user is an admin, so `Delete article` is on the page. Do not submit it. Deletion archives the item under `trash/` and removes it from `index.json`.
- The player duration stays `00:00` until metadata loads. Wait for the text to change. A fixed sleep is not the check.
- `notes-on-shipping-audio` has no hero image and no progress row. That absence is the fixture, not a failed seed.
- Audio bytes are the committed file `scripts/dev/seed-assets/audio/return-of-the-generalist-engineer.mp3`. The scratch stack has no xAI key and must not synthesize a replacement.
