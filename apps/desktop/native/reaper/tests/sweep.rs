//! The reaper binary against real processes: what it stops once its input
//! closes, and what it leaves alone.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use weftcut_reaper::{adopt_line, command, release_line, start_time, STOP_GRACE};

/// The reaper as the addon starts it, returned once it printed `ready`
/// (interrupts are ignored).
fn reaper() -> (Child, ChildStdin) {
    let mut reaper = command(std::path::Path::new(env!("CARGO_BIN_EXE_weftcut-reaper")))
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn the reaper");
    let mut line = String::new();
    BufReader::new(reaper.stdout.as_mut().expect("piped"))
        .read_line(&mut line)
        .expect("read ready");
    assert_eq!(line.trim(), "ready");
    let input = reaper.stdin.take().expect("piped");
    (reaper, input)
}

/// `sh -c script`, returned once the script printed `ready` (its traps are set).
fn script(script: &str) -> Child {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(script)
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn sh");
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().expect("piped"))
        .read_line(&mut line)
        .expect("read ready");
    assert_eq!(line.trim(), "ready");
    child
}

fn adopt(input: &mut ChildStdin, child: &Child) {
    let pid = child.id();
    let start = start_time(pid).expect("a running child has a start time");
    input.write_all(adopt_line(pid, start).as_bytes()).unwrap();
}

/// How long a test waits for an exit that must come. `wait_by` returns as
/// soon as the process is gone, so only a missing exit costs this long.
const MUST_HAPPEN: Duration = Duration::from_secs(30);

fn wait_by(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_closed_input_stops_children_with_sigterm_then_sigkill() {
    let (mut reaper, mut input) = reaper();
    let polite = script("echo ready; exec sleep 30");
    let stubborn = script("trap '' TERM; echo ready; while :; do sleep 0.05; done");
    let (mut polite, mut stubborn) = (polite, stubborn);
    adopt(&mut input, &polite);
    adopt(&mut input, &stubborn);
    // A signal to the app's group never reaches the reaper: it leads a group
    // of its own from the start. One sent to the reaper itself is ignored.
    let pid = reaper.id() as libc::pid_t;
    // SAFETY: plain syscalls on a child we hold.
    unsafe {
        assert_eq!(libc::getpgid(pid), pid);
        assert_ne!(libc::getpgid(pid), libc::getpgid(0));
        libc::kill(pid, libc::SIGTERM);
    }
    assert!(wait_by(&mut reaper, Duration::from_millis(200)).is_none());

    let closed = Instant::now();
    drop(input);
    // The signal each one died of carries the order; the waits only have to
    // end.
    let polite = wait_by(&mut polite, MUST_HAPPEN).expect("SIGTERM ends it");
    assert_eq!(polite.signal(), Some(libc::SIGTERM));
    let stubborn = wait_by(&mut stubborn, MUST_HAPPEN).expect("SIGKILL ends what SIGTERM did not");
    assert_eq!(stubborn.signal(), Some(libc::SIGKILL));
    assert!(closed.elapsed() >= STOP_GRACE - Duration::from_millis(100));
    assert!(wait_by(&mut reaper, MUST_HAPPEN).is_some_and(|s| s.success()));
}

#[test]
fn released_and_reused_pids_are_left_alone() {
    let (mut reaper, mut input) = reaper();
    let mut released = script("echo ready; exec sleep 30");
    let mut reused = script("echo ready; exec sleep 30");
    adopt(&mut input, &released);
    input
        .write_all(release_line(released.id()).as_bytes())
        .unwrap();
    // A pid whose start time no longer matches is some other process now.
    let start = start_time(reused.id()).unwrap();
    input
        .write_all(adopt_line(reused.id(), start + 1).as_bytes())
        .unwrap();
    drop(input);

    assert!(wait_by(&mut reaper, MUST_HAPPEN).is_some_and(|s| s.success()));
    assert!(released.try_wait().unwrap().is_none());
    assert!(reused.try_wait().unwrap().is_none());
    for child in [&mut released, &mut reused] {
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
