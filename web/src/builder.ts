/* devbox-manager: mgmt · MCL recipe manager
 * Copyright (C) 2026  Andrei
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Builder model: parse MCL source into draggable blocks and emit it back.
// Anything the parser does not recognize is preserved verbatim as a raw node,
// so Builder never destroys hand-written or AI-pasted MCL.

export type BlockKind = 'pkg' | 'file' | 'svc' | 'exec' | 'cron' | 'noop' | 'print'

export type FieldType = 'text' | 'textarea' | 'select' | 'int'

export type FieldSpec = {
  key: string
  label: string
  type: FieldType
  options?: string[]
  placeholder?: string
  default?: string
  rows?: number
}

export type KindSpec = {
  kind: BlockKind
  label: string
  color: string
  icon: string
  titleLabel: string
  titlePlaceholder: string
  hint: string
  requiredFields: string[]
  fields: FieldSpec[]
}

export type BlockNode = { uid: string; type: 'block'; kind: BlockKind; title: string; fields: Record<string, string> }
export type RawNode = { uid: string; type: 'raw'; source: string }
export type BuilderNode = BlockNode | RawNode

export const KIND_SPECS: Record<BlockKind, KindSpec> = {
  pkg: {
    kind: 'pkg',
    label: 'Package',
    color: '#7ab8f5',
    icon: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
    titleLabel: 'Package name',
    titlePlaceholder: 'nginx',
    hint: 'Install or remove a system package',
    requiredFields: [],
    fields: [
      { key: 'state', label: 'State', type: 'select', options: ['installed', 'absent', 'latest'], default: 'installed' },
    ],
  },
  file: {
    kind: 'file',
    label: 'File',
    color: '#45d19b',
    icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    titleLabel: 'Path',
    titlePlaceholder: '/tmp/devbox-managed.txt',
    hint: 'Manage a file, its content and permissions',
    requiredFields: [],
    fields: [
      { key: 'content', label: 'Content', type: 'textarea', rows: 5, placeholder: 'Managed by Devbox Manager' },
      { key: 'state', label: 'State', type: 'select', options: ['exists', 'absent'], default: 'exists' },
      { key: 'mode', label: 'Mode', type: 'text', placeholder: '0644' },
    ],
  },
  svc: {
    kind: 'svc',
    label: 'Service',
    color: '#c39af5',
    icon: 'M22 12h-4l-3 9L9 3l-3 9H2',
    titleLabel: 'Unit name',
    titlePlaceholder: 'nginx.service',
    hint: 'Control a systemd unit',
    requiredFields: [],
    fields: [
      { key: 'state', label: 'State', type: 'select', options: ['running', 'stopped'], default: 'running' },
      { key: 'startup', label: 'At boot', type: 'select', options: ['enabled', 'disabled'], default: 'enabled' },
    ],
  },
  exec: {
    kind: 'exec',
    label: 'Command',
    color: '#e8b64c',
    icon: 'M4 17l6-5-6-5M12 19h8',
    titleLabel: 'Name',
    titlePlaceholder: 'reload-nginx',
    hint: 'Run a shell command',
    requiredFields: ['cmd'],
    fields: [
      { key: 'cmd', label: 'Command', type: 'text', placeholder: 'systemctl reload nginx' },
      { key: 'shell', label: 'Shell', type: 'text', placeholder: '/bin/sh (default)' },
      { key: 'timeout', label: 'Timeout (seconds)', type: 'int', placeholder: '30' },
      { key: 'creates', label: 'Skips if path exists', type: 'text', placeholder: '/var/lib/app/.done' },
    ],
  },
  cron: {
    kind: 'cron',
    label: 'Timer',
    color: '#f2a679',
    icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    titleLabel: 'Timer name',
    titlePlaceholder: 'nightly-backup',
    hint: 'systemd timer that triggers a unit',
    requiredFields: ['time'],
    fields: [
      { key: 'trigger', label: 'Trigger', type: 'select', options: ['OnCalendar', 'OnActiveSec', 'OnBootSec', 'OnStartupSec', 'OnUnitActiveSec', 'OnUnitInactiveSec'], default: 'OnCalendar' },
      { key: 'time', label: 'Time', type: 'text', placeholder: 'Mon..Sun 03:00  ·  or  10min' },
      { key: 'unit', label: 'Target unit', type: 'text', placeholder: 'defaults to <name>.service' },
      { key: 'state', label: 'State', type: 'select', options: ['exists', 'absent'], default: 'exists' },
    ],
  },
  noop: {
    kind: 'noop',
    label: 'Noop',
    color: '#9caaba',
    icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    titleLabel: 'Name',
    titlePlaceholder: 'marker',
    hint: 'Does nothing — grouping or testing marker',
    requiredFields: [],
    fields: [],
  },
  print: {
    kind: 'print',
    label: 'Print',
    color: '#6fd3cf',
    icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    titleLabel: 'Label',
    titlePlaceholder: 'hello',
    hint: 'Log a message during the run',
    requiredFields: ['msg'],
    fields: [
      { key: 'msg', label: 'Message', type: 'textarea', rows: 3, placeholder: 'Provisioning done' },
    ],
  },
}

export const PALETTE: BlockKind[] = ['pkg', 'file', 'svc', 'exec', 'cron', 'print', 'noop']

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

export function newBlock(kind: BlockKind): BlockNode {
  const fields: Record<string, string> = {}
  for (const f of KIND_SPECS[kind].fields) if (f.default !== undefined) fields[f.key] = f.default
  return { uid: uid(), type: 'block', kind, title: '', fields }
}

export function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
}

export function unescapeStr(s: string): string | null {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      continue
    }
    i++
    if (i >= s.length) return null
    const e = s[i]
    if (e === 'n') out += '\n'
    else if (e === 't') out += '\t'
    else if (e === 'r') out += '\r'
    else if (e === '"') out += '"'
    else if (e === '\\') out += '\\'
    else return null
  }
  return out
}

type ScannedField = { key: string; vtype: 'str' | 'int' | 'bool'; value: string }

// scanFields parses the inside of one resource block: a series of
// `key => "value",` entries with string, int or bool literals. Anything more
// exotic (expressions, variables, function calls) returns null so the caller
// can fall back to preserving the original source.
function scanFields(src: string): ScannedField[] | null {
  let i = 0
  const out: ScannedField[] = []
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++
  }
  for (;;) {
    ws()
    if (i >= src.length) return out
    const keyMatch = /^[a-z][a-z0-9_]*/.exec(src.slice(i))
    if (!keyMatch) return null
    const key = keyMatch[0]
    i += key.length
    ws()
    if (!src.startsWith('=>', i)) return null
    i += 2
    ws()
    const c = src[i]
    if (c === '"') {
      i++
      let raw = ''
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\n') return null
        if (src[i] === '\\') {
          raw += src[i] + (i + 1 < src.length ? src[i + 1] : '')
          i += 2
        } else {
          raw += src[i]
          i++
        }
      }
      if (i >= src.length) return null
      i++
      const value = unescapeStr(raw)
      if (value === null) return null
      out.push({ key, vtype: 'str', value })
    } else if (src.startsWith('true', i) && !/^\w/.test(src.slice(i + 4, i + 5))) {
      out.push({ key, vtype: 'bool', value: 'true' })
      i += 4
    } else if (src.startsWith('false', i) && !/^\w/.test(src.slice(i + 5, i + 6))) {
      out.push({ key, vtype: 'bool', value: 'false' })
      i += 5
    } else {
      const numMatch = /^-?\d+/.exec(src.slice(i))
      if (!numMatch) return null
      out.push({ key, vtype: 'int', value: numMatch[0] })
      i += numMatch[0].length
    }
    ws()
    if (i < src.length) {
      if (src[i] !== ',') return null
      i++
    }
  }
}

const BLOCK_INLINE = /^\s*(pkg|file|svc|exec|cron|noop|print)\s+"((?:\\.|[^"\\])*)"\s*\{\s*\}\s*$/
const BLOCK_OPEN = /^\s*(pkg|file|svc|exec|cron|noop|print)\s+"((?:\\.|[^"\\])*)"\s*\{\s*$/
const BLOCK_CLOSE = /^\s*\}\s*$/

function fieldsToNode(kind: BlockKind, title: string, scanned: ScannedField[]): BlockNode | null {
  const spec = KIND_SPECS[kind]
  const fields: Record<string, string> = {}
  for (const entry of scanned) {
    const fs = spec.fields.find(f => f.key === entry.key)
    if (!fs) return null
    if (entry.vtype === 'bool') return null
    if (fs.type === 'int') {
      if (entry.vtype !== 'int') return null
    } else {
      if (entry.vtype !== 'str') return null
      if (fs.type === 'select' && fs.options && !fs.options.includes(entry.value)) return null
    }
    fields[entry.key] = entry.value
  }
  for (const f of spec.fields) if (fields[f.key] === undefined && f.default !== undefined) fields[f.key] = f.default
  return { uid: uid(), type: 'block', kind, title, fields }
}

export function parseMcl(content: string): BuilderNode[] {
  const lines = content.split('\n')
  const nodes: BuilderNode[] = []
  let raw: string[] = []
  const flush = () => {
    const text = raw.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '')
    if (text.trim() !== '') nodes.push({ uid: uid(), type: 'raw', source: text })
    raw = []
  }
  let i = 0
  let rawDepth = 0
  while (i < lines.length) {
    const line = lines[i]
    // Inside raw brace-nested regions (if/while/etc.) force every line raw,
    // even if it looks like a known resource header.
    if (rawDepth > 0) {
      if (/^\s*\}/.test(line)) rawDepth--
      else if (/\{\s*$/.test(line)) rawDepth++
      raw.push(line)
      i++
      continue
    }
    const inline = BLOCK_INLINE.exec(line)
    if (inline) {
      const kind = inline[1] as BlockKind
      const title = unescapeStr(inline[2])
      if (title !== null) {
        flush()
        nodes.push({ uid: uid(), type: 'block', kind, title, fields: defaultFields(kind) })
      } else raw.push(line)
      i++
      continue
    }
    const open = BLOCK_OPEN.exec(line)
    if (open) {
      // Find the matching closing brace by depth so blocks nested inside the
      // resource (if any) don't truncate the raw span when we reject the parse.
      let depth = 1
      let close = -1
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (/^\s*\}/.test(l)) {
          depth--
          if (depth === 0) {
            close = j
            break
          }
        } else if (/\{\s*$/.test(l)) {
          depth++
        }
      }
      if (close === -1) {
        raw.push(...lines.slice(i))
        i = lines.length
        break
      }
      const kind = open[1] as BlockKind
      const title = unescapeStr(open[2])
      const inner = lines.slice(i + 1, close).join('\n')
      const scanned = scanFields(inner)
      const node = title !== null && scanned !== null ? fieldsToNode(kind, title, scanned) : null
      if (node) {
        flush()
        nodes.push(node)
      } else {
        raw.push(...lines.slice(i, close + 1))
      }
      i = close + 1
      continue
    }
    raw.push(line)
    if (/\{\s*$/.test(line)) rawDepth++
    i++
  }
  flush()
  return nodes
}

function defaultFields(kind: BlockKind): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const f of KIND_SPECS[kind].fields) if (f.default !== undefined) fields[f.key] = f.default
  return fields
}

export function emitMcl(nodes: BuilderNode[]): string {
  const chunks = nodes
    .map(n => {
      if (n.type === 'raw') return n.source
      const spec = KIND_SPECS[n.kind]
      const fieldLines: string[] = []
      for (const f of spec.fields) {
        const v = n.fields[f.key]
        if (v === undefined || v === '') continue
        const value = f.type === 'int' && /^-?\d+$/.test(v.trim()) ? v.trim() : `"${escapeStr(v)}"`
        fieldLines.push(`\t${f.key} => ${value},`)
      }
      if (fieldLines.length === 0) return `${n.kind} "${escapeStr(n.title)}" {}`
      return `${n.kind} "${escapeStr(n.title)}" {\n${fieldLines.join('\n')}\n}`
    })
    .filter(c => c.trim() !== '')
  const out = chunks.join('\n\n')
  return out === '' ? '' : out + '\n'
}

const preview = (v: string, max: number) => (v.length > max ? v.slice(0, max - 1) + '…' : v)

// summarize produces the one-line subtitle shown on a canvas card.
export function summarize(n: BuilderNode): string {
  if (n.type === 'raw') {
    const line = n.source.split('\n').find(l => l.trim()) ?? ''
    return preview(line.trim(), 64)
  }
  const spec = KIND_SPECS[n.kind]
  const bits = spec.fields
    .filter(f => n.fields[f.key])
    .slice(0, 2)
    .map(f => `${f.key}: ${preview(n.fields[f.key], 22)}`)
  return bits.join('  ·  ') || spec.hint
}

// blockIssues lists missing essentials for a block card warning chip.
export function blockIssues(n: BuilderNode): string[] {
  if (n.type === 'raw') return []
  const out: string[] = []
  if (!n.title.trim()) out.push(`no ${KIND_SPECS[n.kind].titleLabel.toLowerCase()}`)
  for (const key of KIND_SPECS[n.kind].requiredFields) if (!n.fields[key]?.trim()) out.push(`no ${key}`)
  return out
}
