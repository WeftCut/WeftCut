# Bench fixture attribution

The agent bench uses the footage and pictures below. None of it is in this repository:
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

## explainer-exoplanets

- **Work:** "How can we explore planets beyond our solar system" ([Commons file page](https://commons.wikimedia.org/wiki/File:How_can_we_explore_planets_beyond_our_solar_system.webm))
- **Author:** Universiteit van Nederland (University of the Netherlands).
  Speaker: Dr. Yamila Miguel, Leiden University.
- **License:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), as stated on
  the Commons file page.
- **Changes:** cut to the window from 96.567 s to 338.967 s of the original
  (a stream copy), then transcoded from VP9/Opus WebM to H.264/AAC MP4 for the
  WeftCut agent bench. The derivative is shared under CC BY-SA 4.0.
- **Credit line:** "How can we explore planets beyond our solar system" by
  Universiteit van Nederland (speaker: Dr. Yamila Miguel, Leiden University),
  CC BY-SA 4.0, via Wikimedia Commons; trimmed and transcoded.

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

## Pictures (the user-media pack)

Stills the `explainer-clipping-pictures` task imports as the user's own
pictures. Each is imported as downloaded (no changes), after its sha256
matches. A bench run may crop or scale one inside a Motif; that output stays
local. Licences were checked on each Commons file page on 2026-10-23. The
pack deliberately lacks a portrait of Henry Molaison, the patient the talk
names: no freely licensed one exists.

### picture-semon

- **Work:** "Portrait of Richard Semon" ([Commons file page](https://commons.wikimedia.org/wiki/File:Richard_Semon.jpg))
- **Author:** Unknown photographer; frontispiece to R. Semon, Bewusstseinsvorgang und Gehirnprozess (1920)
- **License:** Public domain
- **Credit line:** "Portrait of Richard Semon", Unknown photographer; frontispiece to R. Semon, Bewusstseinsvorgang und Gehirnprozess (1920); public domain, via Wikimedia Commons

### picture-cajal-neurons

- **Work:** "Drawings of cortical neurons" ([Commons file page](https://commons.wikimedia.org/wiki/File:Cajal_cortex_drawings.png))
- **Author:** Santiago Ramón y Cajal (artwork, 1899); file by User:Looie496
- **License:** Public domain
- **Credit line:** "Drawings of cortical neurons", Santiago Ramón y Cajal (artwork, 1899); file by User:Looie496; public domain, via Wikimedia Commons

### picture-brain

- **Work:** "Human brain, lateral view" ([Commons file page](https://commons.wikimedia.org/wiki/File:Human_brain_lateral_view.JPG))
- **Author:** John A Beal, PhD, Dept. of Cellular Biology & Anatomy, Louisiana State University Health Sciences Center Shreveport
- **License:** [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/)
- **Credit line:** "Human brain, lateral view" by John A Beal, PhD, Dept. of Cellular Biology & Anatomy, Louisiana State University Health Sciences Center Shreveport, CC BY 2.5, via Wikimedia Commons

### picture-hippocampus-seahorse

- **Work:** "Hippocampus and seahorse" ([Commons file page](https://commons.wikimedia.org/wiki/File:Hippocampus_and_seahorse_cropped.JPG))
- **Author:** Professor Laszlo Seress (Hippocampus_and_seahorse.JPG); derivative by Anthonyhcole
- **License:** [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- **Credit line:** "Hippocampus and seahorse" by Professor Laszlo Seress (Hippocampus_and_seahorse.JPG); derivative by Anthonyhcole, CC BY-SA 3.0, via Wikimedia Commons

### picture-gray-hippocampus

- **Work:** "Gray's Anatomy plate 739, hippocampus emphasised" ([Commons file page](https://commons.wikimedia.org/wiki/File:Gray739-emphasizing-hippocampus.png))
- **Author:** Henry Vandyke Carter (Gray's Anatomy, 1918 edition)
- **License:** Public domain
- **Credit line:** "Gray's Anatomy plate 739, hippocampus emphasised", Henry Vandyke Carter (Gray's Anatomy, 1918 edition); public domain, via Wikimedia Commons

### picture-eiffel-1900

- **Work:** "Eiffel Tower, looking toward the Trocadero, Exposition Universelle 1900" ([Commons file page](https://commons.wikimedia.org/wiki/File:Eiffel_Tower,_full-view_looking_toward_the_Trocadero,_Exposition_Universal,_1900,_Paris,_France.jpg))
- **Author:** Unknown photographer (Library of Congress Prints and Photographs, ppmsc.05221)
- **License:** Public domain
- **Credit line:** "Eiffel Tower, looking toward the Trocadero, Exposition Universelle 1900", Unknown photographer (Library of Congress Prints and Photographs, ppmsc.05221); public domain, via Wikimedia Commons

### picture-paris-map

- **Work:** "Garnier pocket map of Paris, 1900" ([Commons file page](https://commons.wikimedia.org/wiki/File:1900_Garnier_Pocket_Map_or_Plan_of_Paris,_France_(_Eiffel_Tower_)_-_Geographicus_-_Paris-garnier-1900.jpg))
- **Author:** Garnier (publisher); provided by Geographicus Rare Antique Maps
- **License:** Public domain
- **Credit line:** "Garnier pocket map of Paris, 1900", Garnier (publisher); provided by Geographicus Rare Antique Maps; public domain, via Wikimedia Commons
