//! See the library docs: started by the addon, reads its children from stdin,
//! and stops whichever are still running once the addon's end closes.

fn main() {
    #[cfg(unix)]
    {
        weftcut_reaper::detach();
        weftcut_reaper::serve(std::io::stdin().lock());
    }
}
