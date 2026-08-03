import Foundation

/// A signal handler is a C function pointer and cannot capture context, so the
/// flag it sets has to be a global. `sig_atomic_t` is the only type the C standard
/// promises is safe to touch from inside a handler.
///
/// Only `--test-mode` installs this. A real session deliberately ignores SIGINT.
public enum InterruptFlag {
    public static var raised: sig_atomic_t = 0

    public static var isRaised: Bool { raised != 0 }

    public static func installSIGINTHandler() {
        signal(SIGINT) { _ in
            InterruptFlag.raised = 1
        }
    }
}
