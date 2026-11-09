# Motif capture hosts and the memory target

Measurements of 2026-11-09, design of 2026-11-10. Question: where does a
capture host's memory belong in the app's resource accounting, and what keeps
a Motif's current preview frame from being refused for memory?

## Measured

Simulated editing on an M1 8 GB and the Windows bench (RTX 3050, 32 GB),
synthetic Motifs at 1080p, about one run per scenario and machine.

- A capture host is one renderer process: 127–138 MiB on the M1, 117–126 MiB
  on the bench. Its GPU work lands in the shared GPU process (M1 170–190 MiB,
  bench 280–340 MiB in all), which grows with frames per second, not hosts.
- Hosts were in no ledger: the admission ledger's `reserved_mib` held only
  frames. Their memory was in the process tree the memory target watches.
- The memory target is 35% of RAM (M1 2816 MiB, bench 11264 MiB). The M1's
  process tree peaked at 2.55 GB with 2 hosts and 2.65 GB (94%) with 4; the
  pressure signal never fired. The bench peaked at 1.7 GB.
- During an export on the M1 the admission ledger (`work_mib`, 40% of the
  target) was full: export 895, a proxy 128, the editor 96 = 1119 of 1126
  MiB. 31 small live-write claims were refused in the first 20 s.

## Decisions

- **Hosts are charged to the memory target, not the admission ledger.** The
  ledger is for work that comes and goes; an export alone fills it, so a host
  charged there would be refused through every export. A host is resident
  process memory, which the target already measures. A new host opens only
  while the process tree's last sample plus one host fits under the target,
  and not under pressure; one host can always open. A host is taken at the
  median measured working set of the open hosts, else `hostMemoryMib`.
- **Under pressure the idle hosts give way,** least recently used first, down
  to one (`HostPool.shed`), on every memory sample (1 s) while pressure lasts:
  a paused editor settles no captures that would otherwise prompt it.
- **A preview's current frame takes the floor.** Pressure closes admission to
  every fresh claim, so a host alone would not keep the picture coming. One
  claim at a time may take the governor's floor (`reserve_floor`): it is
  never refused for budget or pressure, only when the machine itself is
  critical (under 256 MiB available). Exports and bakes claim as before.
