#!/bin/sh

fail() {
    printf 'ohbaby installer: %s\n' "$*" >&2
    exit 1
}

warn() {
    printf 'ohbaby installer: %s\n' "$*" >&2
}

version_is_safe() {
    case "$1" in ''|*[!0-9A-Za-z.-]*) return 1 ;; esac
    printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
}

pid_is_valid() {
    case "$1" in ''|0*|*[!0-9]*) return 1 ;; esac
    [ "${#1}" -le 10 ] && [ "$1" -le 2147483647 ]
}

# Shell kill reports both ESRCH and EPERM as failure. Only ESRCH is evidence
# the process exited. Leave unrecognized failures for the user to inspect.
process_is_gone() {
    pid_is_valid "$1" || return 1
    if probe=$(LC_ALL=C kill -0 "$1" 2>&1); then return 1; fi
    case "$probe" in *'No such process') return 0 ;; *) return 1 ;; esac
}

daemon_json_node() (
    if available_node=$(command -v node); then
        printf '%s\n' "$available_node"
        exit 0
    fi
    pointer="$install_dir/current"
    [ -f "$pointer" ] || exit 1
    if ! current_release=$(cat "$pointer") || ! version_is_safe "$current_release"; then exit 1; fi
    node_pointer="$install_dir/releases/$current_release/node-version"
    [ -f "$node_pointer" ] || exit 1
    if ! current_node=$(cat "$node_pointer") || ! version_is_safe "$current_node"; then exit 1; fi
    available_node="$install_dir/runtime/node-v$current_node/bin/node"
    [ -x "$available_node" ] || exit 1
    printf '%s\n' "$available_node"
)

# Use a JSON reader only if there is existing daemon metadata. A clean install
# without Node, Perl or Python does not need one.
daemon_record_pid() {
    if command -v perl >/dev/null 2>&1 && perl -MJSON::PP -e 1 2>/dev/null; then
        perl -MJSON::PP -e '
            my ($kind, $path) = @ARGV;
            open my $file, "<", $path or die;
            local $/;
            my $record = decode_json(<$file>);
            die unless ref($record) eq "HASH";
            my $status = $record->{status} // "";
            if ($kind eq "lock") {
                die unless encode_json($record->{startedAt}) =~ /^-?[0-9]/ &&
                    encode_json($record->{token}) =~ /^"/ && $record->{token} =~ /\S/;
            } else {
                die unless $status =~ /\A(?:running|stopping|stopped|crashed)\z/ &&
                    encode_json($record->{updatedAt}) =~ /^-?[0-9]/;
                if ($status eq "running") {
                    die unless encode_json($record->{host}) =~ /^".+"/ &&
                        encode_json($record->{port}) =~ /^[0-9]+$/ &&
                        encode_json($record->{authToken}) =~ /^".+"/;
                }
                # Final state is written before the lock is released, so the lock check covers it.
                exit 0 if $status =~ /\A(?:stopped|crashed)\z/;
            }
            my $pid = encode_json($record->{pid});
            die unless $pid =~ /\A[1-9][0-9]*\z/;
            print $pid;
        ' "$1" "$2"
    elif json_node=$(daemon_json_node); then
        "$json_node" -e '
            const [kind, path] = process.argv.slice(1);
            const record = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
            const text = (value) => typeof value === "string" && value.length > 0;
            if (!record || Array.isArray(record) || typeof record !== "object") process.exit(1);
            const { pid, status, updatedAt, startedAt, token, host, port, authToken } = record;
            if (kind === "lock") {
                if (!Number.isFinite(startedAt) || !text(token) || !token.trim()) process.exit(1);
            } else {
                if (!["running", "stopping", "stopped", "crashed"].includes(status) ||
                    !Number.isFinite(updatedAt)) process.exit(1);
                if (status === "running" &&
                    (!text(host) || !Number.isInteger(port) || !text(authToken))) process.exit(1);
                if (status === "stopped" || status === "crashed") process.exit(0);
            }
            if (!Number.isSafeInteger(pid) || pid <= 0) process.exit(1);
            console.log(pid);
        ' "$1" "$2"
    elif command -v python3 >/dev/null 2>&1; then
        python3 - "$1" "$2" <<'PY'
import json
import math
import sys

kind, path = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    record = json.load(source)

def number(value):
    return type(value) in (int, float) and math.isfinite(value)

def text(value):
    return isinstance(value, str) and bool(value)

status = record.get("status")
if kind == "lock":
    if not number(record.get("startedAt")) or not (
        text(record.get("token")) and record["token"].strip()
    ):
        sys.exit(1)
else:
    if status not in ("running", "stopping", "stopped", "crashed") or not number(record.get("updatedAt")):
        sys.exit(1)
    if status == "running" and not (
        text(record.get("host")) and type(record.get("port")) is int and text(record.get("authToken"))
    ):
        sys.exit(1)
    if status in ("stopped", "crashed"):
        sys.exit(0)
pid = record.get("pid")
if type(pid) is not int or pid <= 0:
    sys.exit(1)
print(pid)
PY
    else
        return 1
    fi
}

check_daemon_file() (
    metadata=$2
    if ! metadata_status=$(LC_ALL=C ls -d "$metadata" 2>&1); then
        case "$metadata_status" in *'No such file or directory') exit 0 ;; esac
        fail "Cannot inspect daemon metadata at $metadata."
    fi
    [ -f "$metadata" ] && [ -r "$metadata" ] ||
        fail "Cannot read daemon metadata at $metadata."
    pid=$(daemon_record_pid "$1" "$metadata" 2>/dev/null) ||
        fail "Cannot parse daemon metadata at $metadata. Check the file and that a private Node, Perl (JSON::PP) or Python 3 is available."
    [ -z "$pid" ] || process_is_gone "$pid" ||
        fail "Daemon process $pid is still running or cannot be verified ($metadata). Check for active work, then run ohbaby serve stop and retry."
)

check_daemon() {
    # Startup acquires the PID lock before publishing state. Read the lock last.
    check_daemon_file state "$ohbaby_home/server/daemon-state.json" &&
        check_daemon_file lock "$ohbaby_home/server/daemon.pid"
}

normalize_directory() {
    case "$1" in /*) ;; *) return 1 ;; esac
    case "$1" in *'
'*) return 1 ;; esac
    printf '%s\n' "$1" | awk -F / '{
        depth = 0
        for (i = 1; i <= NF; i++) {
            if ($i == "" || $i == ".") continue
            if ($i == "..") { if (depth > 0) depth--; continue }
            parts[++depth] = $i
        }
        if (depth == 0) printf "/"
        for (i = 1; i <= depth; i++) printf "/%s", parts[i]
    }'
}

select_platform() {
    os=$(uname -s)
    arch=$(uname -m)
    case "$os" in
        Darwin)
            os=darwin
            if [ "$arch" = x86_64 ] &&
                [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || :)" = 1 ]; then
                arch=arm64
            fi ;;
        Linux)
            os=linux
            libc=$(LC_ALL=C ldd --version 2>&1 || :)
            if ! printf '%s\n' "$libc" | grep -Eqi 'glibc|GNU libc|GNU C Library'; then
                fail "The installer requires glibc on Linux. Install a compatible Node.js 24 and use npm install -g ohbaby-cli."
            fi ;;
        *) fail "Unsupported operating system: $os. Install Node.js 24 and use npm install -g ohbaby-cli." ;;
    esac
    case "$arch" in
        x86_64|amd64) arch=x64 ;;
        arm64|aarch64) arch=arm64 ;;
        *) fail "Unsupported architecture: $arch. Install Node.js 24 and use npm install -g ohbaby-cli." ;;
    esac
}

require_stale_install_lock() {
    [ -f "$install_lock/pid" ] && [ ! -L "$install_lock/pid" ] ||
        fail "Install lock is incomplete or invalid at $install_lock."
    if ! lock_pid=$(cat "$install_lock/pid" 2>/dev/null) || ! process_is_gone "$lock_pid"; then
        fail "Install lock is active or cannot be verified at $install_lock."
    fi
}

take_install_lock() {
    if [ -e "$reclaim_lock" ] || [ -L "$reclaim_lock" ]; then
        fail "Install recovery lock exists at $reclaim_lock. Confirm no install or uninstall is running before removing it."
    fi
    if ! mkdir "$install_lock" 2>/dev/null; then
        [ -d "$install_lock" ] && [ ! -L "$install_lock" ] ||
            fail "Cannot create install lock at $install_lock."
        require_stale_install_lock
        mkdir "$reclaim_lock" 2>/dev/null ||
            fail "Install recovery lock is in use at $reclaim_lock."
        reclaim_owned=1

        # Another process may have replaced the original lock before this gate.
        if [ -d "$install_lock" ] && [ ! -L "$install_lock" ]; then
            require_stale_install_lock
            mv "$install_lock" "$reclaim_lock/stale" ||
                fail "Cannot replace stale install lock at $install_lock."
            rm -rf "$reclaim_lock/stale" ||
                fail "Cannot clean stale install lock at $reclaim_lock."
        fi
        mkdir "$install_lock" 2>/dev/null ||
            fail "Install lock is in use at $install_lock."
    fi
    lock_owned=1
    printf '%s\n' "$$" > "$install_lock/pid" ||
        fail "Cannot write the owner of $install_lock."
    if [ "$reclaim_owned" = 1 ]; then
        rmdir "$reclaim_lock" || fail "Cannot release $reclaim_lock."
        reclaim_owned=0
    fi
}

cleanup_on_exit() {
    if [ -n "$download_dir" ]; then rm -rf "$download_dir" || :; fi
    if [ -n "$launcher_temp" ]; then rm -f "$launcher_temp" || :; fi
    if [ "$lock_owned" = 1 ]; then
        if [ -n "$current_temp" ]; then rm -f "$current_temp" || :; fi
        rm -f "$install_lock/pid" || :
        rmdir "$install_lock" || warn "Cannot release $install_lock."
    fi
    if [ "$reclaim_owned" = 1 ]; then
        rmdir "$reclaim_lock" || warn "Cannot release $reclaim_lock."
    fi
}

download() {
    curl -fsSL --connect-timeout 15 "$1" -o "$2" ||
        fail "Download failed: $1. Check your proxy or set OHBABY_NODE_MIRROR."
}

file_sha256() (
    if command -v sha256sum >/dev/null 2>&1; then
        result=$(sha256sum < "$1") || exit 1
    elif command -v shasum >/dev/null 2>&1; then
        result=$(shasum -a 256 < "$1") || exit 1
    else
        warn "A SHA-256 utility (sha256sum or shasum) is required."
        exit 1
    fi
    printf '%s\n' "${result%% *}"
)

prepare_node() {
    if [ ! -e "$node_dir" ]; then
        node_archive="node-v$NODE_VERSION-$os-$arch.tar.gz"
        if command -v xz >/dev/null 2>&1; then node_archive="${node_archive%.gz}.xz"; fi
        node_url="${OHBABY_NODE_MIRROR:-https://nodejs.org/dist}"
        node_url="${node_url%/}/v$NODE_VERSION"
        download_dir=$(mktemp -d "$runtime_dir/.download-XXXXXXXX")
        download "$node_url/$node_archive" "$download_dir/$node_archive"
        download "$node_url/SHASUMS256.txt" "$download_dir/SHASUMS256.txt"
        expected=$(awk -v name="$node_archive" '$2 == name {print $1}' "$download_dir/SHASUMS256.txt")
        actual=$(file_sha256 "$download_dir/$node_archive") ||
            fail "Cannot compute SHA-256 for $node_archive."
        [ -n "$expected" ] && [ "$actual" = "$expected" ] ||
            fail "SHA-256 verification failed for $node_archive."
        node_partial="$runtime_dir/.node-v$NODE_VERSION.partial"
        rm -rf "$node_partial"
        mkdir "$node_partial"
        tar -xf "$download_dir/$node_archive" -C "$node_partial" --strip-components=1 ||
            fail "Cannot extract $node_archive."
        verify_node "$node_partial"
        mv "$node_partial" "$node_dir"
    else
        verify_node "$node_dir"
    fi
}

verify_node() {
    installed_node=$("$1/bin/node" --version) &&
        [ "$installed_node" = "v$NODE_VERSION" ] ||
        fail "Node.js $NODE_VERSION could not run at $1. Check whether this system supports it."
}

run_private_npm() (
    cd "$install_dir"
    PATH="$node_dir/bin:$PATH" "$node_dir/bin/node" "$node_dir/lib/node_modules/npm/bin/npm-cli.js" "$@"
)

release_works() (
    rel_dir=$1
    rel_node_version=$(cat "$rel_dir/node-version" 2>/dev/null) || exit 1
    version_is_safe "$rel_node_version" || exit 1
    rel_node="$runtime_dir/node-v$rel_node_version/bin/node"
    rel_output=$("$rel_node" "$rel_dir/node_modules/ohbaby-cli/dist/bin.js" --version) && [ "$rel_output" = "$version" ]
)

prepare_release() {
    release="$releases_dir/$version"
    if [ -e "$release" ] || [ -L "$release" ]; then
        release_works "$release" ||
            fail "Existing release at $release did not pass the version check. Repair that directory before retrying."
        return
    fi
    partial="$release.partial"
    rm -rf "$partial"
    mkdir "$partial"
    run_private_npm install --prefix "$partial" --global=false --ignore-scripts --omit=dev --include=optional \
        --no-audit --no-fund "ohbaby-cli@$version" ||
        fail "Could not install ohbaby-cli@$version."
    printf '%s\n' "$NODE_VERSION" > "$partial/node-version"
    release_works "$partial" || fail "The installed ohbaby-cli@$version did not pass the version check."
    mv "$partial" "$release"
}

# npm uses a direct symlink to dist/bin.js. Resolve its directory so nvm and
# Homebrew prefixes are taken from the package that owns the visible command.
npm_prefix_for() (
    candidate=$1
    [ -L "$candidate" ] || exit 1
    target=$(readlink "$candidate") || exit 1
    case "$target" in /*) ;; *) target="$(dirname "$candidate")/$target" ;; esac
    target_dir=$(CDPATH='' cd -P "$(dirname "$target")" 2>/dev/null && pwd -P) || exit 1
    [ -f "$target_dir/$(basename "$target")" ] || exit 1
    case "$target_dir/$(basename "$target")" in
        */lib/node_modules/ohbaby-cli/dist/bin.js)
            printf '%s\n' "${target_dir%/lib/node_modules/ohbaby-cli/dist}" ;;
        *) exit 1 ;;
    esac
)

launcher_marker() {
    [ -f "$launcher" ] && [ ! -L "$launcher" ] &&
        sed -n '2p' "$launcher" | LC_ALL=C grep -Eq '^# ohbaby-launcher [0-9]+$'
}

prepare_launcher() {
    # Octal escapes keep the launcher ASCII even for a Unicode install path.
    launcher_path_bytes=$(printf '%s' "$install_dir" | LC_ALL=C od -An -v -t o1 |
        awk '{for (i = 1; i <= NF; i++) printf "\\0%s", $i}')
    launcher_assignment="OHBABY_INSTALL_DIR=\$(printf '%b' '$launcher_path_bytes')"
    if launcher_marker &&
        [ "$(sed -n '2p' "$launcher")" = '# ohbaby-launcher 1' ] &&
        [ "$(sed -n '3p' "$launcher")" = "$launcher_assignment" ]; then
        return
    fi
    if [ -e "$launcher" ] || [ -L "$launcher" ]; then
        launcher_marker || npm_prefix_for "$launcher" >/dev/null ||
            fail "Cannot replace the existing command at $launcher."
    fi
    mkdir -p "$launcher_dir"
    launcher_temp=$(mktemp "$launcher_dir/.ohbaby-XXXXXXXX")
    {
        printf '#!/bin/sh\n# ohbaby-launcher 1\n%s\n' "$launcher_assignment"
        cat <<'LAUNCHER'
export OHBABY_INSTALL_DIR
v=$(cat "$OHBABY_INSTALL_DIR/current") || exit 1
r="$OHBABY_INSTALL_DIR/releases/$v"
nn=$(cat "$r/node-version") || exit 1
d="$OHBABY_INSTALL_DIR/runtime/node-v$nn"
PATH="$PATH:$d/bin"
export PATH
exec "$d/bin/node" "$r/node_modules/ohbaby-cli/dist/bin.js" "$@"
LAUNCHER
    } > "$launcher_temp" || fail "Cannot prepare the launcher at $launcher."
    chmod 755 "$launcher_temp" || fail "Cannot make the launcher executable at $launcher."
}

publish_launcher() {
    if [ -n "$launcher_temp" ]; then
        mv -f "$launcher_temp" "$launcher" || return 1
        launcher_temp=
    fi
}

append_path_block() (
    rc_file=$1
    path_line=$2
    if [ -e "$rc_file" ] || [ -L "$rc_file" ]; then
        [ -f "$rc_file" ] && [ -r "$rc_file" ] || exit 1
        if grep -Fqx "$path_begin" "$rc_file"; then
            grep -Fqx "$path_end" "$rc_file"
            exit
        fi
    fi
    separator=
    if [ -s "$rc_file" ]; then separator='\n'; fi
    printf '%b%s\n%s\n%s\n' "$separator" "$path_begin" "$path_line" "$path_end" >> "$rc_file"
)

configure_path() {
    if [ "${OHBABY_NO_MODIFY_PATH:-}" = 1 ]; then return 0; fi
    case ":$PATH:" in
        *":$launcher_dir:"*|*":$launcher_dir/:"*) printf '%s is already in PATH.\n' "$launcher_dir"; return 0 ;;
    esac
    path_begin='# >>> ohbaby installer >>>'
    path_end='# <<< ohbaby installer <<<'
    # shellcheck disable=SC2016
    path_command='export PATH="$HOME/.local/bin:$PATH"'
    case "${shell_name##*/}" in
        zsh) append_path_block "$HOME/.zshrc" "$path_command" || return 1 ;;
        bash)
            append_path_block "$HOME/.bashrc" "$path_command" || return 1
            if [ "$os" = darwin ]; then
                append_path_block "$HOME/.bash_profile" "$path_command" || return 1
            fi ;;
        fish)
            mkdir -p "$HOME/.config/fish/conf.d" || return 1
            # shellcheck disable=SC2016
            append_path_block "$HOME/.config/fish/conf.d/ohbaby.fish" \
                'contains -- "$HOME/.local/bin" $PATH; or set -gx PATH "$HOME/.local/bin" $PATH' || return 1 ;;
        *)
            printf 'Add %s to PATH to use ohbaby by name.\n' "$launcher_dir"
            return 0 ;;
    esac
    printf 'Open a new terminal or source your shell configuration to load the updated PATH.\n'
}

remove_old_directory() (
    obsolete=$1
    trash="$(dirname "$obsolete")/.trash-$(basename "$obsolete")-$$"
    if [ -e "$trash" ] || [ -L "$trash" ] || ! mv "$obsolete" "$trash"; then
        warn "Could not rename $obsolete for cleanup. It can be removed later."
    elif ! rm -rf "$trash"; then
        warn "Could not remove $trash. It can be removed later."
    fi
)

clean_old_installations() {
    for trash in "$releases_dir"/.trash-* "$runtime_dir"/.trash-*; do
        if [ -e "$trash" ] || [ -L "$trash" ]; then
            rm -rf "$trash" || warn "Could not remove $trash. It can be removed later."
        fi
    done
    for old_release in "$releases_dir"/*; do
        [ -d "$old_release" ] || continue
        old_version=${old_release##*/}
        version_is_safe "${old_version%.partial}" || continue
        if [ "$old_version" != "$version" ] && [ "$old_version" != "$previous" ]; then
            remove_old_directory "$old_release"
        fi
    done

    current_runtime=$(cat "$release/node-version")
    previous_runtime=
    if [ -n "$previous" ]; then
        previous_runtime=$(cat "$releases_dir/$previous/node-version" 2>/dev/null) || return 0
        version_is_safe "$previous_runtime" || return 0
    fi
    for old_node in "$runtime_dir"/node-v*; do
        [ -d "$old_node" ] || continue
        old_runtime=${old_node##*/node-v}
        version_is_safe "$old_runtime" || continue
        if [ "$old_runtime" != "$current_runtime" ] && [ "$old_runtime" != "$previous_runtime" ]; then
            remove_old_directory "$old_node"
        fi
    done
}

offer_npm_removal() {
    [ -n "$npm_prefix" ] || return 0
    answer=
    if [ "${OHBABY_NON_INTERACTIVE:-}" != 1 ] && ( : </dev/tty ) 2>/dev/null; then
        printf 'Remove the npm installation at %s? [y/N] ' "$npm_prefix" >/dev/tty
        IFS= read -r answer </dev/tty || :
    fi
    case "$answer" in
        y|Y|yes|YES)
            check_daemon || { warn "The optional npm uninstall was skipped."; return 1; }
            npm="$npm_prefix/bin/npm"
            if [ ! -x "$npm" ]; then npm=npm; fi
            PATH="$npm_prefix/bin:$PATH" "$npm" uninstall -g --prefix "$npm_prefix" ohbaby-cli || return 1
            prepare_launcher
            publish_launcher || return 1
            ;;
        *)
            visible=$(command -v ohbaby || :)
            printf 'Kept the npm installation at %s. In the current PATH, ohbaby resolves to %s.\n' \
                "$npm_prefix" "${visible:-no command}"
            ;;
    esac
}

finish_install() {
    if [ "$previous" != "$version" ]; then
        printf 'Activated ohbaby %s at %s.\n' "$version" "$install_dir"
    else
        printf 'ohbaby %s is installed at %s.\n' "$version" "$install_dir"
    fi
    status=0
    if ! configure_path; then
        warn "ohbaby $version is active, but PATH setup failed. Fix your shell configuration and rerun the installer."
        status=1
    fi
    if [ "$previous" != "$version" ]; then clean_old_installations; fi
    if ! offer_npm_removal; then
        warn "ohbaby $version is active, but the optional npm uninstall did not complete."
        status=1
    fi
    printf 'Launcher: %s\n' "$launcher"
    if [ "$os" = linux ]; then
        printf 'For non-login SSH commands without the updated PATH, use the launcher path directly.\n'
    fi
    return "$status"
}

main() {
    set -eu
    umask 077
    NODE_VERSION=24.22.3
    ohbaby_home_arg=$(printf '%s\n' "${OHBABY_HOME:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    ohbaby_home=$(normalize_directory "${ohbaby_home_arg:-$HOME/.ohbaby}") ||
        fail "OHBABY_HOME must be an absolute directory path."
    install_dir=$(normalize_directory "${OHBABY_INSTALL_DIR:-$HOME/.ohbaby/install}") ||
        fail "OHBABY_INSTALL_DIR must be an absolute directory path."
    shell_name=${SHELL:-}

    select_platform
    check_daemon || exit 1
    requested=${OHBABY_INSTALL_VERSION:-latest}
    [ "$requested" = latest ] || version_is_safe "$requested" ||
        fail "OHBABY_INSTALL_VERSION must name a single version."

    launcher_dir="$HOME/.local/bin"
    launcher="$launcher_dir/ohbaby"
    existing=$(command -v ohbaby || :)
    npm_prefix=$(npm_prefix_for "$existing" || :)
    mkdir -p "$(dirname "$install_dir")"
    install_parent=$(CDPATH='' cd -P "$(dirname "$install_dir")" && pwd -P)
    install_dir="${install_parent%/}/$(basename "$install_dir")"
    if [ -d "$install_dir" ]; then
        install_dir=$(CDPATH='' cd -P "$install_dir" && pwd -P)
    fi
    user_home=$(CDPATH='' cd -P "$HOME" && pwd -P)
    if [ -d "$ohbaby_home" ]; then
        ohbaby_home=$(CDPATH='' cd -P "$ohbaby_home" && pwd -P)
    fi
    case "$install_dir" in /|"$user_home") fail "Choose a separate installation directory." ;; esac
    case "$ohbaby_home/" in
        "$install_dir/"*) fail "Choose an installation directory that does not contain OHBABY_HOME." ;;
    esac
    runtime_dir="$install_dir/runtime"
    releases_dir="$install_dir/releases"
    node_dir="$runtime_dir/node-v$NODE_VERSION"
    install_lock="$install_dir.lock"
    reclaim_lock="$install_lock.reclaim"
    current_temp=
    download_dir=
    launcher_temp=
    lock_owned=0
    reclaim_owned=0
    trap cleanup_on_exit 0
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    take_install_lock

    previous=
    if [ -e "$install_dir/current" ] || [ -L "$install_dir/current" ]; then
        if ! previous=$(cat "$install_dir/current") || ! version_is_safe "$previous"; then
            fail "Invalid current version pointer at $install_dir/current."
        fi
    fi
    mkdir -p "$runtime_dir" "$releases_dir"
    prepare_node
    if ! version=$(run_private_npm view "ohbaby-cli@$requested" version --json=false --color=false) || ! version_is_safe "$version"; then
        fail "The npm registry did not return ohbaby-cli@$requested. A mirror may not have synced the version yet. Retry later."
    fi
    prepare_release
    prepare_launcher

    if [ "$previous" != "$version" ]; then
        current_temp=$(mktemp "$install_dir/current.tmp.XXXXXXXX")
        printf '%s\n' "$version" > "$current_temp"
        check_daemon || exit 1
        mv -f "$current_temp" "$install_dir/current" ||
            fail "Could not activate ohbaby $version."
        current_temp=
    fi
    # Keep the old launcher usable until the target directory has a current version.
    publish_launcher ||
        fail "ohbaby $version is active at $install_dir, but the launcher could not be published. Rerun the installer."
    finish_install
}

main
