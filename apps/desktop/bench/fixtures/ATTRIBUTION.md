# Bench fixture attribution

The agent bench uses the footage below. None of it is in this repository:
`node bench/fixtures/fetch.mjs --all` downloads each file from Wikimedia
Commons into the git-ignored `bench/.cache/fixtures/`, checks it against the
sha256 pinned in `fixtures.json`, trims it where the fixture says so, and
transcodes it to an H.264/AAC MP4 (`transcode` in `fixtures.json`). The bench
imports only that MP4, so every bench file is a **transcoded derivative**
(an adaptation) of the work below, not the original. The licenses allow
reuse and modification with attribution. CC BY-SA also requires adaptations to
be shared under the same license, so the explainer derivative is CC BY-SA 4.0.
Bench runs and their exports stay local. If you publish anything made from
these files, credit it as below, say it was modified, and keep the license.

## explainer-memory

- **Work:** "How does your memory work" ([Commons file page](https://commons.wikimedia.org/wiki/File:How_does_your_memory_work.webm))
- **Author:** Universiteit van Nederland (University of the Netherlands).
  Speaker: Dr. Lisa Genzel, Radboud University.
- **License:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), as stated on
  the Commons file page. The publisher's English YouTube channel says its videos are
  published under CC BY. The stricter of the two is followed here.
- **Changes:** cut to the window from 43.447 s to 258.647 s of the original
  (a stream copy), then transcoded from VP9/Opus WebM to H.264/AAC MP4 for the
  WeftCut agent bench. The derivative is shared under CC BY-SA 4.0.
- **Credit line:** "How does your memory work" by Universiteit van Nederland
  (speaker: Dr. Lisa Genzel, Radboud University), CC BY-SA 4.0, via Wikimedia
  Commons; trimmed and transcoded.

## talking-head-interview

- **Work:** "WikiConference North America - 2025 - Ann Matsuuchi - students have good
  experiences editing Wikipedia" ([Commons file page](https://commons.wikimedia.org/wiki/File:WikiConference_North_America_-_2025_-_Ann_Matsuuchi_-_students_have_good_experiences_editing_Wikipedia.webm))
- **Author:** Lane Rasberry ([User:Bluerasberry](https://commons.wikimedia.org/wiki/User:Bluerasberry)).
  Videography by Rabbit Hole Productions, LLC. Organized by Wikimedia NYC.
  Speaker: Ann Matsuuchi.
- **License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **Changes:** transcoded from AV1/Opus WebM to H.264/AAC MP4 for the WeftCut
  agent bench; otherwise used whole.
- **Credit line:** "WikiConference North America - 2025 - Ann Matsuuchi -
  students have good experiences editing Wikipedia" by Lane Rasberry
  (Bluerasberry), videography by Rabbit Hole Productions, LLC, CC BY 4.0, via
  Wikimedia Commons; transcoded.
