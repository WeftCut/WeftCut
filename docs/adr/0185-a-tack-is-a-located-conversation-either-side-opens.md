---
status: accepted
---

# A tack is a located conversation either side opens, read when the user asks

Date: 2026-11-28

## Context

Tacks ran one way (ADR 0115). An agent opened them; the user's only answer was
a status, and a `question` tack could not receive its answer. The user could
not point an agent at a place either ("the pacing drags here"), which is the
other half of editing together.

An agent works in turns, and only the host starts one: the user typing, a tool
call returning, or a push the host offers. MCP gives a server no way into the
model's context. The ways around it are each bound to a host or cost the user:

- A tool that blocks until the user writes holds the agent's session busy, and
  in Codex returns every 60 s (its default tool timeout) unless reconfigured,
  which turns the wait into polling with a full context per return.
- A background listener started by the agent wakes an idle Claude Code session
  (`asyncRewake` hooks), but Codex has no such path: its background terminals
  are polled by the model, and its async hooks never start a turn.
- Messages attached to the results of unrelated tool calls reach the model,
  but whether a model acts on them, rather than finishing its task, is
  unknown, and weaker models are expected to miss them.

## Decision

- **Either side opens a tack.** The user's has `author: "user"` and no work
  session, client or kind: it asks for a change. Its label is the first line
  of what they wrote.
- **Every tack holds a conversation**: `replies`, appended by `reply_tack` or
  the panel, never edited, at most 100. Whose move it is, `awaiting`, is
  derived: the side that did not write the last message, null once closed.
  The user's reply reopens a closed tack; an agent's does not.
- **The user's tack is the user's.** An agent cannot update or delete it
  (`UserTack`); it replies. A closed tack leaves the timeline, so an agent
  closing a request would hide its own answer.
- **Delivery is pull only.** An agent reads the tacks when the user asks it to
  check them. The read answers first, then stamps the user's messages in it
  `seen_at`, so the reader tells new from old and the panel can say the agent
  has read them. Seen means an MCP client read it, not that it was handled;
  that is `awaiting`. Nothing rides on other results and no tool waits.
- **Outdated is one fact for both** (ADR 0117). On the user's tack the panel
  words it as a change to check, because the agent's edit is what usually
  outdates it; the record taken at creation stays.

## Consequences

- A user's request is as runtime-only as any tack: closing the project drops
  it, without a prompt.
- One agent's read marks the messages seen for every agent.
- The user must ask; how the agent learns without being asked is decided from
  how this form is used, not before.
- The Tacks tab's badge counts what waits on the user, not every open tack.

Rejected: a chat window (it promises a reply as fast as typing, which pull
delivery cannot keep); the blocking wait and the background listener, for the
costs above; attaching messages to every result before use shows models act on
them; re-taking a user tack's record on each reply (ADR 0117 makes a tack
current again only by restoring its content); option buttons on a question
(the agent reads the answer as text).
