# How editors plan a video, and what the agent's plan stage lacks — 2026-10-24

After the H5 review the user asked two things:
- whether an agent can design a Motif or a storyboard well when no example
  shows it how;
- whether the harness should follow the basic order of making a video: the
  topic, an outline, a script, a storyboard, then the edit.

This note collects what editing and instructional-design practice says
about that order. It compares the agent's plan stage against it and
proposes a plan stage built on it. Sources are listed at the end; most are
teaching guides and trade pages, not primary research. The Mayer 2020
summary is by Mayer himself.

## What practice says

**Problems are cheapest to fix before production.** Animation studios
build in this order:
1. research;
2. script;
3. storyboard;
4. animatic: the storyboard timed to the final voice;
5. production.

They use the animatic because timing and sequence problems that a still
storyboard hides become obvious in it, and are far cheaper to fix there
[animatic].

**A talk is edited from its transcript first.** A documentary editor
working from interviews:
1. logs and transcribes;
2. writes a *paper edit* of the strongest passages, ordered into a
   beginning, middle and end;
3. then cuts an assembly, a rough cut and a fine cut, and locks the
   picture.

A rough cut need not look finished, but it must already carry the key
message [paper-edit].

**The script pairs what is heard with what is seen.** In a two-column (AV)
script, one column holds the words and the other what is on screen at that
moment. Writing it shows the gaps in the story before the edit [av-script].

**Pictures and words complement each other.** Broadcast writing calls this
"write to the pictures":
- **Against see-say:** words that describe what the viewer already sees add
  nothing.
- **Pictures carry claims:** a picture implies something, so every claim
  needs a picture that supports it, not just one on the same topic
  [news-writing].

**How people learn from narrated pictures** (Mayer's principles)
[mayer-2020, multimedia]:
- **Coherence:** leave out what does not serve the point, decoration
  included.
- **Signalling:** show the viewer where to look.
- **Redundancy:** narration with pictures beats narration, pictures *and*
  the same words on screen.
- **Spatial contiguity:** a label sits on the thing it names.
- **Temporal contiguity:** the picture arrives with its words, neither
  early nor lingering.
- **Segmenting:** an explanation goes one step at a time.

**What makes a cut good** (Murch's rule of six) [murch]. A cut is judged in
order: emotion, story, rhythm, eye trace, the 2D plane of the screen, 3D
space. When a cut cannot satisfy all six, give up criteria from the bottom.
Eye trace means knowing where the viewer is looking before and after the
cut.

## Where the agent's plan stage stands

| Step in practice | The agent's plan stage now (recipe `plan`) | What H5 showed |
|---|---|---|
| Topic, audience, message | Only the user's prompt. The plan states no message. | The plans list overlays but never say what the viewer should take away. Nothing ranks the ideas, so every passage gets a similar treatment. |
| Outline / paper edit | Passages, each given a mode. | No structure (hook, the ideas in order, payoff) and no emphasis: which two or three ideas get the animation budget. |
| AV script | A beat list of overlays. | The time between beats is undecided. The beat list is a list of additions, not what the viewer sees at every moment. |
| Storyboard | Steps for each animation (words and motion). Nothing for scenes or overlays. | No layout, eye trace or exits. Circles stayed past the cut under them (`callout-outlives-picture`). Labels were put over animations that already drew the thing. |
| Animatic | None before the build; the `look` stage checks frames after. | Mistakes surface only after the build. |
| Review gate | One go-ahead on the text. | The user approves a list without seeing a frame. Flash never stopped for the go-ahead at all. |

**Examples narrow the gap between models.** `clipping-network` is one
complete answer to "animate the neuron passage". Every model placed it with
its default seed, so the passage looks the same in all ten cuts, and its
quality is the example's, not the model's.
- Where a model had to design something itself (the city walk), the quality
  spread at once: Opus and Sonnet's own walk-to-map animations against
  Flash's thin map.
- Where it would not design, it reused the example for a process the
  example does not show.

The plan stage is where design ability shows. It should therefore make the
design explicit enough to judge, before any build hides it.

## Proposal: a plan stage in five steps

Each step leaves something the user (or the bench) can read. The user
approves twice: once on the cheap outline, once on the storyboards.

1. **Brief.** In a few lines:
   - who the video is for;
   - the one thing a viewer should understand after it;
   - the talk's argument as 3–5 claims, in order;
   - what is left out.
2. **Outline (paper edit).**
   - The talk as sections, each with its claim, its time span and its job:
     the hook, an idea, an example, the payoff.
   - **The visual budget:** the two or three ideas that get an animation,
     the ones that get a picture, and the stretches where the speaker alone
     is the right picture.
   - Gate 1: the user approves the brief and the outline.
3. **AV script.** A row for every stretch of the cut, with no gaps:
   - her words (verbatim, with times; the pauses to cut marked);
   - what the viewer sees: the speaker's framing, an overlay, a scene;
   - for each picture, what it shows that the words do not.
   - Rules: no see-say, no picture that only shares a topic with the words,
     and the picture arrives with its word.
4. **Storyboards** for every scene, animation and callout group:
   - the frame's layout (what is big, what sits where in relation to her
     face and slide), and where the eye goes;
   - each element's source;
   - when each element enters and leaves, tied to a word or to a change in
     the picture under it;
   - for an animation, its steps on her words, and how it differs from the
     other animations in the video. A different process gets a different
     picture. The same idea, coming back, gets the same picture
     (a callback).
   - Each key frame written in a fixed form:
     - the elements, each placed in a cell of a 3×3 grid and sized as a
       share of the frame's height;
     - the one place to look;
     - what enters and leaves, and on which word;
     - what the frame shows that the words do not.

     A drawn sketch (an SVG board) was considered and dropped: it measures
     how well a model draws SVG, not how well it designs. Since the fields
     are fixed, the harness could render a wireframe from them itself.
5. **Self-review, then gate 2.** Before presenting, check each board, in
   Murch's order adapted to explainers:
   1. Does it show the idea, not just the topic?
   2. Is it timed to the words?
   3. Is there one place to look, clear of her face?
   4. Does the layout hold the frame?
   5. Does it fit the video's visual system?

   Cut what fails coherence or redundancy. Then present the storyboards for
   approval.

The build then runs as editors cut:
- **Assembly:** tighten.
- **Rough cut:** place everything, and compare frames at each beat with its
  board (the animatic).
- **Fine cut:** timing and exits.
- **Audit and handoff.**

## How to test it

- **The plan bench.** `.scratch/agent-harness/planbench` runs an agent's
  plan stage with no app:
  - A replay MCP server answers the read-only tools from a recorded intake
    (the H5 Opus runs'), takes frames from the fixture with ffmpeg, and
    searches Commons live.
  - It refuses every write.
  - A plan costs Opus about $1 and Sonnet $0.35, so models and skill
    versions can be compared on the same intake.
- **Judging.** Score each step on its own:
  - brief and outline: is the message right, and is the emphasis on the
    right ideas?
  - script: no gaps, no see-say;
  - storyboards: does each show the idea? Are the steps on the words? Do
    the exits follow the picture?
- **Without examples.** Hide `clipping-network` and the recipe's pointer to
  it, and compare the boards.

## Sources

- [animatic] Dreamfarm Studios, "Animatic in a nutshell; the storyboard made
  animated", https://dreamfarmstudios.com/blog/animatic-in-a-nutshell-the-storyboard-made-animated/
  ; Morphic, "Animatic", https://morphic.com/ai-glossary/animatic
- [paper-edit] Doha Film Institute, "DIY Documentary Part 4 — Post-production",
  https://dohafilminstitute.com/blog/diy-documentary-part-4-post-production ;
  Videomaker, "Video editing workflow: how to do it properly",
  https://www.videomaker.com/how-to/editing/workflow/video-editing-workflow-how-to-do-it-properly/ ;
  Simon Says, "Create assembly edits from transcripts",
  https://www.simonsaysai.com/how-to/create-assembly-edits-from-transcripts
- [av-script] Boords, "Video script template", https://boords.com/video-script-template ;
  StudioBinder, "AV script template", https://www.studiobinder.com/blog/video-script-template/
- [news-writing] b-roll.net, "More tips for writing TV news",
  https://b-roll.net/today/2015/02/more-tips-for-writing-tv-news/ ;
  IJNet, "How to write broadcast news stories",
  https://ijnet.org/en/resource/how-write-broadcast-news-stories
- [mayer-2020] R. E. Mayer, "Multimedia Principles" (2020),
  https://ugc.futurelearn.com/uploads/files/7d/d6/7dd6188d-c343-4311-b064-ac98d2c95abc/Multimedia_Principles._R._E._Mayer__2020.pdf
- [multimedia] University of Toronto, "Media design principles",
  https://ocw.utoronto.ca/video-strategies/media-design ; Dartmouth,
  "Mayer's 12 principles of multimedia learning",
  https://services.dartmouth.edu/TDClient/1806/Portal/KB/PrintArticle?ID=171655
- [murch] W. Murch, *In the Blink of an Eye* (2nd ed., 2001), summarised in
  No Film School, "6 'rules' for good cutting according to Walter Murch",
  https://nofilmschool.com/2016/11/6-rules-good-cutting-according-oscar-winning-editor-walter-murch
