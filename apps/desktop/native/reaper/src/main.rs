//! See the library docs: started by the addon, reads its children from stdin,
//! and stops whichever are still running once the addon's end closes.

fn main() {
    #[cfg(unix)]
    {
        use std::io::Write;
        weftcut_reaper::detach();
        // From here a signal sent to the reaper itself leaves it running. The
        // addon's stdout is null; a test waits for this line before signalling
        // it. A failed write changes nothing.
        let _ = writeln!(std::io::stdout(), "ready");
        weftcut_reaper::serve(std::io::stdin().lock());
    }
}
