// nefertari-enforce — kernel-enforced reversibility.
//
// Runs a command inside a Landlock sandbox where the filesystem is READ+EXECUTE
// everywhere but WRITABLE only within an explicit allowlist — the exact set of
// paths the Nefertari broker snapshotted before it classified the action as
// reversible. If the command tries to write, create, or delete anywhere outside
// that set, the kernel denies it (EACCES). Reversibility stops being a promise
// the classifier makes and becomes a property the kernel enforces.
//
// Landlock is UNPRIVILEGED (Linux >= 5.13): no root, no CAP_SYS_ADMIN. This
// enforces WRITE confinement (reversibility), not confidentiality — network
// egress stays the broker's job (Landlock ABI 3 has no network rules).

use std::collections::HashSet;
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use landlock::{
    path_beneath_rules, Access, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr,
    RulesetStatus, ABI,
};


/// Landlock is allow-only: a ruleset takes access away and rules grant it back,
/// so there is no "deny this path" to write. A deny-list has to be expressed as
/// the COMPLEMENT - grant read on everything except the paths named.
///
/// Walk down from `/` along the ancestors of each denied path. At every
/// directory on the way, grant its children wholesale except the one the path
/// continues through, and recurse into that one instead. The denied leaf is
/// granted nothing, so it and everything beneath it is unreadable.
///
/// This matters because write confinement alone does not protect a secret: an
/// agent that cannot write ~/.aws can still read it, and everything an agent
/// reads is sent to a third-party API on its next turn. Confining writes
/// protects the machine; confining reads is what protects the world from the
/// context.
fn read_roots_excluding(denied: &[String]) -> Vec<String> {
    if denied.is_empty() {
        return vec!["/".to_string()];
    }

    // Canonicalise so a symlink or a `..` cannot walk around the deny-list. A
    // path that does not exist is dropped rather than guessed at: denying
    // something absent would narrow reads for no reason.
    let denied: HashSet<PathBuf> = denied
        .iter()
        .filter_map(|d| fs::canonicalize(d).ok())
        .collect();
    if denied.is_empty() {
        return vec!["/".to_string()];
    }

    let mut on_path: HashSet<PathBuf> = HashSet::new();
    for d in &denied {
        let mut cur: Option<&Path> = d.parent();
        while let Some(p) = cur {
            on_path.insert(p.to_path_buf());
            cur = p.parent();
        }
    }

    let mut roots: Vec<String> = Vec::new();
    let mut queue: Vec<PathBuf> = vec![PathBuf::from("/")];
    while let Some(dir) = queue.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            // Unreadable already: nothing to grant, and nothing to warn about.
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let child = entry.path();
            if denied.contains(&child) {
                continue; // the point of the exercise
            }
            if on_path.contains(&child) {
                queue.push(child); // an ancestor of something denied: go deeper
            } else if let Some(s) = child.to_str() {
                roots.push(s.to_string()); // everything else, wholesale
            }
        }
    }
    roots
}

fn usage() -> ! {
    eprintln!(
        "usage: nefertari-enforce [--allow-write PATH]... [--allow-read PATH]... [--deny-read PATH]... -- CMD [ARG]...\n\
         \n\
         The command runs with the filesystem read-only except for the --allow-write\n\
         paths (plus /dev/null). Writes outside that set are denied by the kernel.\n\
         \n\
         env NEFERTARI_ENFORCE_OPTIONAL=1  downgrade to a warning if the kernel lacks Landlock"
    );
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut write_paths: Vec<String> = Vec::new();
    let mut read_paths: Vec<String> = Vec::new();
    let mut deny_read: Vec<String> = Vec::new();
    let mut cmd: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--allow-write" => {
                i += 1;
                if i >= args.len() {
                    usage();
                }
                write_paths.push(args[i].clone());
            }
            "--allow-read" => {
                i += 1;
                if i >= args.len() {
                    usage();
                }
                read_paths.push(args[i].clone());
            }
            "--deny-read" => {
                i += 1;
                if i >= args.len() {
                    usage();
                }
                deny_read.push(args[i].clone());
            }
            "--" => {
                i += 1;
                cmd = args[i..].to_vec();
                break;
            }
            "-h" | "--help" => usage(),
            other => {
                eprintln!("unknown argument: {other}");
                usage();
            }
        }
        i += 1;
    }
    if cmd.is_empty() {
        usage();
    }

    // Always allow /dev/null so ordinary tools that redirect there keep working;
    // raw block devices (/dev/sda…) stay denied.
    write_paths.push("/dev/null".to_string());

    let abi = ABI::V3;
    let ro = AccessFs::from_read(abi);
    let rw = AccessFs::from_all(abi);

    // Read+execute everywhere so the program can load its libraries and binaries;
    // reading is not the reversibility threat — unrecoverable writes are.
    let mut read_roots = read_roots_excluding(&deny_read);
    read_roots.extend(read_paths.iter().cloned());

    let optional = std::env::var_os("NEFERTARI_ENFORCE_OPTIONAL").is_some();

    let result = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))
        .and_then(|r| r.create())
        .and_then(|r| r.add_rules(path_beneath_rules(&read_roots, ro)))
        .and_then(|r| r.add_rules(path_beneath_rules(&write_paths, rw)))
        .and_then(|r| r.restrict_self());

    match result {
        Ok(status) => match status.ruleset {
            RulesetStatus::FullyEnforced => {
                if deny_read.is_empty() {
                    eprintln!("[nefertari-enforce] writable: {write_paths:?}");
                } else {
                    eprintln!("[nefertari-enforce] writable: {write_paths:?} | unreadable: {deny_read:?}");
                }
            }
            RulesetStatus::PartiallyEnforced => {
                eprintln!("[nefertari-enforce] WARNING: kernel only partially enforced the ruleset");
            }
            RulesetStatus::NotEnforced => {
                if !optional {
                    eprintln!(
                        "[nefertari-enforce] REFUSED: this kernel has no Landlock and enforcement is required"
                    );
                    std::process::exit(3);
                }
                eprintln!(
                    "[nefertari-enforce] WARNING: no Landlock — running UNENFORCED (NEFERTARI_ENFORCE_OPTIONAL)"
                );
            }
        },
        Err(e) => {
            if !optional {
                eprintln!("[nefertari-enforce] REFUSED: could not apply Landlock ruleset: {e}");
                std::process::exit(3);
            }
            eprintln!("[nefertari-enforce] WARNING: Landlock error ({e}) — running UNENFORCED");
        }
    }

    // execve replaces this process image; the Landlock restriction is inherited.
    let err = Command::new(&cmd[0]).args(&cmd[1..]).exec();
    eprintln!("[nefertari-enforce] exec failed for {:?}: {err}", cmd[0]);
    std::process::exit(127);
}
