#!/usr/bin/env python3
import os
import sys
import tempfile


def checkpoint_capability(source_file: str) -> int:
    with open(source_file, "rb") as source:
        checkpoint = source.read()

    if sys.platform.startswith("linux") and hasattr(os, "memfd_create"):
        descriptor = os.memfd_create(
            "tixkit-temporal-checkpoint",
            os.MFD_ALLOW_SEALING,
        )
        os.write(descriptor, checkpoint)
        os.fsync(descriptor)
        os.lseek(descriptor, 0, os.SEEK_SET)

        import fcntl

        fcntl.fcntl(
            descriptor,
            fcntl.F_ADD_SEALS,
            fcntl.F_SEAL_SEAL
            | fcntl.F_SEAL_SHRINK
            | fcntl.F_SEAL_GROW
            | fcntl.F_SEAL_WRITE,
        )
        return descriptor

    temporary_descriptor, temporary_path = tempfile.mkstemp(
        prefix="tixkit-temporal-checkpoint."
    )
    try:
        os.write(temporary_descriptor, checkpoint)
        os.fsync(temporary_descriptor)
        os.chmod(temporary_path, 0o400)
        descriptor = os.open(temporary_path, os.O_RDONLY)
    finally:
        os.close(temporary_descriptor)
        os.unlink(temporary_path)
    return descriptor


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("run-in-process-group.py requires a command")
    readiness_file = os.environ.pop("DR_PROCESS_GROUP_READY_FILE", "")
    if not readiness_file:
        raise SystemExit("DR_PROCESS_GROUP_READY_FILE is required")
    checkpoint_source = os.environ.pop("DR_TEMPORAL_CHECKPOINT_SOURCE_FILE", "")
    if checkpoint_source:
        checkpoint_descriptor = checkpoint_capability(checkpoint_source)
        os.set_inheritable(checkpoint_descriptor, True)
        descriptor_root = "/proc/self/fd" if sys.platform.startswith("linux") else "/dev/fd"
        os.environ["DR_TEMPORAL_CHECKPOINT_FILE"] = (
            f"{descriptor_root}/{checkpoint_descriptor}"
        )
    os.setsid()
    descriptor = os.open(readiness_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, f"{os.getpid()}\n".encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
