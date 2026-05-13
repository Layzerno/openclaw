#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'TXT'
用法：
  ./scripts/docker/run-instance.sh [参数...]

作用：
  在同一台宿主机上启动一个“新的 OpenClaw 实例”（第二套/第 N 套），并与已有实例隔离：
  - 通过 docker compose 的 Project Name（-p）隔离容器/网络
  - 通过不同的端口映射隔离访问入口
  - 通过不同的挂载目录隔离数据与配置（持久化）

参数说明：
  --project <name>
    docker compose Project 名称。不同实例必须不同。
    它会影响容器名/网络名/卷名前缀。相同 project 会被视为“同一套服务”而覆盖重建。

  --image <name[:tag]>
    要运行的镜像名。示例：openclaw:local、openclaw:myfork。
    该值会传给 docker-compose.yml 里的 ${OPENCLAW_IMAGE}。

  --config-dir <path>
    宿主机上的配置目录（持久化）。会挂载到容器内 /home/node/.openclaw。
    不同实例必须不同目录，否则会共用同一份 token/配置/身份数据。

  --workspace-dir <path>
    宿主机上的工作区目录（持久化）。会挂载到容器内 /home/node/.openclaw/workspace。
    不同实例建议不同目录，避免任务/文件互相影响。

  --gateway-port <port>
    宿主机端口 -> 容器 18789（Gateway）。默认建议用 18789 以外的新端口（例如 18791）。

  --bridge-port <port>
    宿主机端口 -> 容器 18790（Bridge）。默认建议用 18790 以外的新端口（例如 18792）。

  --bind <loopback|lan|...>
    网关绑定方式（传给 openclaw gateway --bind）。常见：
    - loopback：只允许本机访问
    - lan：允许局域网访问（注意 Control UI 需要配置 allowedOrigins）

  --token <hex>
    指定实例的 gateway token（用于鉴权/控制台）。
    如果不提供，将自动生成并写入 <config-dir>/openclaw.json，同时也作为容器环境变量传入。

  --allowed-origins <csv>
    Control UI 允许的来源列表（逗号分隔）。
    示例：'http://127.0.0.1:18791,http://192.168.1.10:18791'
    如果 --bind 不是 loopback 且你不提供该参数，脚本会默认设置为：
      http://127.0.0.1:<gateway-port>

  --home-volume <name-or-path>
    可选：为容器 /home/node 额外挂载一个卷/目录（持久化 home 目录）。
    - 传 name（不含 /）视为“命名卷”，例如 openclaw2-home
    - 传 path（包含 /）视为宿主机路径，例如 /data/openclaw2/home
    启用该参数时，脚本会生成并使用一个 overlay compose 文件：
      docker-compose.<project>.extra.yml

  --extra-mounts <csv>
    可选：额外挂载（逗号分隔），每项格式：source:target[:options]
    示例：'/data/shared:/mnt/shared:ro'
    启用该参数时也会生成 docker-compose.<project>.extra.yml。

示例（启动第二个实例）：
  ./scripts/docker/run-instance.sh \
    --project openclaw2 \
    --image openclaw:myfork \
    --config-dir /data/openclaw2/config \
    --workspace-dir /data/openclaw2/workspace \
    --gateway-port 18791 \
    --bridge-port 18792 \
    --bind lan \
    --allowed-origins 'http://127.0.0.1:18791,http://192.168.1.10:18791'
TXT
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing dependency: $1"
  fi
}

contains_disallowed_chars() {
  local value="$1"
  [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *$'\t'* ]]
}

validate_mount_path_value() {
  local label="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    fail "$label cannot be empty."
  fi
  if contains_disallowed_chars "$value"; then
    fail "$label contains unsupported control characters."
  fi
  if [[ "$value" =~ [[:space:]] ]]; then
    fail "$label cannot contain whitespace."
  fi
}

validate_named_volume() {
  local value="$1"
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    fail "Named volume must match [A-Za-z0-9][A-Za-z0-9_.-]*."
  fi
}

validate_mount_spec() {
  local mount="$1"
  if contains_disallowed_chars "$mount"; then
    fail "extra mount entries cannot contain control characters."
  fi
  if [[ ! "$mount" =~ ^[^[:space:],:]+:[^[:space:],:]+(:[^[:space:],:]+)?$ ]]; then
    fail "Invalid mount format '$mount'. Expected source:target[:options] without spaces."
  fi
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return 0
  fi
  fail "Cannot generate token (need openssl or python3). Provide --token manually."
}

write_openclaw_json() {
  local config_dir="$1"
  local token="$2"
  local bind="$3"
  local allowed_origins_csv="$4"

  require_cmd python3

  python3 - "$config_dir" "$token" "$bind" "$allowed_origins_csv" <<'PY'
import json
import os
import sys

config_dir, token, bind, allowed_csv = sys.argv[1:5]
path = os.path.join(config_dir, "openclaw.json")

cfg = {}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f) or {}
    except Exception:
        cfg = {}

gateway = cfg.get("gateway")
if not isinstance(gateway, dict):
    gateway = {}
cfg["gateway"] = gateway

auth = gateway.get("auth")
if not isinstance(auth, dict):
    auth = {}
gateway["auth"] = auth
auth["token"] = token

gateway["mode"] = "local"
gateway["bind"] = bind

if bind != "loopback":
    allowed = []
    if allowed_csv.strip():
        allowed = [x.strip() for x in allowed_csv.split(",") if x.strip()]
    if allowed:
        control = gateway.get("controlUi")
        if not isinstance(control, dict):
            control = {}
        gateway["controlUi"] = control
        control["allowedOrigins"] = allowed

os.makedirs(config_dir, exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

write_extra_compose() {
  local project="$1"
  local extra_file="$2"
  local home_volume="$3"
  local mounts_csv="$4"
  local mount
  local gateway_home_mount
  local gateway_config_mount
  local gateway_workspace_mount

  cat >"$extra_file" <<'YAML'
services:
  openclaw-gateway:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    gateway_home_mount="${home_volume}:/home/node"
    gateway_config_mount="${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw"
    gateway_workspace_mount="${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace"

    validate_mount_spec "$gateway_home_mount"
    validate_mount_spec "$gateway_config_mount"
    validate_mount_spec "$gateway_workspace_mount"

    printf '      - %s\n' "$gateway_home_mount" >>"$extra_file"
    printf '      - %s\n' "$gateway_config_mount" >>"$extra_file"
    printf '      - %s\n' "$gateway_workspace_mount" >>"$extra_file"
  fi

  if [[ -n "$mounts_csv" ]]; then
    IFS=',' read -r -a mounts <<<"$mounts_csv"
    for mount in "${mounts[@]}"; do
      mount="${mount#"${mount%%[![:space:]]*}"}"
      mount="${mount%"${mount##*[![:space:]]}"}"
      [[ -z "$mount" ]] && continue
      validate_mount_spec "$mount"
      printf '      - %s\n' "$mount" >>"$extra_file"
    done
  fi

  cat >>"$extra_file" <<'YAML'
  openclaw-cli:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s\n' "$gateway_home_mount" >>"$extra_file"
    printf '      - %s\n' "$gateway_config_mount" >>"$extra_file"
    printf '      - %s\n' "$gateway_workspace_mount" >>"$extra_file"
  fi

  if [[ -n "$mounts_csv" ]]; then
    IFS=',' read -r -a mounts <<<"$mounts_csv"
    for mount in "${mounts[@]}"; do
      mount="${mount#"${mount%%[![:space:]]*}"}"
      mount="${mount%"${mount##*[![:space:]]}"}"
      [[ -z "$mount" ]] && continue
      validate_mount_spec "$mount"
      printf '      - %s\n' "$mount" >>"$extra_file"
    done
  fi

  if [[ -n "$home_volume" && "$home_volume" != *"/"* ]]; then
    validate_named_volume "$home_volume"
    cat >>"$extra_file" <<YAML
volumes:
  ${home_volume}:
YAML
  fi
}

PROJECT=""
IMAGE=""
CONFIG_DIR=""
WORKSPACE_DIR=""
GATEWAY_PORT=""
BRIDGE_PORT=""
BIND=""
TOKEN=""
ALLOWED_ORIGINS=""
HOME_VOLUME=""
EXTRA_MOUNTS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --project)
      PROJECT="${2:-}"; shift 2 ;;
    --image)
      IMAGE="${2:-}"; shift 2 ;;
    --config-dir)
      CONFIG_DIR="${2:-}"; shift 2 ;;
    --workspace-dir)
      WORKSPACE_DIR="${2:-}"; shift 2 ;;
    --gateway-port)
      GATEWAY_PORT="${2:-}"; shift 2 ;;
    --bridge-port)
      BRIDGE_PORT="${2:-}"; shift 2 ;;
    --bind)
      BIND="${2:-}"; shift 2 ;;
    --token)
      TOKEN="${2:-}"; shift 2 ;;
    --allowed-origins)
      ALLOWED_ORIGINS="${2:-}"; shift 2 ;;
    --home-volume)
      HOME_VOLUME="${2:-}"; shift 2 ;;
    --extra-mounts)
      EXTRA_MOUNTS="${2:-}"; shift 2 ;;
    *)
      fail "Unknown argument: $1 (use --help)"
      ;;
  esac
done

[[ -f "$COMPOSE_FILE" ]] || fail "docker-compose.yml not found at $COMPOSE_FILE"
require_cmd docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose not available (try: docker compose version)"

[[ -n "$PROJECT" ]] || fail "--project is required"
[[ -n "$IMAGE" ]] || fail "--image is required"
[[ -n "$CONFIG_DIR" ]] || fail "--config-dir is required"
[[ -n "$WORKSPACE_DIR" ]] || fail "--workspace-dir is required"
[[ -n "$GATEWAY_PORT" ]] || fail "--gateway-port is required"
[[ -n "$BRIDGE_PORT" ]] || fail "--bridge-port is required"
[[ -n "$BIND" ]] || fail "--bind is required"

validate_mount_path_value "--config-dir" "$CONFIG_DIR"
validate_mount_path_value "--workspace-dir" "$WORKSPACE_DIR"
if [[ -n "$HOME_VOLUME" ]]; then
  if [[ "$HOME_VOLUME" == *"/"* ]]; then
    validate_mount_path_value "--home-volume" "$HOME_VOLUME"
  else
    validate_named_volume "$HOME_VOLUME"
  fi
fi
if [[ -n "$EXTRA_MOUNTS" ]] && contains_disallowed_chars "$EXTRA_MOUNTS"; then
  fail "--extra-mounts contains unsupported control characters."
fi

if [[ -z "$TOKEN" ]]; then
  TOKEN="$(generate_token)"
fi

if [[ -z "$ALLOWED_ORIGINS" && "$BIND" != "loopback" ]]; then
  ALLOWED_ORIGINS="http://127.0.0.1:${GATEWAY_PORT}"
fi

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR"
mkdir -p "$CONFIG_DIR/identity" "$CONFIG_DIR/agents/main/agent" "$CONFIG_DIR/agents/main/sessions"

write_openclaw_json "$CONFIG_DIR" "$TOKEN" "$BIND" "$ALLOWED_ORIGINS"

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
EXTRA_FILE=""
if [[ -n "$HOME_VOLUME" || -n "$EXTRA_MOUNTS" ]]; then
  EXTRA_FILE="$ROOT_DIR/docker-compose.${PROJECT}.extra.yml"
  OPENCLAW_CONFIG_DIR="$CONFIG_DIR"
  OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR"
  write_extra_compose "$PROJECT" "$EXTRA_FILE" "$HOME_VOLUME" "$EXTRA_MOUNTS"
  COMPOSE_ARGS+=(-f "$EXTRA_FILE")
fi

echo "==> Starting instance: $PROJECT"
OPENCLAW_IMAGE="$IMAGE" \
OPENCLAW_CONFIG_DIR="$CONFIG_DIR" \
OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR" \
OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT" \
OPENCLAW_BRIDGE_PORT="$BRIDGE_PORT" \
OPENCLAW_GATEWAY_BIND="$BIND" \
OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
docker compose -p "$PROJECT" "${COMPOSE_ARGS[@]}" up -d openclaw-gateway

echo "==> Fixing data-directory permissions"
OPENCLAW_IMAGE="$IMAGE" \
OPENCLAW_CONFIG_DIR="$CONFIG_DIR" \
OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR" \
OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT" \
OPENCLAW_BRIDGE_PORT="$BRIDGE_PORT" \
OPENCLAW_GATEWAY_BIND="$BIND" \
OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
docker compose -p "$PROJECT" "${COMPOSE_ARGS[@]}" run --rm --user root --entrypoint sh openclaw-cli -c \
  'find /home/node/.openclaw -xdev -exec chown node:node {} +; \
   [ -d /home/node/.openclaw/workspace/.openclaw ] && chown -R node:node /home/node/.openclaw/workspace/.openclaw || true'

echo ""
echo "Instance started."
echo "Project: $PROJECT"
echo "Image: $IMAGE"
echo "Bind: $BIND"
echo "Host gateway port: $GATEWAY_PORT"
echo "Host bridge port: $BRIDGE_PORT"
echo "Config dir: $CONFIG_DIR"
echo "Workspace dir: $WORKSPACE_DIR"
echo "Token: $TOKEN"
echo ""
echo "Logs:"
echo "  docker compose -p $PROJECT ${COMPOSE_ARGS[*]} logs -f openclaw-gateway"
