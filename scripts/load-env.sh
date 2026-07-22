#!/usr/bin/env bash

rp_agent_env_file="${RP_AGENT_ENV_FILE:-.env}"

load_env_value() {
  local name="$1"
  local line value

  if [ -n "${!name:-}" ] || [ ! -f "$rp_agent_env_file" ]; then
    return
  fi

  line="$(grep -m 1 -E "^${name}=" "$rp_agent_env_file" || true)"
  if [ -z "$line" ]; then
    return
  fi

  value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  export "$name=$value"
}

load_env_value OPENVIKING_URL
load_env_value OPENVIKING_API_KEY
load_env_value OPENVIKING_ACCOUNT
