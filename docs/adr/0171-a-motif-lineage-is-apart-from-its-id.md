---
status: accepted
---

# A Motif's lineage is a uid apart from its id

Date: 2026-11-17

## Context

A Motif's id was its identity, its key in the store and on layers, its
`motif://` host and, made from its name, what people read. Three problems
followed:

- **Names in another script had no id.** The id is the name's ASCII slug, so
  every name without an ASCII letter or digit became `motif`. The first such
  Motif published; every later one was refused as taken, and the advice to
  rename the draft could not be followed in the same script.
- **Nothing said "this is the same Motif".** A ZIP import, a copy and a working
  copy all made a new id, and two installs with the same name made the same
  id for unrelated Motifs. A project folder that carries its own copies of
  Motifs, so it opens on another machine, needs to tell an update of its copy
  from a stranger that shares a name.
- **Private metadata lived inside packages.** A draft's Update target was a
  `target` file in its package, so the hash, the protocol, listing, ZIP import
  and export, copies and the data-root migration each had to skip it, in eight
  places. No release has written it since drafts kept their state beside the
  package (`.workspaces/<id>.json`).

## Decision

- **A lineage is a uid**, a random RFC 9562 UUID minted by the app, never
  authored: not in the manifest (agents copy manifests) and not in the
  revision, so stored frames and covers keep their keys. The id stays the
  readable local key; the revision stays the content.
- **The store keeps lineages beside its packages**, in `motifs/.lineage.json`,
  keyed `<id>` for an installed Motif and `drafts/<id>` for a draft
  (`main/motif/lineage.ts`). A package without one gets one when first asked
  for; a folder copied into the store by hand is therefore a new lineage. The
  record is not derived data: an unreadable one is set aside, not overwritten.
- **Built-ins have fixed lineages** (`BUILTIN_LINEAGE` in
  `shared/motifs/catalog.ts`, from which `BUILTIN_IDS` is derived), so a
  built-in reads as the same Motif on every install and after every update.
- **Which lineage a package takes** (`main/motif/workspace.ts`):
  - a new, linked-directory or `copy` draft starts one;
  - a draft opened from a Motif (`{kind:'motif'}`) is a working copy and
    takes that Motif's;
  - a ZIP's draft takes the lineage the archive names, if it names one;
  - a publication that replaces a Motif keeps the Motif's, and its draft
    takes it;
  - a first publication takes the draft's, unless an installed or built-in
    Motif already has it: publishing anew from a working copy forks, and the
    draft follows the new lineage. A library never holds one lineage twice.
    The fork is planned, not recorded: a proposal keeps it, so the id it
    shows is the one approval publishes, and only a written publication
    records it. A refused or abandoned proposal leaves the draft's lineage
    alone.
- **An id is made from a name and a lineage**: the name's slug, or `motif-`
  and the first 8 hex digits of the lineage when the name has no ASCII letter
  or digit. A slug Windows reserves for a device (`con`, `nul`, ...) is
  prefixed with `motif-`, since an id is also a folder. An agent's first publication still refuses a taken id, never
  numbering it; the app's own install and draft ids still number.
- **A ZIP names its lineage beside the Motif folder**, in a
  `weftcut-lineage.json` entry at the archive root. The package's own paths
  stay free. In a root-style ZIP (index.html at the root) that name is a
  package file and no lineage is claimed.
- **No package path is private.** The `target` file is gone: the first
  launch of a store at format 0 turns a draft's file into its `source_id`
  (which the Update button already offered) unless it has a source or a
  publication, removes the file from every package, and records format 1 in
  `motifs/.format`. Later launches never touch a `target` file again: it is
  an author's. Only `.revisions` stays reserved, for pinned capture URLs.

## Consequences

- Names in any script publish. Two Motifs named alike in another script get
  different ids; one renamed in the same script keeps its id.
- A lineage is a claim, never a reason to trust: a ZIP can name any lineage.
  Trusting a Motif's code is decided separately.
- A library entry deleted by hand leaves its lineage in the record; a folder
  later put under the same id inherits it. Deleting through the app forgets it.
- A record that cannot be written lasts the process; packages it missed start
  new lineages at the next launch.
- A package with a file named `target` (an author's, or one the upgrade
  could not remove) now hashes and serves it like any other file. So does a
  root `TARGET` or other case variant, which older releases also hid: its
  package's revision changes once.
- No MCP tool or field changes.

Rejected: a lineage file inside each package (reserves a path again, and a
hand copy of a folder duplicates the lineage); the lineage in the manifest
(authored and copied, and it would change every revision); snowflake ids (no
allocator to coordinate, nothing to order); UUIDs as ids (agents type ids and
paths, and a long random string is easy to mangle); numbering ids made from
lineage-less names (`motif-2` says nothing and still collides across
machines).
