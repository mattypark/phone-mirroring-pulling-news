#!/usr/bin/env bash
# Compile the one native piece. Rerun after editing bin/mirrorctl.swift.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

swiftc -O "$root/bin/mirrorctl.swift" -o "$root/bin/mirrorctl"
echo "built $root/bin/mirrorctl"
