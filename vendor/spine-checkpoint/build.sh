#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo 'Usage: sh build.sh SPINE_CODEX_CHECKOUT SPINE_PLUGIN_CHECKOUT OUTPUT_DIRECTORY' >&2
  exit 2
fi

core_revision=69059e0c54c410ca04d0d913963576bec22e3bd3
binding_revision=43bfc841f358dd1e5823ff3c9a1273c6532fb118
assets=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
core_checkout=$(CDPATH= cd -- "$1" && pwd)
binding_checkout=$(CDPATH= cd -- "$2" && pwd)
mkdir -p -- "$3"
output=$(CDPATH= cd -- "$3" && pwd)
bindgen=${WASM_BINDGEN:-wasm-bindgen}

if [ "$("$bindgen" --version)" != 'wasm-bindgen 0.2.129' ]; then
  echo 'Expected wasm-bindgen 0.2.129' >&2
  exit 1
fi
if [ "$(rustc --version)" != 'rustc 1.99.1 (58cf8f9c3 2026-10-13)' ]; then
  echo 'Expected rustc 1.99.1 (58cf8f9c3 2026-10-13)' >&2
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/spine-checkpoint-wasm.XXXXXXXX")
work=$(CDPATH= cd -- "$work" && pwd)
case "$work" in /*/spine-checkpoint-wasm.????????) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
mkdir -p -- "$work/crates"
git -C "$core_checkout" archive "$core_revision" codex-rs/spine-core > "$work/core.tar"
tar -xf "$work/core.tar" -C "$work"
mv -- "$work/codex-rs/spine-core" "$work/crates/spine-core"
git -C "$binding_checkout" archive "$binding_revision" crates/spine-wasm > "$work/binding.tar"
tar -xf "$work/binding.tar" -C "$work"
cp -- "$assets/Cargo.toml" "$assets/Cargo.lock" "$work/"
(
  cd -- "$work"
  git apply --check "$assets/upstream.patch"
  git apply "$assets/upstream.patch"
  CARGO_TARGET_DIR="$work/target" cargo build --locked -p spine-wasm --release --target wasm32-unknown-unknown
)
"$bindgen" "$work/target/wasm32-unknown-unknown/release/spine_wasm.wasm" \
  --target nodejs --out-dir "$work" --out-name spine_wasm
cp -- "$work/spine_wasm.js" "$output/spine_wasm.cjs"
cp -- "$work/spine_wasm_bg.wasm" "$output/spine_wasm_bg.wasm"
(cd -- "$output" && sha256sum spine_wasm.cjs spine_wasm_bg.wasm)
