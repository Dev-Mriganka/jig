#!/usr/bin/env bash
# Makes what compose.yml mounts and needs: a key file for the MongoDB replica set, an SSH key for the jump host, and the jump host's
# settings. Usage: prepare.sh <folder> [shell]. It prints the variables the services need, one per line, as `NAME=value`: the
# workflow appends that to $GITHUB_ENV. With `shell` it prints `export NAME='value'` instead, so that on your machine
# `eval "$(.github/integration/prepare.sh /tmp/jigit shell)"` sets them.
set -euo pipefail

folder=${1:?usage: prepare.sh <folder> [shell]}
form=${2:-github}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

mkdir -p "$folder"
folder=$(cd "$folder" && pwd)

openssl rand -base64 756 > "$folder/mongo-keyfile"
rm -f "$folder/jump_key" "$folder/jump_key.pub"
ssh-keygen -q -t ed25519 -N "" -C jig-it -f "$folder/jump_key"
rm -rf "$folder/sshd_config.d"
cp -r "$here/sshd_config.d" "$folder/sshd_config.d"

public_key=$(cat "$folder/jump_key.pub")
if [ "$form" = shell ]; then
    echo "export JIG_IT_TEMP='$folder'"
    echo "export JIG_IT_SSH_PUBLIC_KEY='$public_key'"
else
    echo "JIG_IT_TEMP=$folder"
    echo "JIG_IT_SSH_PUBLIC_KEY=$public_key"
fi
