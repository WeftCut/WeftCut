//! The reaper binary against real processes: what it stops once its input
//! closes, and what it leaves alone.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use weftcut_reaper::{adopt_line, release_line, start_time, STOP_GRACE};

fn reaper() -> (Child, ChildStdin) {
    let mut reaper = Command::new(env!("CARGO_BIN_EXE_weftcut-reaper"))
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn the reaper");
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
    // The app's group gets the same SIGTERM the app does; the reaper stays.
    unsafe {
        libc::kill(reaper.id() as libc::pid_t, libc::SIGTERM);
    }
    assert!(wait_by(&mut reaper, Duration::from_millis(200)).is_none());

    let closed = Instant::now();
    drop(input);
    let polite = wait_by(&mut polite, Duration::from_secs(1)).expect("SIGTERM ends it");
    assert_eq!(polite.signal(), Some(libc::SIGTERM));
    let stubborn = wait_by(&mut stubborn, STOP_GRACE + Duration::from_secs(2))
        .expect("SIGKILL ends what SIGTERM did not");
    assert_eq!(stubborn.signal(), Some(libc::SIGKILL));
    assert!(closed.elapsed() >= STOP_GRACE - Duration::from_millis(100));
    assert!(wait_by(&mut reaper, Duration::from_secs(1)).is_some_and(|s| s.success()));
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

    assert!(wait_by(&mut reaper, Duration::from_secs(1)).is_some_and(|s| s.success()));
    assert!(released.try_wait().unwrap().is_none());
    assert!(reused.try_wait().unwrap().is_none());
    for child in [&mut released, &mut reused] {
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
