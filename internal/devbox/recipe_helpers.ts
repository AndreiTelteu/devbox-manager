// devbox-manager: Bun shell recipe manager
// Copyright (C) 2026  Andrei
//
// SPDX-License-Identifier: MIT

import { $ as devbox$ } from "bun"

const devboxNixModule = "/etc/nixos/devbox-manager.nix"
const devboxNixConfig = "/etc/nixos/configuration.nix"

async function devboxSudoWrite(path: string, content: string) {
  const tmp = `/tmp/devbox-manager-write-${process.pid}.tmp`
  await Bun.write(tmp, content)
  try {
    await devbox$`sudo cp ${tmp} ${path}`
  } finally {
    await devbox$`rm -f ${tmp}`.nothrow().quiet()
  }
}

async function devboxSudoRead(path: string): Promise<string | null> {
  const result = await devbox$`sudo cat ${path}`.nothrow().quiet()
  return result.exitCode === 0 ? result.text() : null
}

function devboxModulePorts(module: string): number[] {
  const match = module.match(/networking\.firewall\.allowedTCPPorts\s*=\s*\[\s*([^\]]*)\]/)
  if (!match) return []
  return (match[1].match(/\d+/g) ?? []).map(Number)
}

function devboxNixModuleContent(ports: number[]): string {
  const list = [...new Set(ports)].sort((a, b) => a - b)
  return `{ ... }:
{
  programs.nix-ld.enable = true;
  networking.firewall.allowedTCPPorts = [ ${list.join(" ")} ];
}
`
}

async function devboxEnsureNixPort(port: number) {
  const currentModule = await devboxSudoRead(devboxNixModule)
  const ports = currentModule ? devboxModulePorts(currentModule) : []
  if (!ports.includes(port)) ports.push(port)

  await devboxEnsureNixModule(devboxNixModule, devboxNixModuleContent(ports))
}

async function devboxEnsureNixModule(path: string, content: string) {
  let changed = false
  const currentModule = await devboxSudoRead(path)
  if (currentModule !== content) {
    await devboxSudoWrite(path, content)
    changed = true
  }

  const config = await devboxSudoRead(devboxNixConfig)
  if (config === null) throw new Error("cannot read /etc/nixos/configuration.nix")
  const module = `./${path.slice(path.lastIndexOf("/") + 1)}`
  if (!config.includes(module)) {
    const imports = config.indexOf("imports")
    const list = config.indexOf("[", imports)
    if (imports === -1 || list === -1) throw new Error("imports array not found in /etc/nixos/configuration.nix")
    const nextConfig = config.slice(0, list + 1) + `\n      ${module}` + config.slice(list + 1)
    await devboxSudoWrite(devboxNixConfig, nextConfig)
    changed = true
  }

  if (changed) await devbox$`sudo nixos-rebuild switch`
}

async function devboxEnsureNode24() {
  const nodeOk = await devbox$`test "$(node --version | cut -d. -f1)" = v24 && command -v npx && command -v python3 && command -v make && command -v gcc`.nothrow().quiet()
  if (nodeOk.exitCode !== 0) {
    await devbox$`nix --extra-experimental-features 'nix-command flakes' profile install nixpkgs#nodejs_24 nixpkgs#python3 nixpkgs#gnumake nixpkgs#gcc`
  }
  await devbox$`test "$(node --version | cut -d. -f1)" = v24 && npx --version`
}
